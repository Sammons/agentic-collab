/**
 * HTTP API routes for the orchestrator.
 * Uses URLPattern for routing. No frameworks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.ts';
import type { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentState, EngineType, ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { sanitizeMessage, generateMessageId } from '../shared/sanitize.ts';
import type { LockManager } from '../shared/lock.ts';
import { getPersonasDir, parseFrontmatter, createPersonaAndAgent, syncSinglePersona } from './persona.ts';
import {
  spawnAgent, resumeAgent, suspendAgent, destroyAgent,
  reloadAgent, interruptAgent, compactAgent, killAgent,
  type LifecycleContext,
} from './lifecycle.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { UsagePoller } from './usage-poller.ts';

/**
 * Shared context injected into all route handlers.
 *
 * - db: SQLite persistence (agents, events, messages, proxies)
 * - wss: WebSocket server for real-time dashboard updates
 * - locks: Per-agent SQLite locks for lifecycle serialization
 * - proxyDispatch: Sends commands to tmux proxies (with retry)
 * - getDashboardHtml: Lazy-loaded dashboard HTML (cached after first read)
 * - orchestratorHost: Public URL for system prompts and inter-agent messaging
 * - orchestratorSecret: Shared secret for POST/DELETE auth (null = no auth)
 *
 * Lifecycle operations use makeLifecycleCtx() to extract the subset they need.
 */
export type RouteContext = {
  db: Database;
  wss: WebSocketServer;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  getDashboardHtml: () => string;
  orchestratorHost: string;
  orchestratorSecret: string | null;
  messageDispatcher: MessageDispatcher;
  usagePoller: UsagePoller;
};

/**
 * Resolve the proxy ID for an agent at spawn/resume time.
 * Priority: explicit body value > agent's existing proxyId > proxyHost match > any available proxy.
 */
function resolveProxyId(ctx: RouteContext, agent: { proxyId: string | null; proxyHost: string | null }, bodyProxyId?: string): string {
  // 1. Explicit override from request body
  if (bodyProxyId) return bodyProxyId;

  // 2. Already assigned (e.g. from a previous spawn)
  if (agent.proxyId) return agent.proxyId;

  // 3. Match by proxyHost preference
  const proxies = ctx.db.listProxies();
  if (agent.proxyHost) {
    const match = proxies.find(p => p.proxyId === agent.proxyHost);
    if (match) return match.proxyId;
  }

  // 4. Fall back to any registered proxy
  if (proxies.length > 0) return proxies[0]!.proxyId;

  return '';
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, match: URLPatternResult, ctx: RouteContext) => Promise<void>;

type Route = {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler;
};

function buildRoutes(): Route[] {
  const routes: Route[] = [];
  const route = (method: string, pathname: string, handler: RouteHandler) => {
    routes.push({ method, pattern: new URLPattern({ pathname }), handler });
  };

// ── Dashboard ──

route('GET', '/dashboard', async (_req, res, _match, ctx) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(ctx.getDashboardHtml());
});

// ── Agent CRUD ──

route('GET', '/api/agents', async (_req, res, _match, ctx) => {
  const agents = ctx.db.listAgents();
  json(res, 200, agents);
});

route('GET', '/api/agents/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) return json(res, 404, { error: 'Agent not found' });
  json(res, 200, agent);
});

route('POST', '/api/agents', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.name || !body.engine || !body.cwd) {
    return json(res, 400, { error: 'name, engine, cwd required' });
  }

  const nameError = validateAgentName(body.name as string);
  if (nameError) return json(res, 400, { error: nameError });

  const VALID_ENGINES = new Set(['claude', 'codex', 'opencode']);
  if (!VALID_ENGINES.has(body.engine as string)) {
    return json(res, 400, { error: 'engine must be claude, codex, or opencode' });
  }

  const existing = ctx.db.getAgent(body.name);
  if (existing) return json(res, 409, { error: 'Agent already exists' });

  const agent = ctx.db.createAgent({
    name: body.name,
    engine: body.engine as EngineType,
    model: body.model,
    thinking: body.thinking,
    cwd: body.cwd,
    persona: body.persona,
    permissions: body.permissions,
    proxyId: body.proxyId,
    proxyHost: body.proxyHost,
  });

  ctx.db.logEvent(agent.name, 'created');
  broadcastAgentUpdate(ctx, agent.name);
  json(res, 201, agent);
});

