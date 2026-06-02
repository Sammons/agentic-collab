/**
 * HTTP API routes for the orchestrator.
 * Uses URLPattern for routing. No frameworks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, rmSync, statSync, createWriteStream, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { renderMarkdown, wrapInHtml, DOC_PAGES } from '../docs/render.ts';
import { hostname } from 'node:os';
import type { Database } from './database.ts';
import type { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentRecord, AgentState, DashboardMessage, DestinationRecord, EngineType, FileRecord, PendingMessage, ProxyCommand, ProxyResponse, ProxyRegistration } from '../shared/types.ts';
import type { TelegramDispatcher } from './telegram.ts';
import { sanitizeMessage, generateMessageId } from '../shared/sanitize.ts';
import { parseAddress } from '../shared/address.ts';
import { getVersion, versionsMatch } from '../shared/version.ts';
import type { LockManager } from '../shared/lock.ts';
import { getPersonasDir, parseFrontmatter, createPersonaAndAgent, syncSinglePersona, syncPersonasWithDiff, updateFrontmatterField, resolvePersonaPath, toHostPath, writeAgentTeams, serializeFrontmatter, structuredRenderable, splitFrontmatter, serializeCore, composeSystemPrompt } from './persona.ts';
import type { PersonaFrontmatter } from './persona.ts';
import {
  spawnAgent, resumeAgent, suspendAgent, destroyAgent,
  reloadAgent, recoverAgent, interruptAgent, compactAgent, killAgent,
  executeCustomButton, executeIndicatorAction,
  assembleLaunchCommand, computePeers, resolvePersonaFilePath,
  type LifecycleContext,
} from './lifecycle.ts';
import { buildUpsertOptsFromFrontmatter } from './field-registry.ts';
import { resolveEffectiveConfig } from './engine-config-resolver.ts';
import { getAdapter } from './adapters/index.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import { sessionName, ProxyUnavailableError } from '../shared/agent-entity.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { UsagePoller } from './usage-poller.ts';
import type { TopicDelivery } from './topic-delivery.ts';
import type { InstanceReaper } from './instance-reaper.ts';
import type { ApprovalService } from './approvals.ts';
import type { BootReconciler, ProxyReconnectHandler, OrphanedWorktreeSweep } from './recovery.ts';
import { transcribe as whisperTranscribe, type WhisperOptions } from './whisper-stt.ts';

/** Validates agent and persona names: 1-63 chars, alphanumeric start, [a-zA-Z0-9_-]. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/**
 * RFC-007 launch-preview tokens. «PERSONA» (guillemets) stands in for the persona
 * body — visually distinct, shell-safe inside single-quoted --append-system-prompt,
 * and not a real template/shell token (distinct from $PERSONA_PROMPT, which is the
 * WHOLE composed prompt). PREVIEW_SESSION_ID is an illustrative placeholder UUID.
 */
const PERSONA_PLACEHOLDER = '«PERSONA»';
const PREVIEW_SESSION_ID = '00000000-0000-0000-0000-000000000000';

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
  /**
   * Whisper batch STT config. When set, dashboard can record PTT clips
   * locally and POST them to /api/voice/transcribe for one-shot
   * transcription. Coexists with ElevenLabs realtime; the dashboard
   * picks the path per `defaultSttProvider`.
   */
  whisperOpts?: WhisperOptions | null;
  /**
   * Which STT provider the dashboard should use by default. Computed
   * from STT_PROVIDER env + which provider configs are present.
   */
  defaultSttProvider?: 'elevenlabs' | 'whisper' | null;
  accountStore: import('./accounts.ts').AccountStore;
  pagesDir: string;
  storesDir: string;
  filesDir: string;
  telegramDispatcher: TelegramDispatcher;
  /**
   * v3 Q3 ephemeral surface — optional so test fixtures that don't exercise
   * topic delivery don't need to construct one. Production `main.ts` always
   * populates both. Endpoints that depend on these return 503 when absent.
   */
  topicDelivery?: TopicDelivery;
  instanceReaper?: InstanceReaper;
  /**
   * v3 Q5 approvals — optional so test fixtures that don't exercise the
   * approval surface don't need to construct one. Production `main.ts`
   * always populates it. Endpoints return 503 when absent.
   */
  approvals?: ApprovalService;
  /**
   * v3 Q8 crash recovery — optional. The boot reconciler runs once at
   * startup (before `server.listen`) so it's not exposed via routes; the
   * reconnect handler is invoked from `/api/proxy/register` to fail
   * orphaned instances on a freshly-returning proxy; the orphan sweep is
   * driven by an interval, not a route. Populated by production `main.ts`.
   */
  recovery?: {
    reconciler: BootReconciler;
    reconnectHandler: ProxyReconnectHandler;
    orphanSweep: OrphanedWorktreeSweep;
  };
  /** Reload personas from disk; populated alongside `topicDelivery`. */
  reloadPersonas?: () => { synced: number; created: string[]; updated: string[]; skipped: string[] };
};

/**
 * Resolve the proxy ID for an agent at spawn/resume time.
 *
 * Priority (RFC-003 §2):
 *   1. explicit body override (one-shot operator escape hatch)
 *   2. persona pin (proxyPin) — authoritative; throws if not registered (fail-loud)
 *   3. existing runtime placement (proxyId)
 *   4. any registered proxy (legacy fallback for un-pinned agents)
 */
function resolveProxyId(
  ctx: RouteContext,
  agent: { name: string; proxyId: string | null; proxyPin: string | null },
  bodyProxyId?: string,
): string {
  // 1. Explicit override from request body (does not persist over a pin — see §2b)
  if (bodyProxyId) return bodyProxyId;

  // 2. Persona pin is authoritative; fail loud if its proxy isn't registered.
  if (agent.proxyPin) {
    const registered = ctx.db.listProxies().some((p) => p.proxyId === agent.proxyPin);
    if (!registered) {
      throw new ProxyUnavailableError(agent.name, agent.proxyPin);
    }
    return agent.proxyPin;
  }

  // 3. Already assigned (e.g. from a previous spawn)
  if (agent.proxyId) return agent.proxyId;

  // 4. Fall back to any registered proxy
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

// ── Dashboard asset cache (module scope so we can warm at startup) ──

const ASSET_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8', // browser-native type stripping
  '.css': 'text/css; charset=utf-8',
};

type AssetCacheEntry = { mtimeMs: number; body: string; etag: string; contentType: string };
const assetCache = new Map<string, AssetCacheEntry>();

function loadAssetEntry(fullPath: string, ext: string, contentType: string): AssetCacheEntry {
  const stat = statSync(fullPath);
  const existing = assetCache.get(fullPath);
  if (existing && existing.mtimeMs === stat.mtimeMs) return existing;
  let body = readFileSync(fullPath, 'utf-8');
  if (ext === '.ts') body = stripTypeScriptTypes(body);
  const entry: AssetCacheEntry = {
    mtimeMs: stat.mtimeMs,
    body,
    etag: `W/"${stat.mtimeMs}-${stat.size}"`,
    contentType,
  };
  assetCache.set(fullPath, entry);
  return entry;
}

/**
 * Pre-load + type-strip every dashboard asset at startup so the first browser
 * request never pays the strip cost. Walks src/dashboard recursively and
 * primes the cache for any file with a supported extension.
 *
 * Safe to call multiple times — entries are skipped when mtime is unchanged.
 * Errors on individual files are logged but don't abort the walk.
 */
