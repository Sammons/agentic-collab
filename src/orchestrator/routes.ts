/**
 * HTTP API routes for the orchestrator.
 * Uses URLPattern for routing. No frameworks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from './database.ts';
import type { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentState, EngineType, ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { sanitizeMessage, generateMessageId } from '../shared/sanitize.ts';
import type { LockManager } from '../shared/lock.ts';
import {
  spawnAgent, resumeAgent, suspendAgent, destroyAgent,
  reloadAgent, interruptAgent, compactAgent, killAgent,
  type LifecycleContext,
} from './lifecycle.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';

export type RouteContext = {
  db: Database;
  wss: WebSocketServer;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  getDashboardHtml: () => string;
  orchestratorHost: string;
  orchestratorSecret: string | null;
};

type Route = {
  method: string;
  pattern: URLPattern;
  handler: (req: IncomingMessage, res: ServerResponse, match: URLPatternResult, ctx: RouteContext) => Promise<void>;
};

// Module-level routes array — populated once at import time, shared by all
// createRouter calls. This is intentional: routes are stateless handlers
// and the context is threaded per-request via RouteContext.
const routes: Route[] = [];

function route(method: string, pathname: string, handler: Route['handler']): void {
  routes.push({ method, pattern: new URLPattern({ pathname }), handler });
}

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
    proxyId: body.proxyId,
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

  // Broadcast both events
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  json(res, 202, { ok: true, msg, queueId: pending.id, status: 'pending' });
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
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
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

// ── Workstreams ──

route('GET', '/api/workstreams', async (_req, res, _match, ctx) => {
  const workstreams = ctx.db.listWorkstreams();
  json(res, 200, workstreams);
});

route('POST', '/api/workstreams', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.name || !body.goal) return json(res, 400, { error: 'name, goal required' });

  const ws = ctx.db.createWorkstream(body.name, body.goal, body.plan);
  if (body.agents && Array.isArray(body.agents)) {
    for (const agent of body.agents) {
      ctx.db.addAgentToWorkstream(body.name, agent);
    }
  }
  json(res, 201, ws);
});

// ── Agent Lifecycle Operations ──

route('POST', '/api/agents/:name/spawn', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    const agent = ctx.db.getAgent(name);
    if (!agent) return json(res, 404, { error: 'Agent not found' });

    const result = await spawnAgent(lifecycleCtx, {
      name,
      engine: agent.engine,
      model: (body.model as string | undefined) ?? agent.model ?? undefined,
      thinking: (body.thinking as string | undefined) ?? agent.thinking ?? undefined,
      cwd: (body.cwd as string | undefined) ?? agent.cwd,
      persona: (body.persona as string | undefined) ?? agent.persona ?? undefined,
      proxyId: (body.proxyId as string | undefined) ?? agent.proxyId ?? '',
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

// ── Route Matcher ──

export function createRouter(ctx: RouteContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Auth: state-mutating methods require Bearer token (GET and OPTIONS are exempt)
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      if (!authorize(ctx.orchestratorSecret, req)) {
        json(res, 401, { error: 'Unauthorized' });
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
  const token = header.slice(spaceIdx + 1);
  return scheme === 'Bearer' && token === secret;
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

