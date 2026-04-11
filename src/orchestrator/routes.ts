/**
 * HTTP API routes for the orchestrator.
 * Uses URLPattern for routing. No frameworks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, rmSync, statSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderMarkdown, wrapInHtml, DOC_PAGES } from '../docs/render.ts';
import { hostname } from 'node:os';
import type { Database } from './database.ts';
import type { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentState, DashboardMessage, DestinationRecord, EngineType, PendingMessage, ProxyCommand, ProxyResponse, ProxyRegistration } from '../shared/types.ts';
import type { TelegramDispatcher } from './telegram.ts';
import { sanitizeMessage, generateMessageId } from '../shared/sanitize.ts';
import { getVersion, versionsMatch } from '../shared/version.ts';
import type { LockManager } from '../shared/lock.ts';
import { getPersonasDir, parseFrontmatter, createPersonaAndAgent, syncSinglePersona, syncPersonasWithDiff, updateFrontmatterField, resolvePersonaPath, toHostPath } from './persona.ts';
import {
  spawnAgent, resumeAgent, suspendAgent, destroyAgent,
  reloadAgent, recoverAgent, interruptAgent, compactAgent, killAgent,
  executeCustomButton, executeIndicatorAction,
  type LifecycleContext,
} from './lifecycle.ts';
import { getAdapter } from './adapters/index.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import { sessionName } from '../shared/agent-entity.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { UsagePoller } from './usage-poller.ts';

/** Validates agent and persona names: 1-63 chars, alphanumeric start, [a-zA-Z0-9_-]. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

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
  voiceEnabled: boolean;
  accountStore: import('./accounts.ts').AccountStore;
  pagesDir: string;
  storesDir: string;
  telegramDispatcher: TelegramDispatcher;
};

/**
 * Resolve the proxy ID for an agent at spawn/resume time.
 * Priority: explicit body value > agent's existing proxyId > any available proxy.
 */
function resolveProxyId(ctx: RouteContext, agent: { proxyId: string | null }, bodyProxyId?: string): string {
  // 1. Explicit override from request body
  if (bodyProxyId) return bodyProxyId;

  // 2. Already assigned (e.g. from a previous spawn)
  if (agent.proxyId) return agent.proxyId;

  // 3. Fall back to any registered proxy
  const proxies = ctx.db.listProxies();
  if (proxies.length > 0) return proxies[0]!.proxyId;

  return '';
}

/**
 * Self-heal: when a proxy (re-)registers, recover any failed agents on it
 * whose tmux sessions are still alive.
 */
async function recoverFailedAgents(ctx: RouteContext, proxyId: string): Promise<void> {
  const agents = ctx.db.listAgents().filter(
    (a) => a.proxyId === proxyId && a.state === 'failed',
  );
  if (agents.length === 0) return;

  let recovered = 0;
  for (const agent of agents) {
    const session = sessionName(agent);
    const result = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: session,
    });

    if (result.ok && result.data === true) {
      const current = ctx.db.getAgent(agent.name);
      if (!current || current.state !== 'failed') continue;
      ctx.db.updateAgentState(agent.name, 'active', current.version, {
        lastActivity: new Date().toISOString(),
        failedAt: null,
        failureReason: null,
      });
      ctx.db.logEvent(agent.name, 'self_healed', undefined, {
        reason: 'Proxy re-registered, tmux session alive',
      });
      ctx.wss.broadcast(JSON.stringify({
        type: 'agent_update',
        agent: ctx.db.getAgent(agent.name),
      }));
      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`[proxy-register] Self-healed ${recovered} agents on ${proxyId}`);
  }
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
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
  });
  res.end(ctx.getDashboardHtml());
});

// Serve dashboard ES module assets (*.js files under src/dashboard/)
const ASSET_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8', // browser-native type stripping
  '.css': 'text/css; charset=utf-8',
};