export function warmDashboardAssets(): void {
  const dashboardDir = join(import.meta.dirname!, '..', 'dashboard');
  const t0 = Date.now();
  let count = 0;
  const walk = (dir: string): void => {
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      const ext = ent.name.slice(ent.name.lastIndexOf('.'));
      const contentType = ASSET_TYPES[ext];
      if (!contentType) continue;
      try {
        loadAssetEntry(full, ext, contentType);
        count++;
      } catch (err) {
        console.warn(`[warm-assets] skip ${full}: ${(err as Error).message}`);
      }
    }
  };
  walk(dashboardDir);
  console.log(`[warm-assets] cached ${count} dashboard files in ${Date.now() - t0}ms`);
}

function buildRoutes(): Route[] {
  const routes: Route[] = [];
  const route = (method: string, pathname: string, handler: RouteHandler) => {
    routes.push({ method, pattern: new URLPattern({ pathname }), handler });
  };

// ── Dashboard ──

// Apex redirect — bare host hits /dashboard.
route('GET', '/', async (_req, res) => {
  res.writeHead(302, { location: '/dashboard' });
  res.end();
});

route('GET', '/dashboard', async (_req, res, _match, ctx) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
  });
  res.end(ctx.getDashboardHtml());
});

route('GET', '/filter-test', async (_req, res) => {
  const html = await import('node:fs').then(fs =>
    fs.promises.readFile(join(import.meta.dirname!, '..', 'dashboard', 'filter-test.html'), 'utf-8')
  );
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(html);
});

route('GET', '/dashboard/assets/:path+', async (req, res, match) => {
  const filePath = match.pathname.groups['path'] ?? '';
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const contentType = ASSET_TYPES[ext];
  if (filePath.includes('..') || !contentType) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  try {
    const fullPath = join(import.meta.dirname!, '..', 'dashboard', filePath);
    const entry = loadAssetEntry(fullPath, ext, contentType);

    // Conditional GET — return 304 if the browser already has this version.
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, {
        'etag': entry.etag,
        // Tell intermediaries to revalidate but allow the browser to cache.
        'cache-control': 'no-cache',
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': contentType,
      'etag': entry.etag,
      'cache-control': 'no-cache',
    });
    res.end(entry.body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// Serve shared/ for dashboard imports that reference ../shared/
// Browser resolves ../shared/ from /dashboard/assets/ to /dashboard/shared/
route('GET', '/dashboard/shared/:path+', async (req, res, match) => {
  const filePath = match.pathname.groups['path'] ?? '';
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const contentType = ASSET_TYPES[ext];
  if (filePath.includes('..') || !contentType) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  try {
    const fullPath = join(import.meta.dirname!, '..', 'shared', filePath);
    const entry = loadAssetEntry(fullPath, ext, contentType);
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { 'etag': entry.etag, 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': contentType, 'etag': entry.etag, 'cache-control': 'no-cache' });
    res.end(entry.body);
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
    // Custom engine: must exist in engine_configs DB and reference a valid underlying engine.
    const config = ctx.db.getEngineConfig(resolvedEngine);
    if (!config || !VALID_ENGINES.has(config.engine)) {
      return json(res, 400, { error: `engine must be claude/codex/opencode or a custom engine name from engine_configs (got "${resolvedEngine}")` });
    }
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
    proxyPin: body.proxy,
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
    if (body.proxy) fmLines.push(`proxy: ${body.proxy}`);
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

/**
 * Bridge a bare-name send (no `topic:`/`agent:` prefix) onto an ephemeral
 * agent template when the name is NOT a live persistent agent. @mentioning an
 * ephemeral template (e.g. `@agentic-collab-lead-ephemeral`) — and the
 * equivalent `collab send <template>` — must spawn an instance via the topic
 * pipeline rather than 404 against the `agents` table.
 *
 * Returns `{ handled: false }` when the name is not an ephemeral template (so
 * the caller keeps its existing 404 behaviour). Persistent templates are NOT
 * topic-addressable and also return `{ handled: false }`. The payload passed
 * through is the RAW message (matching the `topic:` path), never the reply
 * envelope used for persistent-agent enqueue.
 */
async function tryRouteToEphemeralTemplate(
  ctx: RouteContext,
  opts: {
    name: string;
    requestedTopic: string | null;
    payload: string;
    replyToAddr: string | null;
    inReplyTo: string | null;
  },
): Promise<{ handled: false } | { handled: true; status: number; body: unknown }> {
  const tmpl = ctx.db.getAgentTemplate(opts.name);
  if (!tmpl) return { handled: false };
  // Persistent templates are not addressable through the topic pipeline.
  if (tmpl.persistent) return { handled: false };
  if (!ctx.topicDelivery) {
    return { handled: true, status: 503, body: { error: 'topic delivery not configured' } };
  }

  // Resolve which declared topic to spawn against.
  const declared = ctx.db.getTopicsForTemplate(opts.name).map((t) => t.name);
  let topicName: string;
  if (opts.requestedTopic && declared.includes(opts.requestedTopic)) {
    topicName = opts.requestedTopic;
  } else if (declared.length === 1) {
    topicName = declared[0]!;
  } else {
    return {
      handled: true,
      status: 400,
      body: {
        error: `"${opts.name}" is an ephemeral template; specify a declared topic with #<topic>`,
        template: opts.name,
        topics: declared,
      },
    };
  }

  const result = await ctx.topicDelivery.publish({
    agentTemplate: opts.name,
    topicName,
    payload: opts.payload,
    replyToAddr: opts.replyToAddr,
    inReplyTo: opts.inReplyTo,
  });
  if (!result.ok) {
    return { handled: true, status: 400, body: { error: result.reason } };
  }
  return {
    handled: true,
    status: 202,
    body: { ok: true, queueId: result.queueId, status: 'queued', spawnedTemplate: opts.name, topic: topicName },
  };
}

route('POST', '/api/agents/send', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.from || !body.to || !body.message || !body.topic) {
    return json(res, 400, { error: 'from, to, message, topic required' });
  }

  // Q1: address-prefix routing. `topic:` is wired through ctx.topicDelivery
  // (Q3); `agent-instance:` dispatches synchronously through the message
  // dispatcher's `deliverToInstance` (Q3 — never persists to pending_messages).
  // `approval:` is wired by Q5.
  const addr = parseAddress(body.to);
  if (addr.class === 'malformed') {
    return json(res, 400, { error: 'malformed address', reason: addr.reason });
  }
  if (addr.class === 'topic') {
    if (!ctx.topicDelivery) {
      return json(res, 503, { error: 'topic delivery not configured' });
    }
    const payload = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? {});
    const result = await ctx.topicDelivery.publish({
      agentTemplate: addr.template,
      topicName: addr.topic,
      payload,
      replyToAddr: typeof body.from === 'string' ? body.from : null,
      inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : null,
    });
    if (!result.ok) {
      return json(res, 400, { error: result.reason });
    }
    return json(res, 202, { ok: true, queueId: result.queueId, status: 'queued' });
  }
  if (addr.class === 'approval') {
    // approval:<channel> is a categorisation, not a sendable address. The
    // v3 spec is explicit: approvals are CRUD, not enqueue — `send` cannot
    // auto-create approvals (Q5).
    return json(res, 400, {
      error: 'approval channel is not a sendable address; use POST /api/approvals to create an approval',
      class: 'approval',
      channel: addr.channel,
    });
  }
  if (addr.class === 'agent-instance') {
    // Sync deliver via paste. Never persists into pending_messages.
    const text = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? {});
    const deliveryResult = await ctx.messageDispatcher.deliverToInstance(addr.instanceId, text);
    if (!deliveryResult.ok) {
      return json(res, 503, { error: 'instance not deliverable', reason: deliveryResult.reason, ...(deliveryResult.error ? { details: deliveryResult.error } : {}) });
    }
    return json(res, 200, { ok: true });
  }
  // addr.class === 'agent' — use bare name for storage / lookup.
  body.to = addr.name;

  // An ephemeral template is authoritative over any (possibly stale shadow)
  // `agents` row of the same name: a name backed by a non-persistent template
  // must spawn an instance, never deliver to a leftover persistent row.
  // reconcile-roots only clears shadows in void/suspended/failed states and
  // not before the server accepts requests, so we cannot rely on getAgent()
  // returning null — check the template first.
  const routed = await tryRouteToEphemeralTemplate(ctx, {
    name: body.to as string,
    requestedTopic: typeof body.topic === 'string' ? body.topic : null,
    payload: typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? {}),
    replyToAddr: typeof body.from === 'string' ? body.from : null,
    inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : null,
  });
  if (routed.handled) return json(res, routed.status, routed.body);

  const target = ctx.db.getAgent(body.to);
  if (!target) return json(res, 404, { error: `Target agent "${body.to}" not found` });
  if (target.state === 'void') {
    return json(res, 400, { error: `Target agent "${body.to}" is in void state (not spawned). Spawn it first with: collab spawn ${body.to}` });
  }

  const messageId = generateMessageId();
  const sanitized = sanitizeMessage(body.message);
  const topicStr = body.topic as string;
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((id: unknown) => typeof id === 'string') : undefined;

  // Format envelope with topic (include file references if present)
  const envelope = buildReplyEnvelope(body.from as string, topicStr, sanitized, fileIds);

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
    fileIds,
  });
  ctx.db.linkDashboardMessageToQueue(senderMsg.id, pending.id);

  // Store in dashboard_messages for receiver thread (to_agent direction — message going to agent)
  const receiverMsg = ctx.db.addDashboardMessage(body.to as string, 'to_agent', sanitized, {
    topic: topicStr,
    sourceAgent: body.from as string,
    targetAgent: body.to as string,
    fileIds,
  });
  ctx.db.linkDashboardMessageToQueue(receiverMsg.id, pending.id);

  // Log routing events
  ctx.db.logEvent(body.from as string, 'message_queued', messageId, { to: body.to, queueId: pending.id });
  ctx.db.logEvent(body.to as string, 'message_queued', messageId, { from: body.from, queueId: pending.id });

  // Broadcast both messages + queue update to dashboard (filtered by subscription)
  const linkedSenderMsg = { ...senderMsg, queueId: pending.id, deliveryStatus: 'pending' } as DashboardMessage;
  const linkedReceiverMsg = { ...receiverMsg, queueId: pending.id, deliveryStatus: 'pending' } as DashboardMessage;
  broadcastMessage(ctx, linkedSenderMsg);
  broadcastMessage(ctx, linkedReceiverMsg);
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

  // Q1: address-prefix routing on body.agent. Q3 wires `topic:` (through
  // ctx.topicDelivery) and `agent-instance:` (through deliverToInstance).
  const dashAddr = parseAddress(body.agent);
  if (dashAddr.class === 'malformed') {
    return json(res, 400, { error: 'malformed address', reason: dashAddr.reason });
  }
  if (dashAddr.class === 'topic') {
    if (!ctx.topicDelivery) {
      return json(res, 503, { error: 'topic delivery not configured' });
    }
    const payload = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? {});
    const result = await ctx.topicDelivery.publish({
      agentTemplate: dashAddr.template,
      topicName: dashAddr.topic,
      payload,
      replyToAddr: 'dashboard',
      inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : null,
    });
    if (!result.ok) {
      return json(res, 400, { error: result.reason });
    }
    return json(res, 202, { ok: true, queueId: result.queueId, status: 'queued' });
  }
  if (dashAddr.class === 'approval') {
    // approval:<channel> is a categorisation, not a sendable address.
    // (See `/api/agents/send` above for the rationale.)
    return json(res, 400, {
      error: 'approval channel is not a sendable address; use POST /api/approvals to create an approval',
      class: 'approval',
      channel: dashAddr.channel,
    });
  }
  if (dashAddr.class === 'agent-instance') {
    const text = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? {});
    const deliveryResult = await ctx.messageDispatcher.deliverToInstance(dashAddr.instanceId, text);
    if (!deliveryResult.ok) {
      return json(res, 503, { error: 'instance not deliverable', reason: deliveryResult.reason, ...(deliveryResult.error ? { details: deliveryResult.error } : {}) });
    }
    return json(res, 200, { ok: true });
  }
  body.agent = dashAddr.name;

  // An ephemeral template is authoritative over any (possibly stale shadow)
  // `agents` row of the same name — see the matching note in /api/agents/send.
  // Checked before getAgent() so a live-state shadow or the boot-window race
  // can't silently enqueue the mention to a dead persistent agent.
  const routed = await tryRouteToEphemeralTemplate(ctx, {
    name: body.agent as string,
    requestedTopic: typeof body.topic === 'string' ? body.topic : null,
    payload: typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? {}),
    replyToAddr: 'dashboard',
    inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : null,
  });
  if (routed.handled) return json(res, routed.status, routed.body);

  const agent = ctx.db.getAgent(body.agent);
  if (!agent) return json(res, 404, { error: `Agent "${body.agent}" not found` });

  const sanitized = sanitizeMessage(body.message);
  const topicStr = body.topic as string;
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((id: unknown) => typeof id === 'string') : undefined;

  const envelope = buildReplyEnvelope('dashboard', topicStr, sanitized, fileIds);
  const { msg, pending } = enqueueAndDeliver(ctx, {
    agentName: body.agent as string,
    displayMessage: sanitized,
    envelope,
    topic: topicStr,
    sourceAgent: 'dashboard',
    targetAgent: body.agent as string,
    queueSourceAgent: null,
    fileIds,
  });

  // Auto-create reply reminder if requested
  if (body.replyReminder) {
    const cadence = typeof body.replyReminder === 'number' ? body.replyReminder : 30;
    const prompt = `[reply-reminder] topic: ${topicStr} | from: dashboard | "${sanitized}" — Please respond if you haven't already.`;
    ctx.db.createReminder({ agentName: body.agent as string, createdBy: 'dashboard', prompt, cadenceMinutes: Math.max(cadence, 5) });
  }

  json(res, 202, { ok: true, msg, queueId: pending.id, status: 'pending' });
});