route('DELETE', '/api/agents/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const deleted = ctx.db.deleteAgent(name);
  if (!deleted) return json(res, 404, { error: 'Agent not found' });
  ctx.db.logEvent(name, 'destroyed');
  json(res, 200, { ok: true });
});

// ── Agent Messaging ──

route('POST', '/api/agents/send', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.from || !body.to || !body.message) {
    return json(res, 400, { error: 'from, to, message required' });
  }

  const target = ctx.db.getAgent(body.to);
  if (!target) return json(res, 404, { error: `Target agent "${body.to}" not found` });

  const messageId = generateMessageId();
  const sanitized = sanitizeMessage(body.message);

  // Format envelope
  const topic = body.re ? ` (re: ${body.re})` : '';
  const envelope = `[from: ${body.from}, reply with /collaboration reply]:${topic} '${sanitized}'`;

  // Enqueue for async delivery
  const pending = ctx.db.enqueueMessage({
    sourceAgent: body.from as string,
    targetAgent: body.to as string,
    envelope,
  });

  // Log routing events
  ctx.db.logEvent(body.from as string, 'message_queued', messageId, { to: body.to, queueId: pending.id });
  ctx.db.logEvent(body.to as string, 'message_queued', messageId, { from: body.from, queueId: pending.id });

  // Broadcast queue update
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  // Event-driven delivery — attempt immediately, don't block response
  ctx.messageDispatcher.tryDeliver(body.to as string).catch((err) => {
    console.error(`[routes] Immediate delivery failed for ${body.to}:`, (err as Error).message);
  });

  json(res, 202, { ok: true, messageId, queueId: pending.id, status: 'pending' });
});

// ── Dashboard Messages ──

route('POST', '/api/dashboard/send', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agent || !body.message) {
    return json(res, 400, { error: 'agent, message required' });
  }

  const agent = ctx.db.getAgent(body.agent);
  if (!agent) return json(res, 404, { error: `Agent "${body.agent}" not found` });

  const sanitized = sanitizeMessage(body.message);

  // Format envelope
  const topic = body.topic ? ` (re: ${body.topic})` : '';
  const envelope = `[from: dashboard, reply with /collaboration reply]:${topic} '${sanitized}'`;

  // Store in dashboard messages
  const msg = ctx.db.addDashboardMessage(body.agent as string, 'to_agent', sanitized, body.topic as string | undefined);

  // Enqueue for async delivery
  const pending = ctx.db.enqueueMessage({
    sourceAgent: null, // dashboard
    targetAgent: body.agent as string,
    envelope,
  });

  // Link dashboard message to queue entry
  ctx.db.linkDashboardMessageToQueue(msg.id, pending.id);

  // Broadcast with linked queueId so dashboard can track delivery status
  const linkedMsg = { ...msg, queueId: pending.id, deliveryStatus: 'pending' };
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: linkedMsg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  // Event-driven delivery — attempt immediately, don't block response
  ctx.messageDispatcher.tryDeliver(body.agent as string).catch((err) => {
    console.error(`[routes] Immediate delivery failed for ${body.agent}:`, (err as Error).message);
  });

  json(res, 202, { ok: true, msg, queueId: pending.id, status: 'pending' });
});

