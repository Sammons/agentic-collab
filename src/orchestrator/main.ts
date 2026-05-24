/**
 * Orchestrator service entry point.
 * Runs inside Docker. Serves HTTP API + WebSocket + dashboard on port 3000.
 */

import { createServer } from 'node:http';
import { readFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Database } from './database.ts';
import { createRouter, startTelegramPolling, warmDashboardAssets, type RouteContext } from './routes.ts';
import { TelegramDispatcher } from './telegram.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { HealthMonitor } from './health-monitor.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { UsagePoller } from './usage-poller.ts';
import { ReminderDispatcher } from './reminder-dispatcher.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import type { LifecycleContext } from './lifecycle.ts';
import { syncPersonasToDb, syncPersonasWithDiff, getPersonasDir } from './persona.ts';
import { TopicDelivery } from './topic-delivery.ts';
import { InstanceReaper } from './instance-reaper.ts';
import { ApprovalService } from './approvals.ts';
import { BootReconciler, ProxyReconnectHandler, OrphanedWorktreeSweep } from './recovery.ts';
import { AccountStore } from './accounts.ts';
import { isRunning } from '../shared/agent-entity.ts';
import { resolveSecret, getSecretPath } from '../shared/config.ts';
import type { ProxyCommand, ProxyResponse, ProxyRegistration } from '../shared/types.ts';
import { getVersion } from '../shared/version.ts';
import { handleVoiceUpgrade, type VoiceProxyOptions } from './voice-proxy.ts';
import type { WhisperOptions } from './whisper-stt.ts';
import { DEFAULT_ENGINE_CONFIGS } from './default-engine-configs.ts';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? join(process.env['HOME'] ?? '/data', '.agentic-collab', 'orchestrator.db');
const ORCHESTRATOR_HOST = process.env['ORCHESTRATOR_HOST'] ?? `http://localhost:${PORT}`;
const ORCHESTRATOR_SECRET = resolveSecret({ create: true });

if (!ORCHESTRATOR_SECRET) {
  console.warn('[orchestrator] WARNING: ORCHESTRATOR_SECRET not set — auth is disabled');
} else {
  console.log(`[orchestrator] Auth enabled (secret from ${process.env['ORCHESTRATOR_SECRET'] ? 'env' : getSecretPath()})`);
}

// Ensure DB + pages + stores directories exist
mkdirSync(dirname(DB_PATH), { recursive: true });
const PAGES_DIR = join(dirname(DB_PATH), 'pages');
mkdirSync(PAGES_DIR, { recursive: true });
const STORES_DIR = join(dirname(DB_PATH), 'stores');
mkdirSync(STORES_DIR, { recursive: true });

const db = new Database(DB_PATH);
const wss = new WebSocketServer();
const locks = new LockManager(db.rawDb);

// ── Seed Default Engine Configs ──

for (const config of DEFAULT_ENGINE_CONFIGS) {
  if (!db.getEngineConfig(config.name)) {
    db.createEngineConfig(config);
    console.log(`[orchestrator] Seeded default engine config: ${config.name}`);
  }
}

// ── Proxy Dispatch ──

const PROXY_RETRY_COUNT = 2;
const PROXY_RETRY_BASE_MS = 500;

