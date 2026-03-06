/**
 * Orchestrator service entry point.
 * Runs inside Docker. Serves HTTP API + WebSocket + dashboard on port 3000.
 */

import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { HealthMonitor } from './health-monitor.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import type { LifecycleContext } from './lifecycle.ts';
import { isRunning } from '../shared/agent-entity.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? join(process.env['HOME'] ?? '/data', '.agentic-collab', 'orchestrator.db');
const ORCHESTRATOR_HOST = process.env['ORCHESTRATOR_HOST'] ?? `http://localhost:${PORT}`;

// Ensure DB directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
const wss = new WebSocketServer();
const locks = new LockManager(db.rawDb);

// ── Proxy Dispatch ──

async function proxyDispatch(proxyId: string, command: ProxyCommand): Promise<ProxyResponse> {
  const proxy = db.getProxy(proxyId);
  if (!proxy) {
    return { ok: false, error: `Proxy "${proxyId}" not registered` };
  }

  try {
    const resp = await fetch(`http://${proxy.host}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-proxy-token': proxy.token,
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Proxy returned ${resp.status}: ${text}` };
    }

    return await resp.json() as ProxyResponse;
  } catch (err) {
    return { ok: false, error: `Proxy unreachable: ${(err as Error).message}` };
  }
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
});

const lifecycleCtx: LifecycleContext = {
  db,
  locks,
  proxyDispatch,
  orchestratorHost: ORCHESTRATOR_HOST,
};

const routeCtx: RouteContext = {
  db,
  wss,
  locks,
  proxyDispatch,
  getDashboardHtml,
  orchestratorHost: ORCHESTRATOR_HOST,
};

const router = createRouter(routeCtx);

const server = createServer(async (req, res) => {
  // CORS for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Token');

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
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head);

    // Send init event to newly connected client
    // The WebSocket server handles the connection event
  } else {
    socket.destroy();
  }
});

// On WS connect, send init event
wss.onConnect((client) => {
  const agents = db.listAgents();
  const threads = db.getDashboardThreads();
  const proxies = db.listProxies();
  wss.send(client, JSON.stringify({
    type: 'init',
    agents,
    threads,
    proxies,
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

setInterval(() => {
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

function shutdown(): void {
  console.log('[orchestrator] Shutting down...');
  healthMonitor.stop();

  // Save agent states for network restore
  try {
    const count = shutdownAgents(lifecycleCtx);
    console.log(`[orchestrator] Suspended ${count} agents for restore`);
  } catch (err) {
    console.error('[orchestrator] Error during agent shutdown:', err);
  }

  wss.close();
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ──

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[orchestrator] Listening on port ${PORT}`);
  console.log(`[orchestrator] Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`[orchestrator] DB: ${DB_PATH}`);

  // Start health monitor
  healthMonitor.start();

  // Attempt network restore for agents that were running before last shutdown/crash
  try {
    const restored = await restoreAllAgents(lifecycleCtx);
    if (restored > 0) {
      console.log(`[orchestrator] Network restore: resumed ${restored} agents`);
    }
  } catch (err) {
    console.error('[orchestrator] Network restore failed:', err);
  }
});