route('POST', '/api/dashboard/upload', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agentName = url.searchParams.get('agent');
  const filename = url.searchParams.get('filename');

  if (!agentName || !filename) {
    return json(res, 400, { error: 'agent and filename query params required' });
  }

  // Defense-in-depth filename validation (proxy also validates)
  if (!filename || filename.includes('/') || filename.includes('\\') ||
      filename === '.' || filename === '..' ||
      filename.includes('\0') || filename.length > 255 ||
      /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..+)?$/i.test(filename)) {
    return json(res, 400, { error: 'Invalid filename' });
  }

  const agent = ctx.db.getAgent(agentName);
  if (!agent) return json(res, 404, { error: 'Agent not found' });
  if (!agent.proxyId) return json(res, 400, { error: 'Agent has no proxy' });

  const proxy = ctx.db.getProxy(agent.proxyId);
  if (!proxy) return json(res, 500, { error: 'Proxy not found' });

  // Stream file to proxy's /upload endpoint — no buffering
  const proxyUrl = new URL('/upload', `http://${proxy.host}`);
  proxyUrl.searchParams.set('cwd', agent.cwd);
  proxyUrl.searchParams.set('filename', filename);

  const proxyResult = await new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; data?: Record<string, unknown>; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proxyReq = httpRequest(proxyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-proxy-token': proxy.token,
        ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
      },
    }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk: Buffer) => { body += chunk; });
      proxyRes.on('error', (err: Error) => settle({ ok: false, error: err.message }));
      proxyRes.on('end', () => {
        try { settle(JSON.parse(body)); }
        catch { settle({ ok: false, error: 'Invalid proxy response' }); }
      });
    });

    proxyReq.on('error', (err: Error) => {
      if (!settled) req.destroy();
      settle({ ok: false, error: err.message });
    });

    // Stream with backpressure via pipeline — handles flow control and cleanup
    pipeline(req, proxyReq).catch((err) => {
      settle({ ok: false, error: (err as Error).message });
    });
  });

  if (!proxyResult.ok) {
    return json(res, 500, { error: proxyResult.error ?? 'File write failed' });
  }

  const writtenPath = (proxyResult.data?.path as string) ?? `${agent.cwd}/${filename}`;
  const fileSize = (proxyResult.data?.size as number) ?? 0;

  // Enqueue agent notification through existing pipeline
  const agentMessage = `I uploaded ${writtenPath}`;
  const envelope = `[from: dashboard, reply with /collaboration reply]: '${sanitizeMessage(agentMessage)}'`;
  const displayMessage = `Uploaded ${filename} (${formatBytes(fileSize)})`;

  const msg = ctx.db.addDashboardMessage(agentName, 'to_agent', displayMessage, 'file-upload');
  const pending = ctx.db.enqueueMessage({
    sourceAgent: null,
    targetAgent: agentName,
    envelope,
  });
  ctx.db.linkDashboardMessageToQueue(msg.id, pending.id);

  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  // Event-driven delivery — attempt immediately, don't block response
  ctx.messageDispatcher.tryDeliver(agentName).catch((err) => {
    console.error(`[routes] Immediate delivery failed for ${agentName}:`, (err as Error).message);
  });

  json(res, 202, { ok: true, msg, queueId: pending.id, path: writtenPath, size: fileSize });
});

route('POST', '/api/dashboard/reply', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agent || !body.message) {
    return json(res, 400, { error: 'agent, message required' });
  }

  const sanitized = sanitizeMessage(body.message);
  const msg = ctx.db.addDashboardMessage(body.agent, 'from_agent', sanitized, body.topic);

  // Broadcast to dashboard WebSocket
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));

  json(res, 200, { ok: true, msg });
});

route('GET', '/api/dashboard/threads', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  const threads = ctx.db.getDashboardThreads(agent);
  json(res, 200, threads);
});

route('DELETE', '/api/dashboard/messages/:agent', async (_req, res, match, ctx) => {
  const agentName = match.pathname.groups['agent']!;
  const agent = ctx.db.getAgent(agentName);
  if (!agent) return json(res, 404, { error: 'Agent not found' });

  ctx.db.clearDashboardMessages(agentName);
  ctx.db.clearPendingMessages(agentName);
  json(res, 200, { ok: true });
});

route('POST', '/api/dashboard/messages/:id/withdraw', async (_req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid message ID' });

  const msg = ctx.db.getDashboardMessageById(id);
  if (!msg) return json(res, 404, { error: 'Message not found' });
  if (msg.direction !== 'to_agent') return json(res, 400, { error: 'Can only withdraw outgoing messages' });
  if (msg.withdrawn) return json(res, 400, { error: 'Message already withdrawn' });

  // Cancel pending delivery if not yet delivered
  if (msg.queueId) {
    ctx.db.cancelPendingMessage(msg.queueId);
  }

  // Mark the original message as withdrawn
  ctx.db.withdrawMessage(id);

  // Send a follow-up withdrawal notice to the agent
  const withdrawalText = `[system] the user withdrew this message: "${msg.message}"`;
  const withdrawMsg = ctx.db.addDashboardMessage(msg.agent, 'to_agent', withdrawalText);

  const envelope = `[from: dashboard, reply with /collaboration reply]: '${sanitizeMessage(withdrawalText)}'`;
  const pending = ctx.db.enqueueMessage({
    sourceAgent: null,
    targetAgent: msg.agent,
    envelope,
  });
  ctx.db.linkDashboardMessageToQueue(withdrawMsg.id, pending.id);

  // Broadcast updates
  const updatedOriginal = ctx.db.getDashboardMessageById(id)!;
  ctx.wss.broadcast(JSON.stringify({ type: 'message_withdrawn', msg: updatedOriginal }));

  const linkedWithdrawMsg = { ...withdrawMsg, queueId: pending.id, deliveryStatus: 'pending' };
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: linkedWithdrawMsg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  // Attempt delivery
  ctx.messageDispatcher.tryDeliver(msg.agent).catch((err) => {
    console.error(`[routes] Withdrawal delivery failed for ${msg.agent}:`, (err as Error).message);
  });

  json(res, 200, { ok: true, withdrawnMsg: updatedOriginal, noticeMsg: linkedWithdrawMsg });
});