async function proxyDispatch(proxyId: string, command: ProxyCommand): Promise<ProxyResponse> {
  const proxy = db.getProxy(proxyId);
  if (!proxy) {
    return { ok: false, error: `Proxy "${proxyId}" not registered` };
  }

  let lastError = '';
  for (let attempt = 0; attempt <= PROXY_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1000ms
      const delay = PROXY_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise<void>((r) => setTimeout(r, delay));
    }

    try {
      // `exec` commands may carry an explicit timeoutMs that is larger than
      // the default 15s fetch ceiling (e.g. `git worktree add` at 60s).
      // Bump the orchestrator-side abort to outlive the proxy-side timeout
      // by a 5s buffer for HTTP + proxy-startup overhead. Non-exec commands
      // keep the 15s ceiling.
      const fetchTimeout = command.action === 'exec'
        ? Math.max(15_000, (command.timeoutMs ?? 5_000) + 5_000)
        : 15_000;
      const resp = await fetch(`http://${proxy.host}/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-proxy-token': proxy.token,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(fetchTimeout),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { ok: false, error: `Proxy returned ${resp.status}: ${text}` };
      }

      return await resp.json() as ProxyResponse;
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < PROXY_RETRY_COUNT) {
        console.warn(`[proxy-dispatch] Attempt ${attempt + 1} failed for ${proxyId}: ${lastError}, retrying...`);
      }
    }
  }

  return { ok: false, error: `Proxy unreachable after ${PROXY_RETRY_COUNT + 1} attempts: ${lastError}` };
}

// ── Dashboard HTML ──

let dashboardHtml: string | null = null;

function getDashboardHtml(): string {
  if (!dashboardHtml) {
    const htmlPath = join(import.meta.dirname!, '..', 'dashboard', 'index.html');
    dashboardHtml = readFileSync(htmlPath, 'utf-8');
  }
  return dashboardHtml;
}

// ── Server Setup ──

// ── Message Dispatcher (event-driven delivery) ──

// Forward-declared so the dispatcher can reference it (circular init resolved below)
let healthMonitorRef: HealthMonitor | null = null;

const messageDispatcher = new MessageDispatcher({
  db,
  locks,
  proxyDispatch,
  orchestratorHost: ORCHESTRATOR_HOST,
  onQueueUpdate: (message) => {
    wss.broadcast(JSON.stringify({ type: 'queue_update', message }));
  },
  onDashboardMessage: (msg) => {
    wss.broadcast(JSON.stringify({ type: 'message', msg }));
  },
  onMessageDelivered: (agentName) => {
    // Immediately mark idle agents as active for instant dashboard feedback
    try {
      const agent = db.getAgent(agentName);
      if (agent && agent.state === 'idle') {
        db.updateAgentState(agentName, 'active', agent.version, {
          lastActivity: new Date().toISOString(),
        });
        const updated = db.getAgent(agentName);
        if (updated) {
          wss.broadcast(JSON.stringify({ type: 'agent_update', agent: updated }));
        }
      }
    } catch { /* best effort — health monitor will catch up */ }
    healthMonitorRef?.scheduleQuickPoll(agentName);
  },
});

// ── Health Monitor ──

const healthMonitor = new HealthMonitor({
  db,
  locks,
  proxyDispatch,
  orchestratorHost: ORCHESTRATOR_HOST,
  onAgentUpdate: (agentName) => {
    const agent = db.getAgent(agentName);
    if (agent) {
      wss.broadcast(JSON.stringify({ type: 'agent_update', agent }));
    }
  },
  onQueueUpdate: (message) => {
    wss.broadcast(JSON.stringify({ type: 'queue_update', message }));
  },
  onDashboardMessage: (msg) => {
    wss.broadcast(JSON.stringify({ type: 'message', msg }));
  },
  onIndicatorUpdate: (agentName, indicators) => {
    wss.broadcast(JSON.stringify({ type: 'indicator_update', agentName, indicators }));
  },
  onIdleDetected: (agentName) => {
    messageDispatcher.tryDeliver(agentName).catch((err) => {
      console.error(`[dispatcher] Idle-triggered delivery failed for ${agentName}:`, (err as Error).message);
    });
  },
});
healthMonitorRef = healthMonitor;

// ── Account Store ──

const accountStore = new AccountStore();

// ── Usage Poller ──

const usagePoller = new UsagePoller({
  db,
  proxyDispatch,
  accountStore,
  cwd: '/tmp',
});

// ── Reminder Dispatcher ──

const reminderDispatcher = new ReminderDispatcher({
  db,
  messageDispatcher,
  onQueueUpdate: (message) => {
    wss.broadcast(JSON.stringify({ type: 'queue_update', message }));
  },
  onDashboardMessage: (msg) => {
    wss.broadcast(JSON.stringify({ type: 'message', msg }));
  },
});

const lifecycleCtx: LifecycleContext = {
  db,
  locks,
  proxyDispatch,
  orchestratorHost: ORCHESTRATOR_HOST,
  accountStore,
};

// Voice proxy config — two providers can coexist.
//
// ElevenLabs: realtime WebSocket streaming STT (partial transcripts).
// Whisper:    OpenAI-compatible batch HTTP STT (one-shot PTT clips).
//
// STT_PROVIDER pins the default the dashboard picks when both are
// available. 'auto' (default) means: ElevenLabs if its key is set, else
// Whisper if its URL is set, else neither.
const ELEVENLABS_API_KEY = process.env['ELEVENLABS_API_KEY'] ?? '';
const voiceOpts: VoiceProxyOptions | null = ELEVENLABS_API_KEY
  ? {
      elevenLabsApiKey: ELEVENLABS_API_KEY,
      sttModel: process.env['ELEVENLABS_STT_MODEL'],
      language: process.env['ELEVENLABS_STT_LANGUAGE'],
    }
  : null;

const WHISPER_URL = process.env['WHISPER_URL'] ?? '';
const whisperOpts: WhisperOptions | null = WHISPER_URL
  ? {
      url: WHISPER_URL,
      apiKey: process.env['WHISPER_API_KEY'] || undefined,
      model: process.env['WHISPER_MODEL'] || undefined,
      language: process.env['WHISPER_LANGUAGE'] || undefined,
    }
  : null;

const STT_PROVIDER_ENV = (process.env['STT_PROVIDER'] ?? 'auto').toLowerCase();
const sttProviderPin: 'elevenlabs' | 'whisper' | 'auto' =
  STT_PROVIDER_ENV === 'elevenlabs' || STT_PROVIDER_ENV === 'whisper'
    ? STT_PROVIDER_ENV
    : 'auto';

function resolveDefaultSttProvider(): 'elevenlabs' | 'whisper' | null {
  if (sttProviderPin === 'elevenlabs') return voiceOpts ? 'elevenlabs' : null;
  if (sttProviderPin === 'whisper') return whisperOpts ? 'whisper' : null;
  if (voiceOpts) return 'elevenlabs';
  if (whisperOpts) return 'whisper';
  return null;
}

if (voiceOpts) {
  console.log('[orchestrator] Voice dictation: ElevenLabs realtime enabled');
}
if (whisperOpts) {
  console.log(`[orchestrator] Voice dictation: Whisper batch enabled (${WHISPER_URL})`);
}

// ── Telegram Dispatcher ──

const telegramDispatcher = new TelegramDispatcher();

// ── v3 Q3: Topic delivery + instance reaper ──

const INSTANCES_DIR = join(dirname(DB_PATH), 'instances');
mkdirSync(INSTANCES_DIR, { recursive: true });

const topicDelivery = new TopicDelivery({
  db,
  proxyDispatch,
  orchestratorHost: ORCHESTRATOR_HOST,
  ipcRoot: INSTANCES_DIR,
  locks,
  // Q4: typed WS broadcast — `event` is already a `WsEvent` shape.
  onEvent: (event) => wss.broadcastEvent(event),
});

const instanceReaper = new InstanceReaper({
  db,
  proxyDispatch,
  messageDispatcher,
  topicDelivery,
  onEvent: (event) => wss.broadcastEvent(event),
});

// ── v3 Q5: Approvals service ──
//
// Auto-notifies requesters on state change via the existing message
// dispatcher (paste for live ephemeral instances, persistent enqueue for
// agent: addresses). Emits `approval_changed` WS events.
const approvals = new ApprovalService({
  db,
  messageDispatcher,
  onEvent: (event) => wss.broadcastEvent(event),
  // Surface auto-notify dashboard rows over the same `message` WS event
  // the chat surface already listens on — agent thread updates live.
  onMessage: (msg) => wss.broadcast(JSON.stringify({ type: 'message', msg })),
});

// ── v3 Q8: Crash recovery ──
//
// Three coordinated routines reconcile ephemeral state. The boot reconciler
// runs once before listen (so traffic never sees orphaned rows); the
// reconnect handler is invoked from the proxy-register route; the orphan
// sweep ticks on a 60s cadence (first tick at T+60s, NOT T+0).
const bootReconciler = new BootReconciler({
  db,
  proxyDispatch,
  instanceReaper,
  onEvent: (event) => wss.broadcastEvent(event),
});

const proxyReconnectHandler = new ProxyReconnectHandler({
  db,
  proxyDispatch,
  onEvent: (event) => wss.broadcastEvent(event),
});

const orphanedWorktreeSweep = new OrphanedWorktreeSweep({
  db,
  proxyDispatch,
  onEvent: (event) => wss.broadcastEvent(event),
});

const routeCtx: RouteContext = {
  db,
  wss,
  locks,
  proxyDispatch,
  getDashboardHtml,
  orchestratorHost: ORCHESTRATOR_HOST,
  orchestratorSecret: ORCHESTRATOR_SECRET,
  messageDispatcher,
  usagePoller,
  voiceEnabled: !!voiceOpts,
  whisperOpts,
  defaultSttProvider: resolveDefaultSttProvider(),
  accountStore,
  pagesDir: PAGES_DIR,
  storesDir: STORES_DIR,
  telegramDispatcher,
  topicDelivery,
  instanceReaper,
  approvals,
  recovery: {
    reconciler: bootReconciler,
    reconnectHandler: proxyReconnectHandler,
    orphanSweep: orphanedWorktreeSweep,
  },
  reloadPersonas: () => {
    // Q4: forward `template_updated` events to WS subscribers so the Q9
    // dashboard can refresh the templates tree without a full reload.
    const diff = syncPersonasWithDiff(db, undefined, (event) => wss.broadcastEvent(event));
    return {
      synced: diff.created.length + diff.updated.length,
      created: diff.created,
      updated: diff.updated,
      skipped: diff.skipped,
    };
  },
};

// Pre-strip and cache all dashboard TS/JS/CSS assets at boot so the first
// page load doesn't pay the stripTypeScriptTypes cost. Runs synchronously —
// completes before the HTTP server starts listening.
warmDashboardAssets();

const router = createRouter(routeCtx);

const server = createServer(async (req, res) => {
  // CORS for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Token, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  await router(req, res);
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  // Auth check helper
  const checkAuth = (): boolean => {
    if (!ORCHESTRATOR_SECRET) return true;
    const token = url.searchParams.get('token') ?? '';
    return token.length === ORCHESTRATOR_SECRET.length
      && timingSafeEqual(Buffer.from(token), Buffer.from(ORCHESTRATOR_SECRET));
  };

  if (url.pathname === '/ws') {
    if (!checkAuth()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Delta init: client passes its max-seen dashboard_messages.id so we
    // only send the new rows since last sync. 0/missing → cold init.
    const sinceRaw = url.searchParams.get('sinceMessageId');
    const sinceMessageId = sinceRaw !== null ? Math.max(0, parseInt(sinceRaw, 10) || 0) : 0;
    wss.handleUpgrade(req, socket, head, { sinceMessageId });
  } else if (url.pathname === '/ws/voice') {
    if (!checkAuth()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!voiceOpts) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nELEVENLABS_API_KEY not configured');
      socket.destroy();
      return;
    }
    handleVoiceUpgrade(req, socket, head, voiceOpts);
  } else {
    socket.destroy();
  }
});

// On WS connect, send init event
wss.onConnect((client) => {
  // Combine persistent agents + templates for dashboard display.
  // Templates that share a name with a persistent agent are filtered out —
  // the persistent agent takes precedence (already spawned/running).
  const persistentAgents = db.listAgents();
  const persistentNames = new Set(persistentAgents.map((a) => a.name));
  const templateAgents = db.listTemplatesAsAgentRecords()
    .filter((t) => !persistentNames.has(t.name));
  const agents = [...persistentAgents, ...templateAgents];
  // Delta init: the client may pass its max-seen message id via
  // ?sinceMessageId=N. If present and non-zero, we ship just the rows
  // that have appeared since (typically tiny). Otherwise we cold-load
  // with the standard 200-per-agent window.
  const sinceMessageId = typeof client.attrs['sinceMessageId'] === 'number'
    ? client.attrs['sinceMessageId'] as number
    : 0;
  const threads = sinceMessageId > 0
    ? db.getDashboardThreadsSince(sinceMessageId)
    : db.getDashboardThreads();
  const maxMessageId = db.getMaxDashboardMessageId();
  const rawProxies = db.listProxies();
  const unreadCounts = db.getUnreadCounts();
  // Enrich proxies with version match status
  const orchestratorVersion = getVersion();
  const proxies: ProxyRegistration[] = rawProxies.map(p => ({
    ...p,
    versionMatch: !!p.version && p.version === orchestratorVersion,
  }));
  // Collect active indicators for all agents
  const indicators: Record<string, unknown[]> = {};
  for (const agent of agents) {
    const active = healthMonitor.getActiveIndicators(agent.name);
    if (active.length > 0) indicators[agent.name] = active;
  }
  const accounts = accountStore.list();
  const engineConfigs = db.listEngineConfigs();
  const pages = db.listPages();
  const stores = db.listStores();
  const destinations = db.listDestinations();
  const teams = db.listTeams();
  wss.send(client, JSON.stringify({
    type: 'init',
    agents,
    engineConfigs,
    threads,
    proxies,
    unreadCounts,
    indicators,
    accounts,
    pages,
    stores,
    destinations,
    teams,
    // Watermark the client echoes back as ?sinceMessageId=N on next reload.
    maxMessageId,
    // Signal whether `threads` is a full window (cold init) or just deltas
    // since the client's sinceMessageId. The dashboard merges accordingly.
    threadsAreDelta: sinceMessageId > 0,
  }));
});

// On WS message from dashboard
wss.onMessage((_client, data) => {
  try {
    const msg = JSON.parse(data);
    if (msg.type === 'ping') {
      // Keepalive, no action needed
    }
  } catch {
    // Ignore malformed messages
  }
});

// ── Stale Proxy Cleanup (every 30s) ──

// On startup, give existing proxies a fresh grace period to reconnect.
// Without this, a rebuild that takes >45s causes the stale timer to nuke
// proxies before they can re-register, creating unnecessary failed→active churn.
const touchedProxies = db.touchAllProxyHeartbeats();
if (touchedProxies > 0) {
  console.log(`[proxy] Refreshed heartbeat for ${touchedProxies} existing proxy(s)`);
}

const staleProxyTimer = setInterval(() => {
  const stale = db.listStaleProxies(45); // 45s = 3 missed heartbeats
  for (const proxy of stale) {
    console.log(`[proxy] Removing stale proxy: ${proxy.proxyId} (last heartbeat: ${proxy.lastHeartbeat})`);
    db.removeProxy(proxy.proxyId);

    // Mark agents on this proxy as failed
    const agents = db.listAgents().filter((a) => a.proxyId === proxy.proxyId);
    for (const agent of agents) {
      if (isRunning(agent)) {
        db.updateAgentState(agent.name, 'failed', agent.version, {
          failedAt: new Date().toISOString(),
          failureReason: 'Proxy disconnected',
        });
        db.logEvent(agent.name, 'proxy_disconnected', undefined, { proxyId: proxy.proxyId });
      }
    }
  }
}, 30_000);

// ── Graceful Shutdown ──

async function shutdown(): Promise<void> {
  console.log('[orchestrator] Shutting down...');
  clearInterval(staleProxyTimer);
  telegramDispatcher.stopPolling();
  healthMonitor.stop();
  messageDispatcher.stop();
  usagePoller.stop();
  reminderDispatcher.stop();
  instanceReaper.stop();
  orphanedWorktreeSweep.stop();
  await usagePoller.cleanup().catch(err =>
    console.error('[orchestrator] Usage session cleanup error:', err));

  // Close WebSocket BEFORE suspending agents — prevents the dashboard
  // from seeing the transient 'suspended' state that gets restored on startup.
  wss.close();

  // Save agent states for network restore
  try {
    const count = shutdownAgents(lifecycleCtx);
    console.log(`[orchestrator] Suspended ${count} agents for restore`);
  } catch (err) {
    console.error('[orchestrator] Error during agent shutdown:', err);
  }
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ──

// v3 Q8: reconcile live `agent_instances` rows BEFORE traffic. We may have
// crashed mid-flight: an instance whose status file is non-empty just needs
// to be finalised via the reaper; one whose tmux session is alive resumes
// waiting for `collab complete`; one whose session is gone is marked failed
// with best-effort cleanup. Bounded by the existing proxy retry budget —
// if a proxy is unreachable, its rows are skipped and picked up when the
// proxy reconnects (`ProxyReconnectHandler`).
await bootReconciler.reconcile().catch((err) => {
  console.error('[boot-reconcile] failed:', err);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[orchestrator] Listening on port ${PORT}`);
  console.log(`[orchestrator] Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`[orchestrator] DB: ${DB_PATH}`);

  // Sync persona files → SQLite (idempotent merge). No WS subscribers yet at
  // boot — `template_updated` events at this point would have no audience, so
  // skip the sink. The hot-reload watcher below wires it.
  try {
    const synced = syncPersonasToDb(db);
    if (synced > 0) {
      console.log(`[orchestrator] Persona sync: ${synced} agents synced from persistent-agents/`);
    }
  } catch (err) {
    console.error('[orchestrator] Persona sync failed:', err);
  }

  // Poll persona directory for changes (fs.watch unreliable on Docker bind mounts)
  const personasDir = getPersonasDir();
  if (existsSync(personasDir)) {
    let lastPersonaHash = '';
    setInterval(() => {
      try {
        // Quick hash of file names + mtimes to detect changes
        const files = readdirSync(personasDir).filter(f => f.endsWith('.md')).sort();
        const hash = files.map(f => {
          try { return f + ':' + statSync(join(personasDir, f)).mtimeMs; } catch { return f; }
        }).join('|');
        if (hash === lastPersonaHash) return;
        if (lastPersonaHash === '') { lastPersonaHash = hash; return; } // skip first run
        lastPersonaHash = hash;

        const diff = syncPersonasWithDiff(db, undefined, (event) => wss.broadcastEvent(event));
        const changed = [...diff.created, ...diff.updated];
        if (changed.length > 0) {
          console.log(`[persona-watch] Hot-reloaded: ${changed.join(', ')}`);
          const agents = db.listAgents();
          // Use agents_update instead of init to avoid wiping threads/indicators
          wss.broadcast(JSON.stringify({
            type: 'agents_update',
            agents,
            engineConfigs: db.listEngineConfigs(),
          }));
        }
      } catch (err) {
        console.error('[persona-watch] Re-sync failed:', err);
      }
    }, 5000);
    console.log(`[persona-watch] Polling ${personasDir} every 5s for changes`);
  }

  // Start health monitor + usage poller + reminder dispatcher
  healthMonitor.start();
  usagePoller.start();
  reminderDispatcher.start();
  instanceReaper.start();

  // v3 Q8: orphaned-worktree sweep ticks on a 60s cadence. The first tick
  // fires at T+60s (setInterval semantics), NOT immediately at boot — boot
  // reconciliation has already run by this point, so a delayed first sweep
  // is intentional. Best-effort, never throws. Removes `wt-*` directories
  // under any template's `cwd_base` that have no corresponding live
  // `agent_instances.worktree_path` entry.
  orphanedWorktreeSweep.start();

  // Start Telegram polling for enabled destinations
  const telegramDests = db.listDestinations().filter(d => d.type === 'telegram' && d.enabled);
  for (const dest of telegramDests) {
    startTelegramPolling(routeCtx, dest);
    console.log(`[telegram] Started polling for destination: ${dest.name}`);
  }

  // Attempt network restore for agents that were running before last shutdown/crash
  try {
    const restored = await restoreAllAgents(lifecycleCtx);
    if (restored > 0) {
      console.log(`[orchestrator] Network restore: resumed ${restored} agents`);
      // Broadcast corrected agent states to any dashboard clients that connected
      // before restore completed (they would have seen transient 'suspended' states)
      const freshAgents = db.listAgents();
      for (const agent of freshAgents) {
        wss.broadcast(JSON.stringify({ type: 'agent_update', agent }));
      }
    }
  } catch (err) {
    console.error('[orchestrator] Network restore failed:', err);
  }

  // Sweep pending messages that survived restart — agents may have queued
  // messages from before the restart that were never delivered.
  // Delay 10s to let proxies register and agents come online first.
  setTimeout(() => {
    messageDispatcher.drainPending().catch((err) => {
      console.error('[orchestrator] Startup message sweep failed:', err);
    });
  }, 10_000);
});