// ── v3 Q3: topic publish + instance complete + persona reload ──

route('POST', '/api/topics/publish', async (req, res, _match, ctx) => {
  if (!ctx.topicDelivery) {
    return json(res, 503, { error: 'topic delivery not configured' });
  }
  const body = await readJson(req);
  if (typeof body.agentTemplate !== 'string' || typeof body.topicName !== 'string') {
    return json(res, 400, { error: 'agentTemplate and topicName required' });
  }
  const payload = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload ?? {});
  const result = await ctx.topicDelivery.publish({
    agentTemplate: body.agentTemplate,
    topicName: body.topicName,
    payload,
    replyToAddr: typeof body.replyToAddr === 'string' ? body.replyToAddr : null,
    inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : null,
  });
  if (!result.ok) {
    return json(res, 400, { error: result.reason });
  }
  json(res, 202, { ok: true, queueId: result.queueId, templateId: result.templateId, topicName: result.topicName });
});

route('POST', '/api/instances/:id/complete', async (_req, res, match, ctx) => {
  if (!ctx.instanceReaper) {
    return json(res, 503, { error: 'instance reaper not configured' });
  }
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'instance id required' });
  const instance = ctx.db.getAgentInstance(id);
  if (!instance) {
    return json(res, 404, { error: 'unknown instance' });
  }
  if (instance.state === 'completed' || instance.state === 'failed') {
    return json(res, 409, { error: 'already terminal', state: instance.state });
  }
  // Wake — does not block on result.
  ctx.instanceReaper.wake(id).catch((err) => {
    console.error(`[routes] reaper.wake(${id}) failed:`, (err as Error).message);
  });
  json(res, 202, { ok: true });
});

// ── RFC-006 Q2: ephemeral instance read surface (GET — Bearer-exempt) ──