// ── Proxy Registration ──

route('POST', '/api/proxy/register', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.proxyId || !body.token || !body.host) {
    return json(res, 400, { error: 'proxyId, token, host required' });
  }

  const proxy = ctx.db.registerProxy(body.proxyId, body.token, body.host);
  broadcastProxyUpdate(ctx);
  json(res, 200, proxy);
});

route('POST', '/api/proxy/heartbeat', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.proxyId) return json(res, 400, { error: 'proxyId required' });

  const updated = ctx.db.updateProxyHeartbeat(body.proxyId);
  if (!updated) return json(res, 404, { error: 'Proxy not registered' });

  json(res, 200, { ok: true });
});

route('DELETE', '/api/proxy/:proxyId', async (_req, res, match, ctx) => {
  const proxyId = match.pathname.groups['proxyId']!;
  const removed = ctx.db.removeProxy(proxyId);
  if (!removed) return json(res, 404, { error: 'Proxy not found' });
  broadcastProxyUpdate(ctx);
  json(res, 200, { ok: true });
});

route('GET', '/api/proxies', async (_req, res, _match, ctx) => {
  const proxies = ctx.db.listProxies();
  json(res, 200, proxies);
});

// ── Events ──

route('GET', '/api/events/:agentName', async (req, res, match, ctx) => {
  const agentName = match.pathname.groups['agentName']!;
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 10000) : 50;
  const events = ctx.db.getEvents(agentName, limit);
  json(res, 200, events);
});

// ── Message Queue ──

route('GET', '/api/queue', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const messages = ctx.db.listPendingMessages(agent, status);
  json(res, 200, messages);
});

// ── Personas ──

const PERSONA_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

route('GET', '/api/personas', async (_req, res) => {
  try {
    const dir = getPersonasDir();
    const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    const personas = files.map(f => ({ name: f.replace(/\.md$/, ''), filename: f }));
    json(res, 200, personas);
  } catch {
    json(res, 200, []);
  }
});