route('GET', '/dashboard/assets/:path+', async (req, res, match) => {
  const filePath = match.pathname.groups['path'] ?? '';
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const contentType = ASSET_TYPES[ext];
  if (filePath.includes('..') || !contentType) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  try {
    const fullPath = join(import.meta.dirname!, '..', 'dashboard', filePath);
    const content = readFileSync(fullPath, 'utf-8');
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// ── Docs ──

const DOCS_DIR = join(import.meta.dirname!, '..', 'docs');

route('GET', '/docs', async (_req, res) => {
  // Index page — redirect to quickstart
  res.writeHead(302, { location: '/docs/quickstart' });
  res.end();
});

route('GET', '/docs/:page', async (_req, res, match) => {
  const page = match.pathname.groups['page'] ?? '';
  if (page.includes('..') || !/^[a-z0-9-]+$/.test(page)) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const mdPath = join(DOCS_DIR, `${page}.md`);
  if (!existsSync(mdPath)) {
    res.writeHead(404); res.end('Page not found'); return;
  }
  const md = readFileSync(mdPath, 'utf-8');
  const bodyHtml = renderMarkdown(md);
  const docPage = DOC_PAGES.find(p => p.slug === page);
  const title = docPage?.title ?? page;
  const html = wrapInHtml(title, bodyHtml, page);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
  });
  res.end(html);
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
  if (!body.name || !body.cwd) {
    return json(res, 400, { error: 'name, cwd required' });
  }

  const nameError = validateAgentName(body.name as string);
  if (nameError) return json(res, 400, { error: nameError });

  const resolvedEngine = body.engine as string | undefined;
  if (!resolvedEngine) {
    return json(res, 400, { error: 'engine is required' });
  }

  const VALID_ENGINES = new Set(['claude', 'codex', 'opencode']);
  if (!VALID_ENGINES.has(resolvedEngine)) {
    return json(res, 400, { error: 'engine must be claude, codex, or opencode' });
  }

  const existing = ctx.db.getAgent(body.name);
  if (existing) return json(res, 409, { error: 'Agent already exists' });

  const agent = ctx.db.createAgent({
    name: body.name,
    engine: resolvedEngine as EngineType,
    model: body.model,
    thinking: body.thinking,
    cwd: body.cwd,
    persona: body.name,
    permissions: body.permissions,
    proxyId: body.proxyId,
    agentGroup: body.group,
  });

  // Write persona file so agent config persists across restarts
  try {
    const fmLines: string[] = [];
    if (body.engine) fmLines.push(`engine: ${body.engine}`);
    if (body.model) fmLines.push(`model: ${body.model}`);
    if (body.thinking) fmLines.push(`thinking: ${body.thinking}`);
    fmLines.push(`cwd: ${body.cwd}`);
    if (body.permissions) fmLines.push(`permissions: ${body.permissions}`);
    if (body.group) fmLines.push(`group: ${body.group}`);
    const content = `---\n${fmLines.join('\n')}\n---\n`;
    const dir = getPersonasDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${body.name}.md`), content, 'utf-8');
  } catch (err) {
    // Non-fatal — agent is created in DB even if persona file write fails
    console.warn(`[routes] Failed to write persona file for ${body.name}: ${(err as Error).message}`);
  }

  ctx.db.logEvent(agent.name, 'created');
  broadcastAgentUpdate(ctx, agent.name);
  json(res, 201, agent);
});

route('DELETE', '/api/agents/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) return json(res, 404, { error: 'Agent not found' });

  // Clean up config profile for engines that use it (e.g. Codex)
  if (agent.proxyId) {
    const adapter = getAdapter(agent.engine);
    if (adapter.usesConfigProfile) {
      await ctx.proxyDispatch(agent.proxyId, {
        action: 'remove_codex_profile',
        profileName: name,
      }).catch((err) => { console.warn('[cleanup] Config profile removal failed:', (err as Error).message); });
    }
  }

  // Delete persona file so persona sync doesn't resurrect the agent
  const personaFilename = agent.persona ?? name;
  const personaPath = join(getPersonasDir(), `${personaFilename}.md`);
  try { unlinkSync(personaPath); } catch { /* file may not exist */ }

  ctx.db.deleteAgent(name);
  ctx.db.logEvent(name, 'destroyed');
  ctx.wss.broadcast(JSON.stringify({ type: 'agent_destroyed', name }));
  json(res, 200, { ok: true });
});

// ── Agent Messaging ──

route('POST', '/api/agents/send', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.from || !body.to || !body.message || !body.topic) {
    return json(res, 400, { error: 'from, to, message, topic required' });
  }

  const target = ctx.db.getAgent(body.to);
  if (!target) return json(res, 404, { error: `Target agent "${body.to}" not found` });
  if (target.state === 'void') {
    return json(res, 400, { error: `Target agent "${body.to}" is in void state (not spawned). Spawn it first with: collab spawn ${body.to}` });
  }

  const messageId = generateMessageId();
  const sanitized = sanitizeMessage(body.message);
  const topicStr = body.topic as string;

  // Format envelope with topic
  const envelope = buildReplyEnvelope(body.from as string, topicStr, sanitized);

  // Enqueue for async delivery
  const pending = ctx.db.enqueueMessage({
    sourceAgent: body.from as string,
    targetAgent: body.to as string,
    envelope,
  });

  // Store in dashboard_messages for sender thread (from_agent direction — agent sent it)
  const senderMsg = ctx.db.addDashboardMessage(body.from as string, 'from_agent', sanitized, {
    topic: topicStr,
    sourceAgent: body.from as string,
    targetAgent: body.to as string,
  });
  ctx.db.linkDashboardMessageToQueue(senderMsg.id, pending.id);

  // Store in dashboard_messages for receiver thread (to_agent direction — message going to agent)
  const receiverMsg = ctx.db.addDashboardMessage(body.to as string, 'to_agent', sanitized, {
    topic: topicStr,
    sourceAgent: body.from as string,
    targetAgent: body.to as string,
  });
  ctx.db.linkDashboardMessageToQueue(receiverMsg.id, pending.id);

  // Log routing events
  ctx.db.logEvent(body.from as string, 'message_queued', messageId, { to: body.to, queueId: pending.id });
  ctx.db.logEvent(body.to as string, 'message_queued', messageId, { from: body.from, queueId: pending.id });

  // Broadcast both messages + queue update to dashboard
  const linkedSenderMsg = { ...senderMsg, queueId: pending.id, deliveryStatus: 'pending' };
  const linkedReceiverMsg = { ...receiverMsg, queueId: pending.id, deliveryStatus: 'pending' };
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: linkedSenderMsg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: linkedReceiverMsg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  // Auto-create reply reminder if requested
  if (body.replyReminder) {
    const cadence = typeof body.replyReminder === 'number' ? body.replyReminder : 30;
    const prompt = `[reply-reminder] topic: ${topicStr} | from: ${body.from} | "${sanitized}" — Please respond if you haven't already.`;
    ctx.db.createReminder({ agentName: body.to as string, createdBy: body.from as string, prompt, cadenceMinutes: Math.max(cadence, 5) });
  }

  // Event-driven delivery — attempt immediately, don't block response
  ctx.messageDispatcher.tryDeliver(body.to as string).catch((err) => {
    console.error(`[routes] Immediate delivery failed for ${body.to}:`, (err as Error).message);
  });

  json(res, 202, { ok: true, messageId, queueId: pending.id, status: 'pending' });
});

// ── Dashboard Messages ──

route('POST', '/api/dashboard/send', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agent || !body.message || !body.topic) {
    return json(res, 400, { error: 'agent, message, topic required' });
  }

  const agent = ctx.db.getAgent(body.agent);
  if (!agent) return json(res, 404, { error: `Agent "${body.agent}" not found` });

  const sanitized = sanitizeMessage(body.message);
  const topicStr = body.topic as string;

  const envelope = buildReplyEnvelope('dashboard', topicStr, sanitized);
  const { msg, pending } = enqueueAndDeliver(ctx, {
    agentName: body.agent as string,
    displayMessage: sanitized,
    envelope,
    topic: topicStr,
    sourceAgent: 'dashboard',
    targetAgent: body.agent as string,
    queueSourceAgent: null,
  });

  // Auto-create reply reminder if requested
  if (body.replyReminder) {
    const cadence = typeof body.replyReminder === 'number' ? body.replyReminder : 30;
    const prompt = `[reply-reminder] topic: ${topicStr} | from: dashboard | "${sanitized}" — Please respond if you haven't already.`;
    ctx.db.createReminder({ agentName: body.agent as string, createdBy: 'dashboard', prompt, cadenceMinutes: Math.max(cadence, 5) });
  }

  json(res, 202, { ok: true, msg, queueId: pending.id, status: 'pending' });
});

route('POST', '/api/dashboard/upload', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agentName = url.searchParams.get('agent');
  const filename = url.searchParams.get('filename');
  const userMessage = url.searchParams.get('message');

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
  const uploadNotice = `I uploaded ${writtenPath}`;
  const agentMessage = userMessage ? `${userMessage}\n\n${uploadNotice}` : uploadNotice;
  const envelope = buildReplyEnvelope('dashboard', 'file-upload', sanitizeMessage(agentMessage));
  const displayMessage = userMessage
    ? `${userMessage}\n\nUploaded ${filename} (${formatBytes(fileSize)})`
    : `Uploaded ${filename} (${formatBytes(fileSize)})`;

  const { msg, pending } = enqueueAndDeliver(ctx, {
    agentName,
    displayMessage,
    envelope,
    topic: 'file-upload',
    sourceAgent: 'dashboard',
    targetAgent: agentName,
    queueSourceAgent: null,
    broadcastLinked: false,
  });

  json(res, 202, { ok: true, msg, queueId: pending.id, path: writtenPath, size: fileSize });
});