// List a template's instances, live + past, newest first. Backed by
// `idx_agent_instances_template`. Returns the camelCased AgentInstanceRow
// fields the dashboard renders (id, suffix, state, started/completed, etc.).
route('GET', '/api/agent-templates/:id/instances', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'template id required' });
  const instances = ctx.db.listInstancesForTemplate(id).map((i) => ({
    id: i.id,
    suffix: i.suffix,
    state: i.state,
    startedAt: i.startedAt,
    completedAt: i.completedAt,
    failureReason: i.failureReason,
    instanceAddr: i.instanceAddr,
    tmuxSession: i.tmuxSession,
    proxyId: i.proxyId,
  }));
  json(res, 200, { instances });
});

// Peek a live instance's tmux pane. Mirrors the agent peek handler. A past /
// session-less instance returns 200 `{live:false}` (NOT a 500), so the watch
// surface degrades gracefully. Uses the STORED `tmuxSession` (sliced to 200
// chars at spawn, `topic-delivery.ts:187`) — never reconstructed.
route('GET', '/api/instances/:id/peek', async (req, res, match, ctx) => {
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'instance id required' });
  const inst = ctx.db.getInstance(id);
  if (!inst) { json(res, 404, { error: `Instance "${id}" not found` }); return; }

  const isLive = (inst.state === 'spawning' || inst.state === 'running') && !!inst.tmuxSession;
  if (!isLive) { json(res, 200, { live: false }); return; }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const linesParam = url.searchParams.get('lines');
  const lines = linesParam ? Math.max(1, Math.min(parseInt(linesParam, 10) || 50, 1000)) : 50;

  const result = await ctx.proxyDispatch(inst.proxyId, {
    action: 'capture',
    sessionName: inst.tmuxSession,
    lines,
  });
  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { live: true, output: result.data });
});

// Read a single instance + its message/reply/status file contents (the MVP
// past-instance view — RFC-006 Proposal.5). File reads tolerate missing/empty
// paths; a completed instance whose IPC dir was reaped simply yields nulls.
route('GET', '/api/instances/:id', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'instance id required' });
  const instance = ctx.db.getInstance(id);
  if (!instance) { json(res, 404, { error: `Instance "${id}" not found` }); return; }

  const readFileOrNull = (path: string | null | undefined): string | null => {
    if (!path) return null;
    try { return readFileSync(path, 'utf-8'); } catch { return null; }
  };

  json(res, 200, {
    instance,
    message: readFileOrNull(instance.messagePath),
    reply: readFileOrNull(instance.replyPath),
    status: readFileOrNull(instance.statusPath),
  });
});

route('POST', '/api/personas/reload', async (_req, res, _match, ctx) => {
  if (!ctx.reloadPersonas) {
    return json(res, 503, { error: 'persona reload not configured' });
  }
  try {
    const diff = ctx.reloadPersonas();
    json(res, 200, { ok: true, ...diff });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

// ── v3 Q5: approvals CRUD ──
//
// Approvals are first-class records categorised by `channel` (the
// `approval:<channel>` address class). They are *not* a sendable address —
// `/api/agents/send` and `/api/dashboard/send` return 400 for `approval:`
// addresses with a pointer back to POST /api/approvals.

route('POST', '/api/approvals', async (req, res, _match, ctx) => {
  if (!ctx.approvals) return json(res, 503, { error: 'approvals not configured' });
  const body = await readJson(req);
  if (typeof body.requesterAddr !== 'string' || typeof body.channel !== 'string') {
    return json(res, 400, { error: 'requesterAddr and channel required' });
  }
  const payload = typeof body.payload === 'string'
    ? body.payload
    : JSON.stringify(body.payload ?? {});
  const result = ctx.approvals.create({
    requesterAddr: body.requesterAddr,
    channel: body.channel,
    payload,
  });
  if (!result.ok) return json(res, 400, { error: result.reason });
  return json(res, 201, result.approval);
});

route('GET', '/api/approvals/:id', async (_req, res, match, ctx) => {
  if (!ctx.approvals) return json(res, 503, { error: 'approvals not configured' });
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'approval id required' });
  const row = ctx.db.getApproval(id);
  if (!row) return json(res, 404, { error: 'approval not found' });
  return json(res, 200, row);
});

// Both `channel` and `state` are optional and AND'd together when present.
// Omitting `channel` returns the cross-channel feed used by the dashboard
// inbox (Q9). `state` is validated against the canonical enum either way.
route('GET', '/api/approvals', async (req, res, _match, ctx) => {
  if (!ctx.approvals) return json(res, 503, { error: 'approvals not configured' });
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const channel = url.searchParams.get('channel');
  const stateRaw = url.searchParams.get('state') ?? undefined;
  const allowed = ['pending', 'approved', 'rejected', 'amended', 'withdrawn'];
  if (stateRaw && !allowed.includes(stateRaw)) {
    return json(res, 400, { error: `state must be one of ${allowed.join('|')}` });
  }
  const state = stateRaw as 'pending' | 'approved' | 'rejected' | 'amended' | 'withdrawn' | undefined;
  const rows = channel
    ? ctx.db.listApprovalsByChannel(channel, state)
    : ctx.db.listApprovals(state ? { state } : {});
  return json(res, 200, rows);
});

route('POST', '/api/approvals/:id/set', async (req, res, match, ctx) => {
  if (!ctx.approvals) return json(res, 503, { error: 'approvals not configured' });
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'approval id required' });
  const body = await readJson(req);
  if (typeof body.state !== 'string') return json(res, 400, { error: 'state required' });
  if (body.state !== 'approved' && body.state !== 'rejected' && body.state !== 'amended') {
    return json(res, 400, { error: 'state must be approved|rejected|amended' });
  }
  const payload = typeof body.payload === 'string'
    ? body.payload
    : body.payload != null ? JSON.stringify(body.payload) : null;
  // `amended` rewrites the active payload; rejecting the call here keeps
  // the audit trail honest. Otherwise the route silently leaves the prior
  // payload in place while the row's state column claims "amended".
  if (body.state === 'amended' && (payload === null || payload === '')) {
    return json(res, 400, { error: 'amended state requires --payload' });
  }
  const result = await ctx.approvals.setState(id, body.state, {
    decidedBy: typeof body.decidedBy === 'string' ? body.decidedBy : null,
    payload,
  });
  if (!result.ok) {
    if (result.reason === 'not-found') return json(res, 404, { error: 'approval not found' });
    if (result.reason === 'already-terminal') return json(res, 409, { error: 'approval is already terminal' });
    return json(res, 400, { error: result.reason });
  }
  return json(res, 200, result.approval);
});

route('POST', '/api/approvals/:id/withdraw', async (req, res, match, ctx) => {
  if (!ctx.approvals) return json(res, 503, { error: 'approvals not configured' });
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'approval id required' });
  const body = await readJson(req);
  if (typeof body.requesterAddr !== 'string') {
    return json(res, 400, { error: 'requesterAddr required' });
  }
  const result = await ctx.approvals.withdraw(id, body.requesterAddr);
  if (!result.ok) {
    if (result.reason === 'not-found') return json(res, 404, { error: 'approval not found' });
    if (result.reason === 'not-creator') return json(res, 403, { error: 'only the creator may withdraw' });
    if (result.reason === 'not-pending') return json(res, 409, { error: 'approval is not pending' });
    return json(res, 400, { error: result.reason });
  }
  return json(res, 200, result.approval);
});

