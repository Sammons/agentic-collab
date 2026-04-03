/**
 * Mock backend for UI testing.
 * Serves the real dashboard HTML (with test probe injected), fake API responses,
 * and a test control API for driving state changes from tests.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentRecord, DashboardMessage, ActiveIndicator, EngineConfigRecord, ProxyRegistration, WsInitEvent, WsAgentUpdateEvent, WsMessageEvent, WsIndicatorUpdateEvent } from '../shared/types.ts';

// ── Fixture Defaults ──

const now = new Date().toISOString();

function makeDefaultAgents(): AgentRecord[] {
  return [
    {
      name: 'test-claude',
      engine: 'claude',
      model: 'opus',
      thinking: null,
      cwd: '/tmp',
      persona: null,
      permissions: null,
      agentGroup: null,
      launchEnv: null,
      sortOrder: 0,
      hookStart: null,
      hookResume: null,
      hookCompact: null,
      hookExit: null,
      hookInterrupt: null,
      hookSubmit: null,
      state: 'idle',
      stateBeforeShutdown: null,
      currentSessionId: null,
      tmuxSession: 'agent-test-claude',
      proxyId: 'test-proxy',
      lastActivity: now,
      lastContextPct: null,
      reloadQueued: 0,
      reloadTask: null,
      failedAt: null,
      failureReason: null,
      capturedVars: null,
      customButtons: null,
      indicators: null,
      icon: null,
      version: 1,
      spawnCount: 1,
      createdAt: now,
    },
    {
      name: 'test-codex',
      engine: 'codex',
      model: 'o3',
      thinking: null,
      cwd: '/tmp',
      persona: null,
      permissions: null,
      agentGroup: null,
      launchEnv: null,
      sortOrder: 1,
      hookStart: null,
      hookResume: null,
      hookCompact: null,
      hookExit: null,
      hookInterrupt: null,
      hookSubmit: null,
      state: 'active',
      stateBeforeShutdown: null,
      currentSessionId: null,
      tmuxSession: 'agent-test-codex',
      proxyId: 'test-proxy',
      lastActivity: now,
      lastContextPct: null,
      reloadQueued: 0,
      reloadTask: null,
      failedAt: null,
      failureReason: null,
      capturedVars: null,
      customButtons: null,
      indicators: null,
      icon: null,
      version: 1,
      spawnCount: 1,
      createdAt: now,
    },
    {
      name: 'test-failed',
      engine: 'claude',
      model: 'opus',
      thinking: null,
      cwd: '/tmp',
      persona: null,
      permissions: null,
      agentGroup: null,
      launchEnv: null,
      sortOrder: 2,
      hookStart: null,
      hookResume: null,
      hookCompact: null,
      hookExit: null,
      hookInterrupt: null,
      hookSubmit: null,
      state: 'failed',
      stateBeforeShutdown: null,
      currentSessionId: null,
      tmuxSession: 'agent-test-failed',
      proxyId: 'test-proxy',
      lastActivity: now,
      lastContextPct: null,
      reloadQueued: 0,
      reloadTask: null,
      failedAt: new Date().toISOString(),
      failureReason: 'test failure',
      capturedVars: null,
      customButtons: null,
      indicators: null,
      icon: null,
      version: 1,
      spawnCount: 1,
      createdAt: now,
    },
  ];
}

const DEFAULT_PROXIES: ProxyRegistration[] = [
  {
    proxyId: 'test-proxy',
    token: 'test-token',
    host: 'localhost:9000',
    version: '0.1.0',
    versionMatch: true,
    lastHeartbeat: now,
    registeredAt: now,
  },
];

// ── Request/Response & WebSocket Logging ──

export type RequestLogEntry = {
  timestamp: string;
  method: string;
  path: string;
  requestBody: unknown | null;
  responseStatus: number;
  responseBody: unknown | null;
};

export type WsLogEntry = {
  timestamp: string;
  direction: 'sent' | 'received';
  data: unknown;
};

// ── Fixture State ──

type FixtureState = {
  agents: AgentRecord[];
  engineConfigs: EngineConfigRecord[];
  threads: Record<string, DashboardMessage[]>;
  proxies: ProxyRegistration[];
  indicators: Record<string, ActiveIndicator[]>;
  personas: Record<string, unknown>;
  messageIdCounter: number;
  requestLog: RequestLogEntry[];
  wsLog: WsLogEntry[];
};

function createFixtureState(): FixtureState {
  return {
    agents: makeDefaultAgents(),
    engineConfigs: [],
    threads: {},
    proxies: [...DEFAULT_PROXIES],
    indicators: {},
    personas: {},
    messageIdCounter: 1,
    requestLog: [],
    wsLog: [],
  };
}

// ── HTTP Helpers ──

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Server ──

export type MockServer = {
  server: Server;
  wss: WebSocketServer;
  url: string;
  close(): void;
};

export async function startMockServer(port: number): Promise<MockServer> {
  const fixtures = createFixtureState();
  const wss = new WebSocketServer();

  // Read the real dashboard HTML and probe script paths
  const dashboardPath = join(import.meta.dirname, '..', 'dashboard', 'index.html');
  const probePath = join(import.meta.dirname, 'probe.ts');

  function getDashboardHtml(probePort: number): string {
    const raw = readFileSync(dashboardPath, 'utf-8');
    // Inject probe script before </body>
    const probeTag = `<script src="/test-probe.js"></script>`;
    return raw.replace('</body>', `${probeTag}\n</body>`);
  }

  function getProbeScript(probePort: number): string {
    const raw = readFileSync(probePath, 'utf-8');
    // Replace the probe port placeholder
    return raw.replace('__PROBE_PORT__', String(probePort));
  }

  // Wrap wss.broadcast to log WS messages
  const origBroadcast = wss.broadcast.bind(wss);
  wss.broadcast = (data: string) => {
    try {
      fixtures.wsLog.push({ timestamp: new Date().toISOString(), direction: 'sent', data: JSON.parse(data) });
    } catch {
      fixtures.wsLog.push({ timestamp: new Date().toISOString(), direction: 'sent', data });
    }
    return origBroadcast(data);
  };

  // Logging-aware json helper — captures response data for the request log
  function logJson(r: ServerResponse, data: unknown, status = 200): void {
    (r as ServerResponse & { __logBody: unknown }).__logBody = data;
    (r as ServerResponse & { __logStatus: number }).__logStatus = status;
    json(r, data, status);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Capture request body for logging (stored once, used below and by handler)
    let parsedRequestBody: unknown = null;

    // Log every completed request/response pair (except test control endpoints for the log itself)
    res.on('finish', () => {
      if (path === '/test/request-log' || path === '/test/reset') return; // don't log meta-queries or resets
      fixtures.requestLog.push({
        timestamp: new Date().toISOString(),
        method,
        path,
        requestBody: parsedRequestBody,
        responseStatus: (res as ServerResponse & { __logStatus?: number }).__logStatus ?? res.statusCode,
        responseBody: (res as ServerResponse & { __logBody?: unknown }).__logBody ?? null,
      });
    });

    // ── CORS preflight ──
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }

    // ── Dashboard ──
    if (method === 'GET' && path === '/dashboard') {
      // Always inject the in-page probe (handles DOM interaction).
      // The chrome extension handles screenshots separately via its own WS channel.
      const html = getDashboardHtml(port + 1);
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    // ── Probe script ──
    if (method === 'GET' && path === '/test-probe.js') {
      const script = getProbeScript(port + 1);
      res.writeHead(200, {
        'content-type': 'application/javascript',
        'content-length': Buffer.byteLength(script),
      });
      res.end(script);
      return;
    }

    // ── Dashboard assets (JS/TS/CSS) ──
    if (method === 'GET' && path.startsWith('/dashboard/assets/')) {
      const filePath = path.replace('/dashboard/assets/', '');
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      const types: Record<string, string> = { '.js': 'application/javascript; charset=utf-8', '.ts': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      const contentType = types[ext];
      if (filePath.includes('..') || !contentType) { res.writeHead(400); res.end('Bad request'); return; }
      try {
        const fullPath = join(import.meta.dirname!, '..', 'dashboard', filePath);
        const content = readFileSync(fullPath, 'utf-8');
        res.writeHead(200, { 'content-type': contentType });
        res.end(content);
      } catch { res.writeHead(404); res.end('Not found'); }
      return;
    }

    // ── API: agents ──
    if (method === 'GET' && path === '/api/agents') {
      logJson(res, fixtures.agents);
      return;
    }

    // ── API: dashboard threads ──
    if (method === 'GET' && path === '/api/dashboard/threads') {
      logJson(res, fixtures.threads);
      return;
    }

    // ── API: proxies ──
    if (method === 'GET' && path === '/api/proxies') {
      logJson(res, fixtures.proxies);
      return;
    }

    // ── API: reminders ──
    if (method === 'GET' && path === '/api/reminders') {
      logJson(res, []);
      return;
    }

    // ── API: personas ──
    if (method === 'GET' && path.startsWith('/api/personas/')) {
      const name = path.replace('/api/personas/', '');
      const persona = fixtures.personas[name];
      if (persona) {
        logJson(res, persona);
      } else {
        logJson(res, { error: 'not found' }, 404);
      }
      return;
    }

    // ── API: engine configs ──
    if (method === 'GET' && path === '/api/engine-configs') {
      logJson(res, fixtures.engineConfigs);
      return;
    }

    // ── API: voice status ──
    if (method === 'GET' && path === '/api/voice/status') {
      logJson(res, { enabled: false });
      return;
    }

    // ── Test Control: request-log ──
    if (method === 'GET' && path === '/test/request-log') {
      json(res, fixtures.requestLog);
      return;
    }

    // ── Test Control: set-agents ──
    if (method === 'POST' && path === '/test/set-agents') {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as Partial<AgentRecord>[];
      parsedRequestBody = body;
      for (const partial of body) {
        if (!partial.name) continue;
        const existing = fixtures.agents.find((a) => a.name === partial.name);
        if (existing) {
          Object.assign(existing, partial);
          const event: WsAgentUpdateEvent = { type: 'agent_update', agent: existing };
          wss.broadcast(JSON.stringify(event));
        } else {
          const full = { ...makeDefaultAgents()[0]!, ...partial } as AgentRecord;
          fixtures.agents.push(full);
          const event: WsAgentUpdateEvent = { type: 'agent_update', agent: full };
          wss.broadcast(JSON.stringify(event));
        }
      }
      logJson(res, { ok: true });
      return;
    }

    // ── Test Control: set-personas ──
    if (method === 'POST' && path === '/test/set-personas') {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      parsedRequestBody = body;
      Object.assign(fixtures.personas, body);
      logJson(res, { ok: true });
      return;
    }

    // ── Test Control: send-message ──
    if (method === 'POST' && path === '/test/send-message') {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as {
        agent: string;
        direction?: string;
        message: string;
        topic?: string;
      };
      parsedRequestBody = body;
      const msg: DashboardMessage = {
        id: fixtures.messageIdCounter++,
        agent: body.agent,
        direction: (body.direction as 'to_agent' | 'from_agent') ?? 'from_agent',
        sourceAgent: null,
        targetAgent: null,
        topic: body.topic ?? null,
        message: body.message,
        queueId: null,
        deliveryStatus: null,
        withdrawn: false,
        createdAt: new Date().toISOString(),
        archivedAt: null,
      };
      if (!fixtures.threads[body.agent]) {
        fixtures.threads[body.agent] = [];
      }
      fixtures.threads[body.agent]!.push(msg);
      const event: WsMessageEvent = { type: 'message', msg };
      wss.broadcast(JSON.stringify(event));
      logJson(res, { ok: true });
      return;
    }

    // ── Test Control: set-engine-configs ──
    if (method === 'POST' && path === '/test/set-engine-configs') {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as EngineConfigRecord[];
      parsedRequestBody = body;
      fixtures.engineConfigs = body;
      logJson(res, { ok: true });
      return;
    }

    // ── Test Control: trigger-indicator ──
    if (method === 'POST' && path === '/test/trigger-indicator') {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as {
        agentName: string;
        indicators: ActiveIndicator[];
      };
      parsedRequestBody = body;
      fixtures.indicators[body.agentName] = body.indicators;
      const event: WsIndicatorUpdateEvent = {
        type: 'indicator_update',
        agentName: body.agentName,
        indicators: body.indicators,
      };
      wss.broadcast(JSON.stringify(event));
      logJson(res, { ok: true });
      return;
    }

    // ── Test Control: reset ──
    if (method === 'POST' && path === '/test/reset') {
      const fresh = createFixtureState();
      fixtures.agents = fresh.agents;
      fixtures.engineConfigs = fresh.engineConfigs;
      fixtures.threads = fresh.threads;
      fixtures.proxies = fresh.proxies;
      fixtures.indicators = fresh.indicators;
      fixtures.messageIdCounter = fresh.messageIdCounter;
      fixtures.requestLog = fresh.requestLog;
      fixtures.wsLog = fresh.wsLog;
      logJson(res, { ok: true });
      return;
    }

    // ── POST catch-all ──
    if (method === 'POST') {
      // Drain body before responding
      const rawBody = await readBody(req);
      try { parsedRequestBody = JSON.parse(rawBody); } catch { parsedRequestBody = rawBody || null; }
      logJson(res, { ok: true });
      return;
    }

    // ── 404 ──
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  // ── WebSocket: dashboard WS ──
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // Send init event on WS connect
  wss.onConnect((client) => {
    const initEvent: WsInitEvent = {
      type: 'init',
      agents: fixtures.agents,
      engineConfigs: fixtures.engineConfigs,
      threads: fixtures.threads,
      proxies: fixtures.proxies,
      unreadCounts: {},
      indicators: fixtures.indicators,
    };
    wss.send(client, JSON.stringify(initEvent));
  });

  // Listen
  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  return {
    server,
    wss,
    url: `http://localhost:${port}`,
    close() {
      wss.close();
      server.close();
    },
  };
}