route('GET', '/api/personas/:name', async (_req, res, match) => {
  const name = match.pathname.groups['name']!;
  if (!PERSONA_NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
  try {
    const raw = readFileSync(join(getPersonasDir(), `${name}.md`), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    json(res, 200, { name, content: raw, frontmatter, body });
  } catch {
    json(res, 404, { error: 'Persona not found' });
  }
});

route('PUT', '/api/personas/:name', async (req, res, match) => {
  const name = match.pathname.groups['name']!;
  if (!PERSONA_NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
  const body = await readJson(req);
  if (typeof body.content !== 'string') return json(res, 400, { error: 'content (string) required' });
  try {
    const dir = getPersonasDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body.content, 'utf-8');
    json(res, 200, { name, content: body.content });
  } catch (err) {
    json(res, 500, { error: `Failed to write persona: ${(err as Error).message}` });
  }
});

route('POST', '/api/personas', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.name || typeof body.name !== 'string') {
    return json(res, 400, { error: 'name (string) required' });
  }
  if (!body.content || typeof body.content !== 'string') {
    return json(res, 400, { error: 'content (string) required' });
  }

  const name = body.name as string;
  if (!PERSONA_NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });

  try {
    const persona = createPersonaAndAgent(ctx.db, name, body.content as string);
    const agent = ctx.db.getAgent(name);
    ctx.db.logEvent(name, 'persona_created');
    broadcastAgentUpdate(ctx, name);
    json(res, 201, { persona: { name: persona.name, frontmatter: persona.frontmatter }, agent });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// ── Agent Lifecycle Operations ──

route('POST', '/api/agents/:name/spawn', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    // Re-sync persona from disk to pick up config changes (engine, model, etc.)
    syncSinglePersona(ctx.db, name);
    const agent = ctx.db.getAgent(name);
    if (!agent) return json(res, 404, { error: 'Agent not found' });

    const result = await spawnAgent(lifecycleCtx, {
      name,
      engine: agent.engine,
      model: (body.model as string | undefined) ?? agent.model ?? undefined,
      thinking: (body.thinking as string | undefined) ?? agent.thinking ?? undefined,
      cwd: (body.cwd as string | undefined) ?? agent.cwd,
      persona: (body.persona as string | undefined) ?? agent.persona ?? undefined,
      proxyId: resolveProxyId(ctx, agent, body.proxyId as string | undefined),
      task: body.task as string | undefined,
    });

    broadcastAgentUpdate(ctx, name);
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/resume', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    // Re-sync persona from disk to pick up config changes (engine, model, etc.)
    syncSinglePersona(ctx.db, name);
    const agent = ctx.db.getAgent(name);
    if (!agent) return json(res, 404, { error: 'Agent not found' });

    // Pre-assign proxy if the agent doesn't have one (e.g. first resume after persona sync)
    const proxyId = resolveProxyId(ctx, agent, body.proxyId as string | undefined);
    if (proxyId && !agent.proxyId) {
      ctx.db.updateAgentState(name, agent.state, agent.version, { proxyId });
    }

    const result = await resumeAgent(lifecycleCtx, name, {
      task: body.task as string | undefined,
    });
    broadcastAgentUpdate(ctx, name);
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/suspend', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    const result = await suspendAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/reload', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    const result = await reloadAgent(lifecycleCtx, name, {
      immediate: body.immediate as boolean | undefined,
      task: body.task as string | undefined,
    });
    broadcastAgentUpdate(ctx, name);
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/interrupt', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await interruptAgent(lifecycleCtx, name);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/compact', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await compactAgent(lifecycleCtx, name);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/kill', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await killAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('GET', '/api/agents/:name/peek', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'capture',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    lines: 50,
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { output: result.data });
});

route('POST', '/api/agents/:name/keys', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const keys = body?.keys;
  if (typeof keys !== 'string' || !keys) { json(res, 400, { error: 'keys required' }); return; }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'send_keys',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    keys,
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true });
});

route('POST', '/api/agents/:name/destroy', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await destroyAgent(lifecycleCtx, name);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// ── Agent Reorder ──

route('POST', '/api/agents/reorder', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  const orders = body?.orders;
  if (!Array.isArray(orders) || !orders.every((o: unknown) =>
    typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>).name === 'string' && typeof (o as Record<string, unknown>).sortOrder === 'number'
  )) {
    json(res, 400, { error: 'orders must be an array of {name, sortOrder}' });
    return;
  }
  ctx.db.batchUpdateSortOrder(orders as Array<{ name: string; sortOrder: number }>);
  json(res, 200, { ok: true });
});

// ── Orchestrator Control ──

route('POST', '/api/orchestrator/shutdown', async (_req, res, _match, ctx) => {
  const networkCtx = makeLifecycleCtx(ctx);
  const count = shutdownAgents(networkCtx);
  json(res, 200, { ok: true, suspended: count });
});