// Non-blocking single read — per spec ("plain polling, not long-poll").
// Returns the current row immediately (200) regardless of state. Callers
// (`collab approval await`, dashboard inbox) poll client-side at whatever
// interval suits them. The endpoint is retained for path-compatibility
// with earlier drafts; functionally identical to GET /api/approvals/:id.
route('GET', '/api/approvals/:id/await', async (_req, res, match, ctx) => {
  if (!ctx.approvals) return json(res, 503, { error: 'approvals not configured' });
  const id = match.pathname.groups['id'];
  if (!id) return json(res, 400, { error: 'approval id required' });
  const row = ctx.db.getApproval(id);
  if (!row) return json(res, 404, { error: 'approval not found' });
  return json(res, 200, row);
});

route('POST', '/api/dashboard/upload', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agentName = url.searchParams.get('agent');
  const filename = url.searchParams.get('filename');
  const userMessage = url.searchParams.get('message');
  const topic = url.searchParams.get('topic') || 'file-upload';

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

  // Silent upload: file lands on disk but no message or agent notification.
  // User can later send a message mentioning the file if desired.
  json(res, 200, { ok: true, path: writtenPath, size: fileSize });
});

route('POST', '/api/dashboard/reply', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  if (!body.agent || !body.message || !body.topic) {
    return json(res, 400, { error: 'agent, message, topic required' });
  }

  const sanitized = sanitizeMessage(body.message);
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((id: unknown) => typeof id === 'string') : undefined;
  const msg = ctx.db.addDashboardMessage(body.agent, 'from_agent', sanitized, {
    topic: body.topic as string,
    sourceAgent: body.agent as string,
    fileIds,
  });

  // Broadcast to dashboard WebSocket (filtered by subscription)
  broadcastMessage(ctx, msg);

  json(res, 200, { ok: true, msg });
});

route('GET', '/api/dashboard/threads', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  // Optional limit per agent; default matches init payload cap.
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam !== null ? Math.max(0, parseInt(limitParam, 10) || 0) : 200;
  const threads = ctx.db.getDashboardThreads(agent, limit);
  json(res, 200, threads);
});

// Pagination for the dashboard chat "Load older" affordance. Returns up to
// `limit` messages for `agent` strictly older than `beforeId` (exclusive),
// in chronological order so the client can prepend them in place.
route('GET', '/api/dashboard/threads/:agent/older', async (req, res, match, ctx) => {
  const agent = decodeURIComponent(match.pathname.groups['agent'] ?? '');
  if (!agent) return json(res, 400, { error: 'agent required' });
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const beforeId = url.searchParams.get('beforeId');
  const before = beforeId !== null && beforeId !== '' ? parseInt(beforeId, 10) : null;
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(500, Math.max(1, limitParam ? parseInt(limitParam, 10) : 200));
  const msgs = ctx.db.getOlderMessages(agent, Number.isFinite(before as number) ? before : null, limit);
  json(res, 200, { messages: msgs, agent });
});

route('GET', '/api/dashboard/messages/search', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json(res, 400, { error: 'q (search query) required' });
  const agent = url.searchParams.get('agent') || undefined;
  const results = ctx.db.searchMessages(q, agent);
  json(res, 200, results);
});

// Paginated merged message feed for v3 dashboard virtual scrolling.
// Server handles merge/sort across agents; client renders visible window only.
route('GET', '/api/dashboard/messages/feed', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  // agents: comma-separated list of agent names (empty = all)
  const agentsParam = url.searchParams.get('agents') ?? '';
  const agents = agentsParam ? agentsParam.split(',').filter(Boolean) : [];

  // limit: max messages to return (default 50, max 200)
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(200, Math.max(1, limitParam ? parseInt(limitParam, 10) : 50));

  // Pagination cursors (mutually exclusive)
  const beforeParam = url.searchParams.get('before');
  const afterParam = url.searchParams.get('after');
  const beforeId = beforeParam ? parseInt(beforeParam, 10) : undefined;
  const afterId = afterParam ? parseInt(afterParam, 10) : undefined;

  const result = ctx.db.getMergedMessages(agents, limit, beforeId, afterId);

  // Include total count for scroll bar sizing (cached, cheap query)
  const totalCount = ctx.db.getMessageCount(agents);

  json(res, 200, {
    messages: result.messages,
    hasMore: result.hasMore,
    hasNewer: result.hasNewer,
    totalCount,
  });
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

  // v3 Q8: every live `agent_instances` row on this proxy died when the
  // proxy died. Mark them failed (best-effort cleanup) — running this AFTER
  // `recoverFailedAgents` so persistent agents that survived in tmux can
  // still self-heal first. Fire-and-forget; don't block the registration
  // response (the response was already sent above).
  if (ctx.recovery) {
    const pid = body.proxyId as string;
    ctx.recovery.reconnectHandler.onProxyRegister(pid).catch((err) => {
      console.error(`[proxy-register] Instance reconcile failed for ${pid}:`, err);
    });
  }
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

// ── Files (orchestrator-native file registry) ──

const FILE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Derive MIME type from filename extension. Returns application/octet-stream
 * for unknown extensions.
 */
function fileMime(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  const MIME_MAP: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
  };
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * Upload a file. Accepts multipart/form-data or raw octet-stream.
 * Files are stored in `$DATA_DIR/files/<uuid>.<ext>`.
 * Returns the FileRecord with metadata.
 */
route('POST', '/api/files', async (req, res, _match, ctx) => {
  // Ensure files directory exists
  mkdirSync(ctx.filesDir, { recursive: true });

  const contentType = req.headers['content-type'] ?? '';
  let filename: string | null = null;
  let fileBuffer: Buffer | null = null;

  if (contentType.startsWith('multipart/form-data')) {
    // Parse multipart — extract first file field
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
      return json(res, 400, { error: 'Missing multipart boundary' });
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > FILE_MAX_BYTES) {
        return json(res, 413, { error: `File exceeds ${FILE_MAX_BYTES / 1024 / 1024}MB limit` });
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Simple multipart parser — find the first file field
    const boundaryBytes = Buffer.from(`--${boundary}`);
    const parts = splitBuffer(body, boundaryBytes);
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toString('utf-8');
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (filenameMatch) {
        filename = filenameMatch[1]!;
        // Content starts after \r\n\r\n, ends before trailing \r\n
        const content = part.slice(headerEnd + 4);
        // Trim trailing \r\n if present
        if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
          fileBuffer = content.slice(0, content.length - 2);
        } else {
          fileBuffer = content;
        }
        break;
      }
    }

    if (!filename || !fileBuffer) {
      return json(res, 400, { error: 'No file found in multipart body' });
    }
  } else {
    // Raw octet-stream upload — filename from query param or header
    const url = new URL(req.url!, `http://${req.headers.host}`);
    filename = url.searchParams.get('filename') ?? (req.headers['x-filename'] as string | undefined) ?? null;

    if (!filename) {
      return json(res, 400, { error: 'filename required (query param or X-Filename header)' });
    }

    // Stream to a temp buffer (with size check)
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > FILE_MAX_BYTES) {
        return json(res, 413, { error: `File exceeds ${FILE_MAX_BYTES / 1024 / 1024}MB limit` });
      }
      chunks.push(chunk as Buffer);
    }
    fileBuffer = Buffer.concat(chunks);
  }

  // Validate filename
  if (filename.includes('/') || filename.includes('\\') ||
      filename === '.' || filename === '..' ||
      filename.includes('\0') || filename.length > 255) {
    return json(res, 400, { error: 'Invalid filename' });
  }

  // Generate UUID and preserve extension
  const id = randomUUID();
  const ext = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '';
  const storedFilename = `${id}${ext}`;
  const storedPath = join(ctx.filesDir, storedFilename);
  const mime = fileMime(filename);

  // Write file to disk
  writeFileSync(storedPath, fileBuffer);

  // Record in database
  const fileRecord = ctx.db.addFile({
    id,
    name: filename,
    size: fileBuffer.length,
    mime,
    path: storedPath,
  });

  json(res, 201, fileRecord);
});