route('POST', '/api/dashboard/reply', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agent || !body.message || !body.topic) {
    return json(res, 400, { error: 'agent, message, topic required' });
  }

  const sanitized = sanitizeMessage(body.message);
  const msg = ctx.db.addDashboardMessage(body.agent, 'from_agent', sanitized, { topic: body.topic as string, sourceAgent: body.agent as string });

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

route('GET', '/api/dashboard/messages/search', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json(res, 400, { error: 'q (search query) required' });
  const agent = url.searchParams.get('agent') || undefined;
  const results = ctx.db.searchMessages(q, agent);
  json(res, 200, results);
});

route('PUT', '/api/dashboard/read-cursor', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agent || typeof body.agent !== 'string') {
    return json(res, 400, { error: 'agent (string) required' });
  }
  ctx.db.updateReadCursor(body.agent as string);
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

  // Broadcast withdrawal of the original message before sending the notice
  const updatedOriginal = ctx.db.getDashboardMessageById(id)!;
  ctx.wss.broadcast(JSON.stringify({ type: 'message_withdrawn', msg: updatedOriginal }));

  // Send a follow-up withdrawal notice to the agent
  const withdrawalText = `[system] the user withdrew this message: "${msg.message}"`;
  const envelope = buildReplyEnvelope('dashboard', msg.topic ?? 'system', sanitizeMessage(withdrawalText));
  const { linkedMsg: linkedWithdrawMsg } = enqueueAndDeliver(ctx, {
    agentName: msg.agent,
    displayMessage: withdrawalText,
    envelope,
    topic: msg.topic ?? 'system',
    sourceAgent: 'dashboard',
    targetAgent: msg.agent,
    queueSourceAgent: null,
  });

  json(res, 200, { ok: true, withdrawnMsg: updatedOriginal, noticeMsg: linkedWithdrawMsg });
});

// ── Proxy Registration ──

route('POST', '/api/proxy/register', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.proxyId || !body.token || !body.host) {
    return json(res, 400, { error: 'proxyId, token, host required' });
  }

  const proxyVersion = typeof body.version === 'string' ? body.version : undefined;

  // Migrate agents from any stale proxy that served the same host.
  // Handles proxy renames (e.g. hostname changed, -proxy suffix added/removed).
  const staleProxies = ctx.db.listProxies().filter(
    p => p.host === body.host && p.proxyId !== body.proxyId
  );
  for (const stale of staleProxies) {
    const migrated = ctx.db.migrateAgentsToProxy(stale.proxyId, body.proxyId);
    if (migrated > 0) {
      console.log(`[proxy-register] Migrated ${migrated} agents from "${stale.proxyId}" to "${body.proxyId}"`);
    }
  }

  const proxy = ctx.db.registerProxy(body.proxyId, body.token, body.host, proxyVersion);

  // Compute version match and enrich the response
  const orchestratorVersion = getVersion();
  const versionMatch = !!proxyVersion && versionsMatch(proxyVersion, orchestratorVersion);
  const enriched: ProxyRegistration = { ...proxy, versionMatch };

  if (proxyVersion && !versionMatch) {
    console.warn(`[proxy-register] Version mismatch: proxy "${body.proxyId}" is ${proxyVersion}, orchestrator is ${orchestratorVersion}`);
  }

  broadcastProxyUpdate(ctx);
  json(res, 200, { ...enriched, orchestratorVersion });

  // Self-heal: recover failed agents on this proxy whose tmux sessions survived
  recoverFailedAgents(ctx, body.proxyId).catch((err) => {
    console.error(`[proxy-register] Recovery failed for ${body.proxyId}:`, err);
  });
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
  const proxies = enrichProxiesWithVersionMatch(ctx.db.listProxies());
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
  const limit = parseInt(url.searchParams.get('limit') ?? '', 10) || undefined;
  const messages = ctx.db.listPendingMessages(agent, status, limit);
  json(res, 200, messages);
});

// ── Agent Files ──

route('GET', '/api/agents/:name/files', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) return json(res, 404, { error: 'Agent not found' });
  if (!agent.cwd) return json(res, 400, { error: 'Agent has no working directory' });
  if (!agent.proxyId) return json(res, 400, { error: 'Agent has no proxy' });

  try {
    const result = await ctx.proxyDispatch(agent.proxyId, {
      action: 'exec',
      command: `find . -maxdepth 1 -not -name '.' -printf '%T@\\t%s\\t%y\\t%f\\n' 2>/dev/null | sort -rn | head -100`,
      cwd: agent.cwd,
      timeoutMs: 5000,
    } as any);
    if (!result.ok) return json(res, 500, { error: 'Failed to list files' });

    const files = (result.data as string).split('\n').filter(Boolean).map(line => {
      const [mtime, size, type, ...nameParts] = line.split('\t');
      return {
        name: nameParts.join('\t'),
        size: parseInt(size ?? '0', 10),
        isDir: type === 'd',
        modified: new Date(parseFloat(mtime ?? '0') * 1000).toISOString(),
      };
    });
    json(res, 200, { cwd: agent.cwd, files });
  } catch {
    json(res, 500, { error: 'Failed to list files' });
  }
});

// ── Engine Configs ──

route('GET', '/api/engine-configs', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listEngineConfigs());
});

route('GET', '/api/engine-configs/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const config = ctx.db.getEngineConfig(name);
  if (!config) return json(res, 404, { error: 'Engine config not found' });
  json(res, 200, config);
});

route('POST', '/api/engine-configs', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.name || !body.engine) return json(res, 400, { error: 'name and engine required' });
  try {
    ctx.db.createEngineConfig(body as Parameters<typeof ctx.db.createEngineConfig>[0]);
    const config = ctx.db.getEngineConfig(body.name as string);
    ctx.wss.broadcast(JSON.stringify({ type: 'engine_config_update', config }));
    json(res, 201, config);
  } catch (err) {
    json(res, 409, { error: 'Engine config already exists' });
  }
});

route('PUT', '/api/engine-configs/:name', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const updated = ctx.db.updateEngineConfig(name, body as Parameters<typeof ctx.db.updateEngineConfig>[1]);
  if (!updated) return json(res, 404, { error: 'Engine config not found' });
  const config = ctx.db.getEngineConfig(name);
  ctx.wss.broadcast(JSON.stringify({ type: 'engine_config_update', config }));
  json(res, 200, config);
});