route('POST', '/api/orchestrator/restore', async (_req, res, _match, ctx) => {
  try {
    const networkCtx = makeLifecycleCtx(ctx);
    const count = await restoreAllAgents(networkCtx);
    json(res, 200, { ok: true, restored: count });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

route('GET', '/api/engines/status', async (_req, res, _match, ctx) => {
  const agents = ctx.db.listAgents();
  const engines: Record<string, { configured: number; active: number; idle: number; failed: number; agents: string[] }> = {};
  for (const engine of ['claude', 'codex', 'opencode']) {
    const engineAgents = agents.filter(a => a.engine === engine);
    engines[engine] = {
      configured: engineAgents.length,
      active: engineAgents.filter(a => a.state === 'active').length,
      idle: engineAgents.filter(a => a.state === 'idle').length,
      failed: engineAgents.filter(a => a.state === 'failed').length,
      agents: engineAgents.map(a => a.name),
    };
  }
  const usage = ctx.usagePoller.getUsageData();
  json(res, 200, { engines, usage });
});

route('POST', '/api/engines/poll', async (_req, res, _match, ctx) => {
  try {
    await ctx.usagePoller.pollNow();
    const usage = ctx.usagePoller.getUsageData();
    json(res, 200, { ok: true, usage });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

route('GET', '/api/orchestrator/status', async (_req, res, _match, ctx) => {
  const agents = ctx.db.listAgents();
  const proxies = ctx.db.listProxies();
  const stats = {
    totalAgents: agents.length,
    byState: {} as Record<string, number>,
    totalProxies: proxies.length,
  };
  for (const a of agents) {
    stats.byState[a.state] = (stats.byState[a.state] ?? 0) + 1;
  }
  json(res, 200, stats);
});

  return routes;
}

// ── Rate Limiter ──

const RATE_LIMIT_WINDOW_MS = parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '60000', 10);   // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env['RATE_LIMIT_MAX'] ?? '120', 10);                  // 120 requests/min for POST
const RATE_LIMIT_UPLOAD_MAX = parseInt(process.env['RATE_LIMIT_UPLOAD_MAX'] ?? '30', 10);     // 30 uploads/min

type RateBucket = { timestamps: number[]; };
const rateBuckets = new Map<string, RateBucket>();

// Clean up stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    if (bucket.timestamps.length === 0) rateBuckets.delete(key);
  }
}, 5 * 60_000).unref();

function checkRateLimit(ip: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(ip, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
  if (bucket.timestamps.length >= limit) return false;
  bucket.timestamps.push(now);
  return true;
}

// ── Route Matcher ──

export function createRouter(ctx: RouteContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = buildRoutes();

  return async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Auth: state-mutating methods require Bearer token (GET and OPTIONS are exempt)
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      if (!authorize(ctx.orchestratorSecret, req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }

      // Rate limiting for POST/DELETE — applied after auth to avoid wasting
      // rate limit tokens on unauthenticated requests
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      const isUpload = url.pathname === '/api/dashboard/upload';
      const limit = isUpload ? RATE_LIMIT_UPLOAD_MAX : RATE_LIMIT_MAX;
      const bucketKey = isUpload ? `upload:${clientIp}` : `post:${clientIp}`;
      if (!checkRateLimit(bucketKey, limit)) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
        });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }
    }

    for (const route of routes) {
      if (req.method !== route.method) continue;
      const match = route.pattern.exec(url);
      if (match) {
        try {
          await route.handler(req, res, match, ctx);
        } catch (err) {
          const message = (err as Error).message;
          if (!res.headersSent) {
            // Return 400 for client errors (invalid JSON, oversized body)
            if (message === 'Invalid JSON body' || message === 'Request body too large') {
              json(res, 400, { error: message });
            } else {
              console.error(`[route error] ${req.method} ${req.url}:`, err);
              json(res, 500, { error: 'Internal server error' });
            }
          }
        }
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  };
}

function authorize(secret: string | null, req: IncomingMessage): boolean {
  if (!secret) return true; // dev mode — no auth
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx === -1) return false;
  const scheme = header.slice(0, spaceIdx);
  if (scheme !== 'Bearer') return false;
  const token = header.slice(spaceIdx + 1);
  // Timing-safe comparison to prevent token extraction via timing attacks
  if (token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

// ── Helpers ──

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += (chunk as Buffer).length;
    if (totalLength > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function broadcastAgentUpdate(ctx: RouteContext, agentName: string): void {
  const agent = ctx.db.getAgent(agentName);
  if (agent) {
    ctx.wss.broadcast(JSON.stringify({ type: 'agent_update', agent }));
  }
}

const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

function validateAgentName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!AGENT_NAME_RE.test(name)) return 'name must be 1-63 chars, start with alphanumeric, contain only [a-zA-Z0-9_-]';
  return null;
}

function broadcastProxyUpdate(ctx: RouteContext): void {
  const proxies = ctx.db.listProxies();
  ctx.wss.broadcast(JSON.stringify({ type: 'proxy_update', proxies }));
}

function makeLifecycleCtx(ctx: RouteContext): LifecycleContext {
  return {
    db: ctx.db,
    locks: ctx.locks,
    proxyDispatch: ctx.proxyDispatch,
    orchestratorHost: ctx.orchestratorHost,
  };
}