/** Split a buffer by a delimiter buffer. */
function splitBuffer(buf: Buffer, delim: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let idx: number;
  while ((idx = buf.indexOf(delim, start)) !== -1) {
    if (idx > start) {
      parts.push(buf.slice(start, idx));
    }
    start = idx + delim.length;
  }
  if (start < buf.length) {
    parts.push(buf.slice(start));
  }
  return parts;
}

/**
 * Get file content by ID. Returns the raw file with proper content-type.
 */
route('GET', '/api/files/:id', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id']!;
  const fileRecord = ctx.db.getFile(id);
  if (!fileRecord) {
    return json(res, 404, { error: 'File not found' });
  }

  if (!existsSync(fileRecord.path)) {
    return json(res, 404, { error: 'File content not found on disk' });
  }

  res.writeHead(200, {
    'Content-Type': fileRecord.mime,
    'Content-Length': String(fileRecord.size),
    'Content-Disposition': `inline; filename="${encodeURIComponent(fileRecord.name)}"`,
  });

  // Stream the file
  const stream = createReadStream(fileRecord.path);
  stream.pipe(res);
  stream.on('error', () => {
    res.end();
  });
});

/**
 * Get file metadata by ID. Returns the FileRecord JSON.
 */
route('GET', '/api/files/:id/meta', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id']!;
  const fileRecord = ctx.db.getFile(id);
  if (!fileRecord) {
    return json(res, 404, { error: 'File not found' });
  }
  json(res, 200, fileRecord);
});

/**
 * List all files.
 */
route('GET', '/api/files', async (_req, res, _match, ctx) => {
  const files = ctx.db.listFiles();
  json(res, 200, files);
});

/**
 * Delete a file by ID. Removes both the database record and the file on disk.
 */
route('DELETE', '/api/files/:id', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id']!;
  const fileRecord = ctx.db.getFile(id);
  if (!fileRecord) {
    return json(res, 404, { error: 'File not found' });
  }

  // Delete from disk
  if (existsSync(fileRecord.path)) {
    unlinkSync(fileRecord.path);
  }

  // Delete from database
  ctx.db.deleteFile(id);
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
    const { frontmatter, frontmatterRaw, body } = parseFrontmatter(raw);
    // RFC-005: core = single-line widget fields; passthroughRaw = every other
    // frontmatter line, verbatim (hooks/indicators/unknown keys/comments).
    const { core, passthroughRaw } = splitFrontmatter(raw);
    // structuredRenderable + frontmatterRaw retained for back-compat (older dashboard builds).
    json(res, 200, { name, content: raw, frontmatter, frontmatterRaw, core, passthroughRaw, body, structuredRenderable: structuredRenderable(raw), filePath: toHostPath(filePath), hostname: hostname() });
  } catch {
    json(res, 404, { error: 'Persona not found' });
  }
});

// ── RFC-007: pre-expansion CLI launch command preview (saved persona) ──
// GET — Bearer-exempt like the other persona GETs (auth gate at routes.ts ~3041
// exempts GET). Side-effect-free: NO tmux session, NO codex profile write, NO
// HOME scaffolding, NO proxy dispatch, NO DB mutation. Composes the same launch
// command spawn would, with the persona BODY replaced by the literal «PERSONA»
// token (the operator is editing the body, so the preview wraps everything around
// it). Reuses the real spawn-path builders (assembleLaunchCommand +
// buildUpsertOptsFromFrontmatter + resolveEffectiveConfig) so it cannot drift.
route('GET', '/api/personas/:name/launch-preview', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });

  // 1. Load + parse the saved persona file (same loading as GET /api/personas/:name).
  let fm: PersonaFrontmatter;
  try {
    const raw = readFileSync(join(getPersonasDir(), `${name}.md`), 'utf-8');
    fm = parseFrontmatter(raw).frontmatter as PersonaFrontmatter;
  } catch {
    return json(res, 404, { error: 'Persona not found' });
  }

  // 2. Map frontmatter → config via the SAME mapping create/sync use (S3: hooks
  //    are serialized to strings via serializeHookValue, matching AgentRecord).
  const cfg = buildUpsertOptsFromFrontmatter(name, fm) as Partial<AgentRecord> & { name: string };

  // 3. Synthetic AgentRecord: config opts + safe non-runtime dummies. NO DB write.
  const syntheticAgent: AgentRecord = {
    name,
    engine: (cfg.engine ?? 'claude') as EngineType,
    model: cfg.model ?? null,
    thinking: cfg.thinking ?? null,
    cwd: cfg.cwd ?? '/tmp',
    persona: cfg.persona ?? name,
    permissions: cfg.permissions ?? null,
    agentGroup: cfg.agentGroup ?? null,
    launchEnv: cfg.launchEnv ?? null,
    account: cfg.account ?? null,
    proxyPin: cfg.proxyPin ?? null,
    sortOrder: 0,
    hookStart: cfg.hookStart ?? null,
    hookResume: cfg.hookResume ?? null,
    hookCompact: cfg.hookCompact ?? null,
    hookExit: cfg.hookExit ?? null,
    hookInterrupt: cfg.hookInterrupt ?? null,
    hookReload: cfg.hookReload ?? null,
    hookSubmit: cfg.hookSubmit ?? null,
    state: 'void',
    stateBeforeShutdown: null,
    currentSessionId: null,
    tmuxSession: null,
    proxyId: null,
    lastActivity: null,
    lastContextPct: null,
    reloadQueued: 0,
    reloadTask: null,
    failedAt: null,
    failureReason: null,
    capturedVars: null,
    customButtons: cfg.customButtons ?? null,
    indicators: cfg.indicators ?? null,
    icon: cfg.icon ?? null,
    version: 0,
    spawnCount: 0,
    createdAt: '',
    isTemplate: false,
  };

  // 4. S4 GATE: resolve engine-config defaults EXACTLY as spawn (lifecycle.ts:496-497).
  //    Custom engines (e.g. claude-with-home) inject flags like --add-dir via the
  //    engine_configs hook_start — NOT frontmatter. Skipping this would make the
  //    preview silently lie.
  const engineConfig = ctx.db.getEngineConfig(syntheticAgent.engine);
  const effective = resolveEffectiveConfig(syntheticAgent, engineConfig);

  // 5. Compose the placeholder prompt: «PERSONA» body + live collab injection (peers
  //    are a point-in-time snapshot — S7).
  const lifecycleCtx = makeLifecycleCtx(ctx);
  const systemPrompt = composeSystemPrompt({
    agentName: name,
    personaContent: PERSONA_PLACEHOLDER,
    orchestratorHost: ctx.orchestratorHost,
    peers: computePeers(lifecycleCtx, name),
  });

  // 6. accountHome (S6): deterministic path the account would scaffold to, shown
  //    for display only. NO scaffolding, NO credential read. Presence of HOME= in
  //    the real spawn depends on the account resolving (scaffoldAgentHome → null
  //    otherwise); we mirror that — only include it if the account exists/has creds.
  const notes: string[] = [];
  notes.push('Default spawn (no ad-hoc /spawn task/cwd/model overrides) — S5.');
  notes.push('Known peers are a live snapshot, re-read at spawn time — S7.');
  notes.push(`Session id is illustrative ('${PREVIEW_SESSION_ID}'); a fresh UUID is generated per spawn.`);

  let accountHome: string | undefined;
  if (effective.account) {
    accountHome = join(ctx.accountStore.agentHomesDir, name);
    const acct = ctx.accountStore.getAccountInfo(effective.account);
    if (acct && acct.hasCredentials) {
      notes.push(`HOME=${accountHome} is scaffolded at spawn (account "${effective.account}" has credentials).`);
    } else {
      // Account declared but unresolved → real spawn omits HOME. Mirror that.
      accountHome = undefined;
      notes.push(`Account "${effective.account}" is declared but not resolvable (no credentials); HOME is omitted, exactly as spawn would.`);
    }
  }

  const personaFile = resolvePersonaFilePath(name, effective.persona);

  // 9. Assemble the launch command via the shared spawn-path helper.
  let result: ReturnType<typeof assembleLaunchCommand>;
  try {
    result = assembleLaunchCommand({
      agent: effective,
      systemPrompt,
      personaFile,
      accountHome,
      sessionId: PREVIEW_SESSION_ID,
      model: effective.model ?? undefined,
      thinking: effective.thinking ?? undefined,
    });
  } catch (err) {
    // 8. S2: file:/preset: hooks can throw (missing file / unknown engine). A
    //    half-typed hook during live editing must degrade, not 500.
    return json(res, 200, {
      error: (err as Error).message,
      engine: effective.engine,
      personaPlaceholder: PERSONA_PLACEHOLDER,
      notes,
    });
  }

  // 10. Render the command per mode + annotate where the persona lands per engine.
  let command: string;
  let hookKind: 'preset' | 'shell' | 'pipeline';
  if (result.mode === 'paste') {
    command = result.text;
    // Preset (adapter-built) vs shell hook both resolve to paste; distinguish by
    // whether an explicit hookStart string was set.
    hookKind = effective.hookStart ? 'shell' : 'preset';
  } else if (result.mode === 'pipeline') {
    command = result.steps
      .map((s) => (s.type === 'shell' ? s.command : `[${s.type}]`))
      .join('\n');
    hookKind = 'pipeline';
  } else {
    // keys/send/skip: no pasteable command line.
    command = '';
    hookKind = effective.hookStart ? 'shell' : 'preset';
    notes.push(`Start hook resolved to mode "${result.mode}" — no pasteable command line.`);
  }

  const body: Record<string, unknown> = {
    command,
    engine: effective.engine,
    hookKind,
    personaPlaceholder: PERSONA_PLACEHOLDER,
    notes,
  };

  // codex writes the system prompt to a config profile at spawn rather than inline;
  // surface the composed profile contents (with «PERSONA») so the preview is faithful.
  // Guard the adapter lookup: a custom engine whose adapter isn't resolvable must
  // not 500 the preview (the command above already rendered successfully).
  try {
    const adapter = getAdapter(effective.engine);
    if (adapter.usesConfigProfile) {
      body.profilePreview = systemPrompt;
      notes.push(`${effective.engine}: the system prompt is written to a config profile at spawn (not inline); the command uses the profile. profilePreview shows that composed prompt.`);
    }
  } catch {
    // Unknown/unresolvable engine adapter — annotate but still return the command.
    notes.push(`Engine "${effective.engine}" has no resolvable adapter for profile detection; treating system prompt as inline.`);
  }

  json(res, 200, body);
});