route('DELETE', '/api/engine-configs/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  // Check if any agents use this engine (engine field is the config lookup key)
  const agents = ctx.db.listAgents();
  const refs = agents.filter(a => a.engine === name);
  if (refs.length > 0) {
    return json(res, 409, { error: `Cannot delete: ${refs.length} agent(s) use engine "${name}"` });
  }
  const deleted = ctx.db.deleteEngineConfig(name);
  if (!deleted) return json(res, 404, { error: 'Engine config not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'engine_config_deleted', name }));
  json(res, 200, { ok: true });
});

route('POST', '/api/engine-configs/reset-defaults', async (_req, res, _match, ctx) => {
  const { DEFAULT_ENGINE_CONFIGS } = await import('./default-engine-configs.ts');
  const results: string[] = [];
  for (const config of DEFAULT_ENGINE_CONFIGS) {
    const existing = ctx.db.getEngineConfig(config.name);
    if (existing) {
      // Delete and recreate to clear stale fields not in the new defaults
      ctx.db.deleteEngineConfig(config.name);
    }
    ctx.db.createEngineConfig(config);
    results.push(existing ? `reset: ${config.name}` : `created: ${config.name}`);
  }
  const configs = ctx.db.listEngineConfigs();
  ctx.wss.broadcast(JSON.stringify({ type: 'init', engineConfigs: configs }));
  json(res, 200, { ok: true, results });
});

// ── Pages (static hosting) ──

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MAX_PAGE_BYTES = 50 * 1024 * 1024; // 50 MB

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.xml': 'application/xml',
};

function pageMime(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Recursively count files and total bytes in a directory. */
function dirStats(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0, totalBytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirStats(p);
      fileCount += sub.fileCount;
      totalBytes += sub.totalBytes;
    } else {
      fileCount++;
      totalBytes += statSync(p).size;
    }
  }
  return { fileCount, totalBytes };
}

// Publish a page: POST /api/pages?slug=<slug>&agent=<agent>&title=<title>
// Body: tar stream (extracted to pages/<slug>/) OR single file with &filename=<name>
route('POST', '/api/pages', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const slug = url.searchParams.get('slug');
  const agent = url.searchParams.get('agent') ?? null;
  const title = url.searchParams.get('title') ?? null;

  if (!slug || !SLUG_RE.test(slug)) return json(res, 400, { error: 'Invalid slug (kebab-case, 2-64 chars)' });

  const pageDir = join(ctx.pagesDir, slug);
  const filename = url.searchParams.get('filename');

  // Collect body
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > MAX_PAGE_BYTES) return json(res, 413, { error: `Page exceeds ${MAX_PAGE_BYTES / 1024 / 1024}MB limit` });
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  if (filename) {
    // Single file upload
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, filename), body);
  } else {
    // Tar stream — extract using node:child_process
    mkdirSync(pageDir, { recursive: true });
    const { execSync } = await import('node:child_process');
    try {
      execSync('tar xf -', { input: body, cwd: pageDir, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return json(res, 400, { error: 'Failed to extract tar: ' + (err as Error).message });
    }
  }

  const stats = dirStats(pageDir);
  const page = ctx.db.createPage({ slug, title, agent: agent ?? undefined, fileCount: stats.fileCount, totalBytes: stats.totalBytes });
  ctx.wss.broadcast(JSON.stringify({ type: 'pages_update', pages: ctx.db.listPages() }));
  json(res, 201, page);
});

route('GET', '/api/pages', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listPages());
});

