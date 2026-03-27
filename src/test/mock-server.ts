/**
 * Mock backend for UI testing.
 * Serves the real dashboard HTML (with test probe injected), fake API responses,
 * and a test control API for driving state changes from tests.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentRecord, DashboardMessage, ActiveIndicator, ProxyRegistration, WsInitEvent, WsAgentUpdateEvent, WsMessageEvent, WsIndicatorUpdateEvent } from '../shared/types.ts';

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
      proxyHost: null,
      agentGroup: null,
      launchEnv: null,
      sortOrder: 0,
      hookStart: null,
      hookResume: null,
      hookCompact: null,
      hookExit: null,
      hookInterrupt: null,
      hookSubmit: null,
      hookDetectSession: null,
      detectSessionRegex: null,
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
      proxyHost: null,
      agentGroup: null,
      launchEnv: null,
      sortOrder: 1,
      hookStart: null,
      hookResume: null,
      hookCompact: null,
      hookExit: null,
      hookInterrupt: null,
      hookSubmit: null,
      hookDetectSession: null,
      detectSessionRegex: null,
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
      proxyHost: null,
      agentGroup: null,
      launchEnv: null,
      sortOrder: 2,
      hookStart: null,
      hookResume: null,
      hookCompact: null,
      hookExit: null,
      hookInterrupt: null,
      hookSubmit: null,
      hookDetectSession: null,
      detectSessionRegex: null,
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

// ── Fixture State ──

type FixtureState = {
  agents: AgentRecord[];
  threads: Record<string, DashboardMessage[]>;
  proxies: ProxyRegistration[];
  indicators: Record<string, ActiveIndicator[]>;
  messageIdCounter: number;
};

function createFixtureState(): FixtureState {
  return {
    agents: makeDefaultAgents(),
    threads: {},
    proxies: [...DEFAULT_PROXIES],
    indicators: {},
    messageIdCounter: 1,
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

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

    // ── API: agents ──
    if (method === 'GET' && path === '/api/agents') {
      json(res, fixtures.agents);
      return;
    }

    // ── API: dashboard threads ──
    if (method === 'GET' && path === '/api/dashboard/threads') {
      json(res, fixtures.threads);
      return;
    }

    // ── API: proxies ──
    if (method === 'GET' && path === '/api/proxies') {
      json(res, fixtures.proxies);
      return;
    }

    // ── API: reminders ──
    if (method === 'GET' && path === '/api/reminders') {
      json(res, []);
      return;
    }

    // ── API: personas ──
    if (method === 'GET' && path.startsWith('/api/personas/')) {
      json(res, { error: 'not found' }, 404);
      return;
    }

    // ── API: voice status ──
    if (method === 'GET' && path === '/api/voice/status') {
      json(res, { enabled: false });
      return;
    }

    // ── Test Control: set-agents ──
    if (method === 'POST' && path === '/test/set-agents') {
      const body = JSON.parse(await readBody(req)) as Partial<AgentRecord>[];
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
      json(res, { ok: true });
      return;
    }

    // ── Test Control: send-message ──
    if (method === 'POST' && path === '/test/send-message') {
      const body = JSON.parse(await readBody(req)) as {
        agent: string;
        direction?: string;
        message: string;
        topic?: string;
      };
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
      json(res, { ok: true });
      return;
    }

    // ── Test Control: trigger-indicator ──
    if (method === 'POST' && path === '/test/trigger-indicator') {
      const body = JSON.parse(await readBody(req)) as {
        agentName: string;
        indicators: ActiveIndicator[];
      };
      fixtures.indicators[body.agentName] = body.indicators;
      const event: WsIndicatorUpdateEvent = {
        type: 'indicator_update',
        agentName: body.agentName,
        indicators: body.indicators,
      };
      wss.broadcast(JSON.stringify(event));
      json(res, { ok: true });
      return;
    }

    // ── Test Control: reset ──
    if (method === 'POST' && path === '/test/reset') {
      const fresh = createFixtureState();
      fixtures.agents = fresh.agents;
      fixtures.threads = fresh.threads;
      fixtures.proxies = fresh.proxies;
      fixtures.indicators = fresh.indicators;
      fixtures.messageIdCounter = fresh.messageIdCounter;
      json(res, { ok: true });
      return;
    }

    // ── POST catch-all ──
    if (method === 'POST') {
      // Drain body before responding
      await readBody(req);
      json(res, { ok: true });
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