route('PUT', '/api/personas/:name', async (req, res, match) => {
  const name = match.pathname.groups['name']!;
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
  const payload = await readJson(req);
  // Accept (RFC-005) { fields, passthroughRaw, body } (core widgets + verbatim
  // passthrough), or legacy { content } (full file), { fields, body } (structured
  // via serializeFrontmatter), or { frontmatter, body } (raw split).
  let content: string;
  if (typeof payload.content === 'string') {
    content = payload.content;
  } else if (payload['fields'] && typeof payload['fields'] === 'object' && typeof payload['passthroughRaw'] === 'string') {
    // RFC-005: serialize core fields, then append the verbatim passthrough block.
    const coreFm = serializeCore(payload['fields'] as Record<string, unknown>).trim();
    const passthrough = (payload['passthroughRaw'] as string).trim();
    const fm = [coreFm, passthrough].filter(Boolean).join('\n');
    const bd = String(payload['body'] ?? '').trim();
    content = fm ? `---\n${fm}\n---\n\n${bd}` : bd;
  } else if (payload.fields && typeof payload.fields === 'object') {
    const fm = serializeFrontmatter(payload.fields as Record<string, unknown>).trim();
    const bd = (payload.body ?? '').trim();
    content = fm ? `---\n${fm}\n---\n\n${bd}` : bd;
  } else if (typeof payload.frontmatter === 'string' || typeof payload.body === 'string') {
    const fm = (payload.frontmatter ?? '').trim();
    const bd = (payload.body ?? '').trim();
    content = fm ? `---\n${fm}\n---\n\n${bd}` : bd;
  } else {
    return json(res, 400, { error: 'content, fields, or frontmatter/body required' });
  }
  try {
    const dir = getPersonasDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content, 'utf-8');
    json(res, 200, { name, content });
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

    // Universal "start" verb: if the agent is suspended, treat /spawn as
    // /resume. UI surfaces (kebab menus, profile popover, etc.) all call
    // Spawn without having to switch endpoints by state.
    if (agent.state === 'suspended') {
      const proxyId = resolveProxyId(ctx, agent, body.proxyId as string | undefined);
      if (proxyId && !agent.proxyId) {
        ctx.db.updateAgentState(name, agent.state, agent.version, { proxyId });
      }
      const result = await resumeAgent(lifecycleCtx, name, {
        task: body.task as string | undefined,
      });
      broadcastAgentUpdate(ctx, name);
      broadcastLifecycleEvent(ctx, name, 'Resumed');
      return json(res, 200, result);
    }

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

route('GET', '/api/agents/:name/peek', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  // Support ?lines=N query param (default 50, max 1000)
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const linesParam = url.searchParams.get('lines');
  const lines = linesParam ? Math.max(1, Math.min(parseInt(linesParam, 10) || 50, 1000)) : 50;

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'capture',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    lines,
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
  const elevenlabs = ctx.voiceEnabled;
  const whisper = !!ctx.whisperOpts;
  json(res, 200, {
    enabled: elevenlabs || whisper,
    providers: { elevenlabs, whisper },
    defaultProvider: ctx.defaultSttProvider ?? null,
  });
});

const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — matches OpenAI Whisper's per-file cap
const WHISPER_DEFAULT_FILENAME = 'audio.webm';

route('POST', '/api/voice/transcribe', async (req, res, _match, ctx) => {
  if (!ctx.whisperOpts) {
    return json(res, 503, { error: 'Whisper not configured (set WHISPER_URL)' });
  }
  const contentType = (req.headers['content-type'] ?? '').toString();
  if (!contentType || !contentType.startsWith('audio/')) {
    return json(res, 400, { error: 'Content-Type must be audio/*' });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > WHISPER_MAX_BYTES) {
        return json(res, 413, { error: `Audio too large (max ${WHISPER_MAX_BYTES} bytes)` });
      }
      chunks.push(buf);
    }
  } catch (err) {
    return json(res, 400, { error: `Failed reading audio body: ${(err as Error).message}` });
  }
  if (total === 0) {
    return json(res, 400, { error: 'Empty audio body' });
  }
  const audio = Buffer.concat(chunks);
  // Derive a sensible filename extension from the MIME so Whisper
  // servers that sniff by extension still work.
  const filename = filenameFromContentType(contentType);
  try {
    const result = await whisperTranscribe(audio, contentType, filename, ctx.whisperOpts);
    json(res, 200, result);
  } catch (err) {
    console.error('[voice] Whisper transcribe error:', (err as Error).message);
    json(res, 502, { error: (err as Error).message });
  }
});

function filenameFromContentType(ct: string): string {
  const base = ct.split(';')[0]!.trim().toLowerCase();
  switch (base) {
    case 'audio/webm': return 'audio.webm';
    case 'audio/ogg':  return 'audio.ogg';
    case 'audio/mp4':
    case 'audio/m4a':  return 'audio.m4a';
    case 'audio/mpeg': return 'audio.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave': return 'audio.wav';
    default:           return WHISPER_DEFAULT_FILENAME;
  }
}

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