route('DELETE', '/api/pages/:slug', async (_req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const pageDir = join(ctx.pagesDir, slug);
  if (existsSync(pageDir)) rmSync(pageDir, { recursive: true });
  const deleted = ctx.db.deletePage(slug);
  if (!deleted) return json(res, 404, { error: 'Page not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'pages_update', pages: ctx.db.listPages() }));
  json(res, 200, { ok: true });
});

// Public page serving (no auth)
route('GET', '/pages/:slug', async (_req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const indexPath = join(ctx.pagesDir, slug, 'index.html');
  if (!existsSync(indexPath)) {
    // Try listing files if no index.html
    const pageDir = join(ctx.pagesDir, slug);
    if (!existsSync(pageDir)) return json(res, 404, { error: 'Page not found' });
    const files = readdirSync(pageDir);
    if (files.length === 1) {
      // Single file — serve it directly
      const filePath = join(pageDir, files[0]!);
      res.writeHead(200, { 'Content-Type': pageMime(filePath) });
      res.end(readFileSync(filePath));
      return;
    }
    // List files as simple HTML
    const links = files.map(f => `<li><a href="/pages/${slug}/${f}">${f}</a></li>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>${slug}</title></head><body><h1>${slug}</h1><ul>${links}</ul></body></html>`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(readFileSync(indexPath));
});

route('GET', '/pages/:slug/:path+', async (_req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const filePath = match.pathname.groups['path']!;
  if (filePath.includes('..')) return json(res, 400, { error: 'Invalid path' });
  const fullPath = join(ctx.pagesDir, slug, filePath);
  if (!existsSync(fullPath)) return json(res, 404, { error: 'File not found' });
  res.writeHead(200, { 'Content-Type': pageMime(fullPath) });
  res.end(readFileSync(fullPath));
});

// ── Data Stores ──

const MAX_STORE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STORE_ROWS = 1000;

/** SQL statements allowed in store queries. */
const ALLOWED_SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;

/** Dangerous statements that must be rejected outright. */
const DENIED_SQL_RE = /\b(ATTACH|DETACH)\b/i;

/** PRAGMA whitelist — only table_info is allowed. */
const PRAGMA_TABLE_INFO_RE = /^\s*PRAGMA\s+table_info\s*\(/i;

function validateStoreSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed) return 'Empty SQL statement';

  // Check for multiple statements (semicolons followed by more content)
  const stmtParts = trimmed.split(';').filter(s => s.trim().length > 0);
  if (stmtParts.length > 1) return 'Multiple statements not allowed';

  // Check for denied keywords
  if (DENIED_SQL_RE.test(trimmed)) return 'ATTACH/DETACH not allowed';

  // Allow PRAGMA table_info specifically
  if (/^\s*PRAGMA\b/i.test(trimmed)) {
    if (!PRAGMA_TABLE_INFO_RE.test(trimmed)) return 'Only PRAGMA table_info is allowed';
    return null;
  }

  // Check against allowed statement types
  if (!ALLOWED_SQL_RE.test(trimmed)) return 'Only SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE, DROP TABLE are allowed';

  return null;
}

function openStoreDb(storesDir: string, name: string): DatabaseSync {
  const dbPath = join(storesDir, `${name}.db`);
  const storeDb = new DatabaseSync(dbPath);
  storeDb.exec('PRAGMA journal_mode = WAL');
  storeDb.exec('PRAGMA busy_timeout = 5000');
  return storeDb;
}

function checkStoreSize(storesDir: string, name: string): boolean {
  const dbPath = join(storesDir, `${name}.db`);
  if (!existsSync(dbPath)) return true;
  const stat = statSync(dbPath);
  return stat.size <= MAX_STORE_BYTES;
}

route('POST', '/api/stores', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  const name = body.name as string | undefined;
  const agent = (body.agent as string | undefined) ?? null;

  if (!name || !SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name (kebab-case, 2-64 chars)' });

  // Create the SQLite file to make it real
  const storeDb = openStoreDb(ctx.storesDir, name);
  storeDb.close();

  const record = ctx.db.createStore({ name, agent: agent ?? undefined });
  ctx.wss.broadcast(JSON.stringify({ type: 'stores_update', stores: ctx.db.listStores() }));
  json(res, 201, record);
});

route('GET', '/api/stores', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listStores());
});

route('GET', '/api/stores/:name/schema', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name' });

  const record = ctx.db.getStore(name);
  if (!record) return json(res, 404, { error: 'Store not found' });

  const dbPath = join(ctx.storesDir, `${name}.db`);
  if (!existsSync(dbPath)) return json(res, 404, { error: 'Store file not found' });

  const storeDb = openStoreDb(ctx.storesDir, name);
  try {
    const tables = storeDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<Record<string, unknown>>;
    const schema: Record<string, Array<{ name: string; type: string; notnull: boolean; pk: boolean }>> = {};
    for (const t of tables) {
      const tableName = t['name'] as string;
      const cols = storeDb.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`).all() as Array<Record<string, unknown>>;
      schema[tableName] = cols.map(c => ({
        name: c['name'] as string,
        type: c['type'] as string,
        notnull: (c['notnull'] as number) === 1,
        pk: (c['pk'] as number) > 0,
      }));
    }
    json(res, 200, schema);
  } finally {
    storeDb.close();
  }
});

route('POST', '/api/stores/:name/query', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name' });

  const record = ctx.db.getStore(name);
  if (!record) return json(res, 404, { error: 'Store not found' });

  const body = await readJson(req);
  const sql = body.sql as string | undefined;
  const params = (body.params as unknown[]) ?? [];

  if (!sql) return json(res, 400, { error: 'sql is required' });
  const sqlErr = validateStoreSql(sql);
  if (sqlErr) return json(res, 400, { error: sqlErr });

  // Size check for mutating operations
  const isRead = /^\s*SELECT\b/i.test(sql.trim());
  if (!isRead && !checkStoreSize(ctx.storesDir, name)) {
    return json(res, 413, { error: `Store exceeds ${MAX_STORE_BYTES / 1024 / 1024}MB limit` });
  }

  const dbPath = join(ctx.storesDir, `${name}.db`);
  if (!existsSync(dbPath)) return json(res, 404, { error: 'Store file not found' });

  const storeDb = openStoreDb(ctx.storesDir, name);
  try {
    const trimmed = sql.trim();
    if (/^\s*SELECT\b/i.test(trimmed) || PRAGMA_TABLE_INFO_RE.test(trimmed)) {
      const stmt = storeDb.prepare(trimmed);
      const rows = stmt.all(...params) as unknown[];
      const limited = rows.slice(0, MAX_STORE_ROWS);
      json(res, 200, { rows: limited, truncated: rows.length > MAX_STORE_ROWS });
    } else {
      const stmt = storeDb.prepare(trimmed);
      const result = stmt.run(...params);
      ctx.db.touchStore(name);
      json(res, 200, { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) });
    }
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  } finally {
    storeDb.close();
  }
});

route('DELETE', '/api/stores/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name' });

  // Remove the SQLite file
  const dbPath = join(ctx.storesDir, `${name}.db`);
  if (existsSync(dbPath)) unlinkSync(dbPath);
  // Also remove WAL/SHM if present
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) unlinkSync(walPath);
  if (existsSync(shmPath)) unlinkSync(shmPath);

  const deleted = ctx.db.deleteStore(name);
  if (!deleted) return json(res, 404, { error: 'Store not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'stores_update', stores: ctx.db.listStores() }));
  json(res, 200, { ok: true });
});

// ── Destinations (Telegram, etc.) ──

route('POST', '/api/destinations', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  const name = body.name as string | undefined;
  const type = body.type as string | undefined;
  const config = body.config as Record<string, unknown> | undefined;

  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 64) {
    return json(res, 400, { error: 'name required (1-64 chars)' });
  }
  if (!type || typeof type !== 'string') {
    return json(res, 400, { error: 'type required (e.g. "telegram")' });
  }
  if (!config || typeof config !== 'object') {
    return json(res, 400, { error: 'config required (object)' });
  }
  if (type === 'telegram') {
    if (!config.botToken || !config.chatId) {
      return json(res, 400, { error: 'telegram config requires botToken and chatId' });
    }
  }

  if (ctx.db.getDestination(name)) {
    return json(res, 409, { error: `Destination "${name}" already exists` });
  }

  const record = ctx.db.createDestination({ name, type, config });
  ctx.wss.broadcast(JSON.stringify({ type: 'destinations_update', destinations: ctx.db.listDestinations() }));

  // Start polling for newly created telegram destinations
  if (type === 'telegram' && record.enabled) {
    startTelegramPolling(ctx, record);
  }

  json(res, 201, record);
});

route('GET', '/api/destinations', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listDestinations());
});

route('DELETE', '/api/destinations/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const existing = ctx.db.getDestination(name);
  if (!existing) return json(res, 404, { error: 'Destination not found' });

  // Stop polling if telegram
  if (existing.type === 'telegram') {
    ctx.telegramDispatcher.stopPolling();
  }

  const deleted = ctx.db.deleteDestination(name);
  if (!deleted) return json(res, 404, { error: 'Destination not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'destinations_update', destinations: ctx.db.listDestinations() }));
  json(res, 200, { ok: true });
});

route('POST', '/api/destinations/:name/send', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const dest = ctx.db.getDestination(name);
  if (!dest) return json(res, 404, { error: 'Destination not found' });
  if (!dest.enabled) return json(res, 400, { error: 'Destination is disabled' });

  const body = await readJson(req);
  const message = body.message as string | undefined;
  if (!message) return json(res, 400, { error: 'message required' });

  const fromAgent = body.fromAgent as string | undefined;
  const text = fromAgent ? `[${fromAgent}] ${message}` : message;

  if (dest.type === 'telegram') {
    const botToken = dest.config.botToken as string;
    const chatId = dest.config.chatId as string;
    const ok = await ctx.telegramDispatcher.send(botToken, chatId, text);
    if (!ok) return json(res, 502, { error: 'Telegram send failed' });
    json(res, 200, { ok: true });
  } else {
    json(res, 400, { error: `Unsupported destination type: ${dest.type}` });
  }
});

route('POST', '/api/destinations/:name/test', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const dest = ctx.db.getDestination(name);
  if (!dest) return json(res, 404, { error: 'Destination not found' });

  if (dest.type === 'telegram') {
    const botToken = dest.config.botToken as string;
    const chatId = dest.config.chatId as string;
    const ok = await ctx.telegramDispatcher.send(botToken, chatId, `[agentic-collab] Test message from destination "${name}"`);
    if (!ok) return json(res, 502, { error: 'Telegram test send failed' });
    json(res, 200, { ok: true });
  } else {
    json(res, 400, { error: `Unsupported destination type: ${dest.type}` });
  }
});

// ── Personas ──


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
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
  try {
    const filePath = join(getPersonasDir(), `${name}.md`);
    const raw = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    json(res, 200, { name, content: raw, frontmatter, body, filePath: toHostPath(filePath), hostname: hostname() });
  } catch {
    json(res, 404, { error: 'Persona not found' });
  }
});

route('PUT', '/api/personas/:name', async (req, res, match) => {
  const name = match.pathname.groups['name']!;
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
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
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });

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

route('POST', '/api/sync-personas', async (_req, res, _match, ctx) => {
  const result = syncPersonasWithDiff(ctx.db);
  // Broadcast agent updates for any created or updated agents
  for (const name of [...result.created, ...result.updated]) {
    broadcastAgentUpdate(ctx, name);
  }
  if (result.created.length > 0 || result.updated.length > 0) {
    console.log(`[sync-personas] created: ${result.created.length}, updated: ${result.updated.length}, unchanged: ${result.unchanged.length}, skipped: ${result.skipped.length}`);
  }
  json(res, 200, result);
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
    broadcastLifecycleEvent(ctx, name, 'Spawned');
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
    broadcastLifecycleEvent(ctx, name, 'Resumed');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// Primary "exit" endpoint + backward-compat "suspend" alias
const handleExit: RouteHandler = async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    const result = await suspendAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Exited');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
};
route('POST', '/api/agents/:name/exit', handleExit);
route('POST', '/api/agents/:name/suspend', handleExit);

route('POST', '/api/agents/:name/reload', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    // Re-sync persona from disk to pick up config changes (engine, model, etc.)
    syncSinglePersona(ctx.db, name);
    const result = await reloadAgent(lifecycleCtx, name, {
      immediate: body.immediate as boolean | undefined,
      task: body.task as string | undefined,
    });
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Reloaded');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/recover', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    syncSinglePersona(ctx.db, name);
    const result = await recoverAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Recovered');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/interrupt', lifecycleRoute(interruptAgent, { eventLabel: 'Interrupted' }));

route('POST', '/api/agents/:name/compact', lifecycleRoute(compactAgent, { eventLabel: 'Compacted' }));

route('POST', '/api/agents/:name/kill', lifecycleRoute(killAgent, { broadcast: true, eventLabel: 'Killed' }));

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

function parseTmuxCaptureLines(args: string[]): number {
  let sawPrint = false;
  let lines = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p') {
      sawPrint = true;
      continue;
    }
    if (args[i] === '-S') {
      const start = args[++i];
      const match = typeof start === 'string' ? /^-(\d+)$/.exec(start) : null;
      if (!match) {
        throw new Error('capture-pane only supports -S -<lines>');
      }
      lines = Math.max(1, Math.min(parseInt(match[1]!, 10), 10000));
      continue;
    }
    throw new Error('capture-pane only supports -p and optional -S -<lines>');
  }

  if (!sawPrint) {
    throw new Error('capture-pane currently requires -p');
  }
  return lines;
}

function parseTmuxResize(args: string[]): { width: number; height: number } {
  if (args.length !== 4) {
    throw new Error('resize-window requires -x <width> and -y <height>');
  }
  const xIdx = args.indexOf('-x');
  const yIdx = args.indexOf('-y');
  const width = xIdx !== -1 ? parseInt(args[xIdx + 1] ?? '', 10) : NaN;
  const height = yIdx !== -1 ? parseInt(args[yIdx + 1] ?? '', 10) : NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('resize-window requires -x <width> and -y <height>');
  }
  return { width: Math.floor(width), height: Math.floor(height) };
}

route('POST', '/api/agents/:name/tmux', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const args = body?.args;
  if (!Array.isArray(args) || args.length === 0 || !args.every((arg: unknown) => typeof arg === 'string')) {
    json(res, 400, { error: 'args (string[]) required' }); return;
  }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const sessionName = agent.tmuxSession ?? `agent-${name}`;
  const [subcommand, ...rest] = args as string[];
  let result: ProxyResponse;

  try {
    switch (subcommand) {
      case 'send-keys':
        if (rest.length === 0) throw new Error('send-keys requires at least one key/token');
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'send_keys_raw',
          sessionName,
          keys: rest,
        });
        break;

      case 'capture-pane':
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'capture',
          sessionName,
          lines: parseTmuxCaptureLines(rest),
        });
        break;

      case 'display-message':
        if (rest.length !== 2 || rest[0] !== '-p' || !rest[1]) {
          throw new Error('display-message currently requires -p <format>');
        }
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'display_message',
          sessionName,
          format: rest[1],
        });
        break;

      case 'resize-window': {
        const { width, height } = parseTmuxResize(rest);
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'resize_pane',
          sessionName,
          width,
          height,
        });
        break;
      }

      case 'has-session':
        if (rest.length > 0) throw new Error('has-session does not take extra arguments');
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'has_session',
          sessionName,
        });
        break;

      case 'pane-activity':
        if (rest.length > 0) throw new Error('pane-activity does not take extra arguments');
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'pane_activity',
          sessionName,
        });
        break;

      default:
        throw new Error('supported tmux commands: send-keys, capture-pane, display-message, resize-window, has-session, pane-activity');
    }
  } catch (err) {
    json(res, 400, { error: (err as Error).message }); return;
  }

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true, data: result.data ?? null });
});

route('POST', '/api/agents/:name/type', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const text = body?.text;
  if (typeof text !== 'string' || !text) { json(res, 400, { error: 'text required' }); return; }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const pressEnter = body?.pressEnter === true;
  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'paste',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    text,
    pressEnter,
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true });
});

route('POST', '/api/agents/:name/resize', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const width = body?.width;
  const height = body?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) {
    json(res, 400, { error: 'width and height required (positive integers)' }); return;
  }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'resize_pane',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    width: Math.floor(width),
    height: Math.floor(height),
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true });
});

route('POST', '/api/agents/:name/destroy', lifecycleRoute(destroyAgent, { broadcast: 'destroyed' }));

// ── Custom Buttons ──

route('POST', '/api/agents/:name/custom/:button', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const button = match.pathname.groups['button']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await executeCustomButton(lifecycleCtx, name, button);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// ── Indicator Actions ──

route('POST', '/api/agents/:name/indicator/:indicator/:action', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const indicator = match.pathname.groups['indicator']!;
  const action = match.pathname.groups['action']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await executeIndicatorAction(lifecycleCtx, name, indicator, action);
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

route('PATCH', '/api/agents/:name/group', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const group = body?.group;
  if (typeof group !== 'string') { json(res, 400, { error: 'group (string) required' }); return; }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }

  // Update persona frontmatter on disk
  const personaPath = resolvePersonaPath(name);
  if (personaPath) {
    updateFrontmatterField(personaPath, 'group', group || null);
  }

  // Update DB (reuse the agent fetched above)
  ctx.db.updateAgentState(name, agent.state, agent.version, {
    agentGroup: group || null,
  });

  ctx.wss.broadcast(JSON.stringify({
    type: 'agent_update',
    agent: ctx.db.getAgent(name),
  }));

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

route('GET', '/api/voice/status', async (_req, res, _match, ctx) => {
  json(res, 200, { enabled: ctx.voiceEnabled });
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

// ── Reminders ──

route('POST', '/api/reminders', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agentName || typeof body.agentName !== 'string') {
    return json(res, 400, { error: 'agentName required' });
  }
  if (!body.prompt || typeof body.prompt !== 'string') {
    return json(res, 400, { error: 'prompt required' });
  }
  if (typeof body.cadenceMinutes !== 'number' || body.cadenceMinutes < 5) {
    return json(res, 400, { error: 'cadenceMinutes must be >= 5' });
  }

  const agent = ctx.db.getAgent(body.agentName as string);
  if (!agent) return json(res, 404, { error: `Agent "${body.agentName}" not found` });

  const reminder = ctx.db.createReminder({
    agentName: body.agentName as string,
    createdBy: (body.createdBy as string | undefined) ?? undefined,
    prompt: body.prompt as string,
    cadenceMinutes: body.cadenceMinutes as number,
    skipIfActive: typeof body.skipIfActive === 'boolean' ? body.skipIfActive : undefined,
  });

  broadcastReminderUpdate(ctx);
  json(res, 201, reminder);
});

route('GET', '/api/reminders', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  const reminders = ctx.db.listReminders(agent);
  json(res, 200, reminders);
});

route('POST', '/api/reminders/:id/complete', async (_req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid reminder ID' });

  const reminder = ctx.db.getReminder(id);
  if (!reminder) return json(res, 404, { error: 'Reminder not found' });

  // Delete the completed reminder — no need to keep it around
  ctx.db.deleteReminder(id);

  // Promote the next pending reminder (now that the completed one is gone)
  const next = ctx.db.getTopReminder(reminder.agentName);
  if (next) {
    // Respect skipIfActive on promoted reminders (same check as ReminderDispatcher.tick)
    const agent = ctx.db.getAgent(next.agentName);
    const skipBecauseActive = next.skipIfActive && agent && agent.state === 'active';
    if (!skipBecauseActive) {
      const creator = next.createdBy || 'system';
      const envelope = `[reminder #${next.id} from ${creator}]: ${next.prompt}\nMark done when complete: collab reminder done ${next.id}`;
      const msg = ctx.db.enqueueMessage({
        sourceAgent: null,
        targetAgent: next.agentName,
        envelope,
      });
      ctx.db.updateReminderDelivery(next.id);
      ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: msg }));
      ctx.messageDispatcher.tryDeliver(next.agentName).catch((err) => {
        console.error(`[routes] Reminder promotion delivery failed for ${next.agentName}:`, (err as Error).message);
      });
    }
  }

  broadcastReminderUpdate(ctx);
  json(res, 200, { ok: true, deleted: id });
});