// ── Host filesystem listing (proxy-backed) ──
// Used by the v3 dashboard's CWD picker — the orchestrator lives in Docker
// so it can't see host paths. We delegate to a proxy via list_dir.
route('GET', '/api/proxy/list-dir', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.searchParams.get('path') ?? '';
  const showHidden = url.searchParams.get('hidden') === '1';
  const explicitProxy = url.searchParams.get('proxyId') ?? undefined;
  const proxies = ctx.db.listProxies();
  if (proxies.length === 0) {
    return json(res, 503, { error: 'no proxy registered' });
  }
  const proxyId = explicitProxy && proxies.some(p => p.proxyId === explicitProxy)
    ? explicitProxy
    : proxies[0]!.proxyId;
  const result = await ctx.proxyDispatch(proxyId, {
    action: 'list_dir',
    path,
    showHidden,
  });
  if (!result.ok) return json(res, 400, { error: result.error });
  json(res, 200, result.data);
});

// ── Teams (v3 UI grouping) ──
// Teams are UI-only filters in the v3 sidebar. No kernel behavior. Many-to-many
// with agents (an agent can be in multiple teams). Membership lookups happen
// client-side from the listing endpoint; we don't expose per-agent team lookup
// because the sidebar already has the full list.

function broadcastTeamsUpdate(ctx: RouteContext): void {
  ctx.wss.broadcast(JSON.stringify({ type: 'teams_update', teams: ctx.db.listTeams() }));
}

route('GET', '/api/teams', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listTeams());
});

route('POST', '/api/teams', async (req, res, _match, ctx) => {
  const body = await readJson(req);
  const name = typeof body['name'] === 'string' ? body['name'] : '';
  if (!name.trim()) return json(res, 400, { error: 'name is required' });
  const members = Array.isArray(body['members'])
    ? (body['members'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];
  try {
    const team = ctx.db.createTeam(name, members);
    for (const m of team.members) writeAgentTeams(m, ctx.db.getAgentTeamNames(m)); // RFC-004 write-through
    broadcastTeamsUpdate(ctx);
    json(res, 201, team);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'create failed';
    // SQLite unique-constraint violation → 409
    if (/UNIQUE constraint failed/.test(msg)) {
      return json(res, 409, { error: 'A team with that name already exists' });
    }
    json(res, 400, { error: msg });
  }
});

route('PATCH', '/api/teams/:id', async (req, res, match, ctx) => {
  const id = Number(match.pathname.groups['id']);
  if (!Number.isFinite(id)) return json(res, 400, { error: 'invalid id' });
  const body = await readJson(req);
  const name = typeof body['name'] === 'string' ? body['name'] : '';
  if (!name.trim()) return json(res, 400, { error: 'name is required' });
  try {
    const team = ctx.db.updateTeamName(id, name);
    if (!team) return json(res, 404, { error: 'team not found' });
    for (const m of team.members) writeAgentTeams(m, ctx.db.getAgentTeamNames(m)); // RFC-004: rename → rewrite members' files
    broadcastTeamsUpdate(ctx);
    json(res, 200, team);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update failed';
    if (/UNIQUE constraint failed/.test(msg)) {
      return json(res, 409, { error: 'A team with that name already exists' });
    }
    json(res, 400, { error: msg });
  }
});

route('DELETE', '/api/teams/:id', async (_req, res, match, ctx) => {
  const id = Number(match.pathname.groups['id']);
  if (!Number.isFinite(id)) return json(res, 400, { error: 'invalid id' });
  const members = ctx.db.getTeam(id)?.members ?? []; // capture before delete
  const ok = ctx.db.deleteTeam(id);
  if (!ok) return json(res, 404, { error: 'team not found' });
  for (const m of members) writeAgentTeams(m, ctx.db.getAgentTeamNames(m)); // RFC-004: delete → drop from members' files
  broadcastTeamsUpdate(ctx);
  res.writeHead(204);
  res.end();
});

route('POST', '/api/teams/:id/members', async (req, res, match, ctx) => {
  const id = Number(match.pathname.groups['id']);
  if (!Number.isFinite(id)) return json(res, 400, { error: 'invalid id' });
  const body = await readJson(req);
  const agentName = typeof body['agentName'] === 'string' ? body['agentName'] : '';
  if (!agentName.trim()) return json(res, 400, { error: 'agentName is required' });
  const team = ctx.db.addTeamMember(id, agentName);
  if (!team) return json(res, 404, { error: 'team not found' });
  writeAgentTeams(agentName, ctx.db.getAgentTeamNames(agentName)); // RFC-004 write-through
  broadcastTeamsUpdate(ctx);
  json(res, 200, team);
});

route('DELETE', '/api/teams/:id/members/:agentName', async (_req, res, match, ctx) => {
  const id = Number(match.pathname.groups['id']);
  const agentName = match.pathname.groups['agentName'] ?? '';
  if (!Number.isFinite(id)) return json(res, 400, { error: 'invalid id' });
  if (!agentName) return json(res, 400, { error: 'agentName is required' });
  const team = ctx.db.removeTeamMember(id, agentName);
  if (!team) return json(res, 404, { error: 'team not found' });
  writeAgentTeams(agentName, ctx.db.getAgentTeamNames(agentName)); // RFC-004 write-through
  broadcastTeamsUpdate(ctx);
  json(res, 200, team);
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

/**
 * Broadcast a dashboard message with subscription filtering.
 * Messages are delivered only to clients subscribed to the agent's thread.
 */
function broadcastMessage(ctx: RouteContext, msg: DashboardMessage): void {
  ctx.wss.broadcastFiltered(JSON.stringify({ type: 'message', msg }), msg.agent);
}

/** Insert a lifecycle event as a system message in the agent's chat thread and broadcast it. */
function broadcastLifecycleEvent(ctx: RouteContext, agentName: string, label: string): void {
  // Include the agent name in the body so the dashboard can render it
  // even outside the agent's own thread (e.g. in the merged chat view).
  const msg = ctx.db.addDashboardMessage(agentName, 'from_agent', `${agentName} ${label.toLowerCase()}`, {
    topic: 'lifecycle',
    sourceAgent: 'system',
    targetAgent: agentName,
  });
  broadcastMessage(ctx, msg);
}

function validateAgentName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!NAME_RE.test(name)) return 'name must be 1-63 chars, start with alphanumeric, contain only [a-zA-Z0-9_-]';
  return null;
}

function replyHint(from: string, topic: string): string {
  return `reply with collab send ${from} --topic ${topic}`;
}

function buildReplyEnvelope(from: string, topic: string, message: string, fileIds?: string[]): string {
  const base = `[from: ${from}: ${replyHint(from, topic)}]: '${message}'`;
  if (!fileIds || fileIds.length === 0) return base;
  // Append file references so the agent can access them
  const fileRefs = fileIds.map(id => `  - /api/files/${id} (use Read tool or curl to fetch)`).join('\n');
  return `${base}\n\n[Attached files (${fileIds.length}):\n${fileRefs}]`;
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
    /** File IDs attached to this message. */
    fileIds?: string[];
  },
): { msg: DashboardMessage; pending: PendingMessage; linkedMsg: DashboardMessage & { queueId: number; deliveryStatus: string } } {
  const direction = opts.direction ?? 'to_agent';
  const deliverTo = opts.targetAgent ?? opts.agentName;

  const msg = ctx.db.addDashboardMessage(opts.agentName, direction, opts.displayMessage, {
    topic: opts.topic ?? undefined,
    sourceAgent: opts.sourceAgent ?? undefined,
    targetAgent: opts.targetAgent ?? undefined,
    fileIds: opts.fileIds,
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
  broadcastMessage(ctx, broadcastLinked ? linkedMsg : msg);
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
      broadcastMessage(ctx, msg);
      console.log('[telegram] Routed message to dashboard');
    }
  });
}