route('PATCH', '/api/reminders/:id', async (req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid reminder ID' });

  const body = await readJson(req);
  const opts: { prompt?: string; cadenceMinutes?: number; skipIfActive?: boolean } = {};
  if (typeof body.prompt === 'string') opts.prompt = body.prompt;
  if (typeof body.cadenceMinutes === 'number') opts.cadenceMinutes = body.cadenceMinutes;
  if (typeof body.skipIfActive === 'boolean') opts.skipIfActive = body.skipIfActive;

  try {
    const updated = ctx.db.updateReminder(id, opts);
    if (!updated) return json(res, 404, { error: 'Reminder not found' });
    broadcastReminderUpdate(ctx);
    json(res, 200, updated);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('DELETE', '/api/reminders/:id', async (_req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid reminder ID' });

  ctx.db.deleteReminder(id);
  broadcastReminderUpdate(ctx);
  json(res, 200, { ok: true });
});

route('POST', '/api/reminders/swap', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  // Accept both { a, b } (dashboard) and { id1, id2 } (API) field names
  const id1 = typeof body.a === 'number' ? body.a : body.id1;
  const id2 = typeof body.b === 'number' ? body.b : body.id2;
  if (typeof id1 !== 'number' || typeof id2 !== 'number') {
    return json(res, 400, { error: 'id1/id2 (or a/b) required' });
  }

  const ok = ctx.db.swapReminderOrder(id1 as number, id2 as number);
  if (!ok) return json(res, 400, { error: 'Swap failed — reminders must exist and belong to same agent' });

  broadcastReminderUpdate(ctx);
  json(res, 200, { ok: true });
});

// ── Accounts ──

route('GET', '/api/accounts', async (_req, res, _match, ctx) => {
  const accounts = ctx.accountStore.list();
  json(res, 200, accounts);
});

route('POST', '/api/accounts', async (req, res, _match, ctx) => {
  const body = await readBody(req);
  const name = body?.name;
  if (typeof name !== 'string' || name.length === 0) {
    return json(res, 400, { error: 'name is required' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return json(res, 400, { error: 'name must be alphanumeric with dashes/underscores' });
  }
  try {
    const account = ctx.accountStore.registerFromCurrent(name);
    json(res, 201, account);
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

route('DELETE', '/api/accounts/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const removed = ctx.accountStore.remove(name);
  if (!removed) return json(res, 404, { error: 'Account not found' });
  json(res, 200, { ok: true, deleted: name });
});

// ── Notify ──

route('POST', '/api/notify', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  const agent = body.agent as string | undefined;
  const message = body.message as string | undefined;
  const priority = (body.priority as string) ?? 'normal';
  if (!message) return json(res, 400, { error: 'message required' });

  const destinations = ctx.db.listDestinations().filter(d => d.enabled);
  let sent = 0;

  for (const dest of destinations) {
    const text = agent ? `[${agent}] ${message}` : message;
    try {
      if (dest.type === 'telegram') {
        const botToken = dest.config.botToken as string;
        const chatId = dest.config.chatId as string;
        const ok = await ctx.telegramDispatcher.send(botToken, chatId, text);
        if (ok) sent++;
      }
    } catch { /* best-effort per destination */ }
  }

  // Broadcast to dashboard for browser notifications
  ctx.wss.broadcast(JSON.stringify({
    type: 'notification',
    agent: agent ?? null,
    message,
    priority,
  }));

  json(res, 200, { ok: true, sent });
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

/** Insert a lifecycle event as a system message in the agent's chat thread and broadcast it. */
function broadcastLifecycleEvent(ctx: RouteContext, agentName: string, label: string): void {
  const msg = ctx.db.addDashboardMessage(agentName, 'from_agent', `[system] ${label}`, {
    topic: 'lifecycle',
    sourceAgent: 'system',
  });
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));
}

function validateAgentName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!NAME_RE.test(name)) return 'name must be 1-63 chars, start with alphanumeric, contain only [a-zA-Z0-9_-]';
  return null;
}

function replyHint(from: string, topic: string): string {
  return `reply with collab send ${from} --topic ${topic}`;
}

function buildReplyEnvelope(from: string, topic: string, message: string): string {
  return `[from: ${from}, ${replyHint(from, topic)}]: '${message}'`;
}

/**
 * Shared enqueue→link→broadcast→tryDeliver pipeline.
 *
 * Creates a dashboard message, enqueues a pending message, links them,
 * broadcasts both to the WebSocket, and fires async delivery.
 *
 * Returns the created dashboard message (with linked queueId/deliveryStatus)
 * and the pending queue entry so callers can reference their IDs.
 */
function enqueueAndDeliver(
  ctx: RouteContext,
  opts: {
    agentName: string;
    displayMessage: string;
    envelope: string;
    topic?: string;
    /** sourceAgent stored on the dashboard message (for display). */
    sourceAgent?: string | null;
    targetAgent?: string;
    /** sourceAgent stored on the queue entry. Defaults to opts.sourceAgent. */
    queueSourceAgent?: string | null;
    direction?: 'to_agent' | 'from_agent';
    /** Whether to broadcast the linked msg (with queueId/deliveryStatus) or the raw msg. Defaults to true. */
    broadcastLinked?: boolean;
  },
): { msg: DashboardMessage; pending: PendingMessage; linkedMsg: DashboardMessage & { queueId: number; deliveryStatus: string } } {
  const direction = opts.direction ?? 'to_agent';
  const deliverTo = opts.targetAgent ?? opts.agentName;

  const msg = ctx.db.addDashboardMessage(opts.agentName, direction, opts.displayMessage, {
    topic: opts.topic ?? undefined,
    sourceAgent: opts.sourceAgent ?? undefined,
    targetAgent: opts.targetAgent ?? undefined,
  });

  const queueSource = opts.queueSourceAgent !== undefined ? opts.queueSourceAgent : (opts.sourceAgent ?? null);
  const pending = ctx.db.enqueueMessage({
    sourceAgent: queueSource,
    targetAgent: deliverTo,
    envelope: opts.envelope,
  });

  ctx.db.linkDashboardMessageToQueue(msg.id, pending.id);

  const linkedMsg = { ...msg, queueId: pending.id, deliveryStatus: 'pending' as const };
  const broadcastLinked = opts.broadcastLinked ?? true;
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: broadcastLinked ? linkedMsg : msg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  ctx.messageDispatcher.tryDeliver(deliverTo).catch((err) => {
    console.error(`[routes] Delivery failed for ${deliverTo}:`, (err as Error).message);
  });

  return { msg, pending, linkedMsg };
}

function broadcastReminderUpdate(ctx: RouteContext): void {
  const reminders = ctx.db.listReminders();
  ctx.wss.broadcast(JSON.stringify({ type: 'reminder_update', reminders }));
}

function broadcastProxyUpdate(ctx: RouteContext): void {
  const proxies = enrichProxiesWithVersionMatch(ctx.db.listProxies());
  ctx.wss.broadcast(JSON.stringify({ type: 'proxy_update', proxies }));
}

function enrichProxiesWithVersionMatch(proxies: ProxyRegistration[]): ProxyRegistration[] {
  const orchestratorVersion = getVersion();
  return proxies.map(p => ({
    ...p,
    versionMatch: !!p.version && versionsMatch(p.version, orchestratorVersion),
  }));
}

/**
 * Factory for simple lifecycle route handlers that follow the pattern:
 * extract name → makeLifecycleCtx → call lifecycle fn → optionally broadcast → json 200/400.
 *
 * Keeps the handler inline noise to a single line per route.
 */
function lifecycleRoute(
  lifecycleFn: (ctx: LifecycleContext, name: string) => Promise<unknown>,
  opts?: { broadcast?: boolean | 'destroyed'; eventLabel?: string },
): RouteHandler {
  return async (_req, res, match, ctx) => {
    const name = match.pathname.groups['name']!;
    try {
      const lifecycleCtx = makeLifecycleCtx(ctx);
      await lifecycleFn(lifecycleCtx, name);
      if (opts?.broadcast === 'destroyed') {
        ctx.wss.broadcast(JSON.stringify({ type: 'agent_destroyed', name }));
      } else if (opts?.broadcast) {
        broadcastAgentUpdate(ctx, name);
      }
      if (opts?.eventLabel) {
        broadcastLifecycleEvent(ctx, name, opts.eventLabel);
      }
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  };
}

function makeLifecycleCtx(ctx: RouteContext): LifecycleContext {
  return {
    db: ctx.db,
    locks: ctx.locks,
    proxyDispatch: ctx.proxyDispatch,
    orchestratorHost: ctx.orchestratorHost,
    accountStore: ctx.accountStore,
  };
}

/**
 * Start Telegram long polling for a destination.
 * Routes inbound messages to agents via @agent-name prefix or to dashboard.
 * Exported for use in main.ts on startup.
 */
export function startTelegramPolling(ctx: RouteContext, dest: DestinationRecord): void {
  const botToken = dest.config.botToken as string;

  ctx.telegramDispatcher.startPolling(botToken, (incomingChatId: string, text: string) => {
    console.log(`[telegram] Inbound from chat ${incomingChatId}: ${text.slice(0, 100)}`);

    // Parse @agent-name prefixes — supports multiple: @agent1 @agent2 message
    const tagPattern = /^((?:@[a-zA-Z0-9_-]+\s+)+)([\s\S]+)$/;
    const tagMatch = text.match(tagPattern);
    const targetAgents: string[] = [];
    let messageText = text;

    if (tagMatch) {
      const tags = tagMatch[1]!.trim().split(/\s+/);
      for (const tag of tags) {
        if (tag.startsWith('@')) targetAgents.push(tag.slice(1));
      }
      messageText = tagMatch[2]!.trim();
    }

    if (targetAgents.length > 0) {
      const notFound: string[] = [];
      const delivered: string[] = [];

      for (const name of targetAgents) {
        const agent = ctx.db.getAgent(name);
        if (!agent) {
          notFound.push(name);
          continue;
        }

        enqueueAndDeliver(ctx, {
          agentName: name,
          displayMessage: messageText,
          envelope: messageText,
          topic: 'telegram',
          sourceAgent: `telegram:${dest.name}`,
        });
        delivered.push(name);
      }

      if (delivered.length > 0) {
        console.log(`[telegram] Routed message to: ${delivered.join(', ')}`);
      }
      if (notFound.length > 0) {
        ctx.telegramDispatcher.send(botToken, incomingChatId, `Agent(s) not found: ${notFound.join(', ')}`).catch(() => {});
      }
    } else {
      // No agent prefix — create a dashboard message visible under a virtual "telegram" thread
      const msg = ctx.db.addDashboardMessage('telegram', 'from_agent', messageText, {
        sourceAgent: `telegram:${dest.name}`,
      });
      ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));
      console.log('[telegram] Routed message to dashboard');
    }
  });
}
