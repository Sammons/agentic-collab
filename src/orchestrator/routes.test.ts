import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

/** Helper to build a MessageDispatcher for tests */
function makeTestDispatcher(db: Database, locks: LockManager, proxyDispatch: (id: string, cmd: ProxyCommand) => Promise<ProxyResponse>): MessageDispatcher {
  return new MessageDispatcher({ db, locks, proxyDispatch, orchestratorHost: 'http://localhost:3000' });
}

describe('API Routes', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-routes-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    proxyCommands = [];

    const mockProxyDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);
      return { ok: true };
    };

    const locks = new LockManager(db.rawDb);
    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html><body>Dashboard</body></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null, // no auth for base tests
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  // ── Dashboard ──

  it('GET /dashboard serves HTML', async () => {
    const resp = await fetch(`http://localhost:${port}/dashboard`);
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('Dashboard'));
  });

  // ── Agent CRUD ──

  it('POST /api/agents creates an agent', async () => {
    const { status, data } = await api('POST', '/api/agents', {
      name: 'api-agent-1',
      engine: 'claude',
      model: 'opus',
      thinking: 'high',
      cwd: '/tmp/test',
      proxyId: 'proxy-test',
    });
    assert.equal(status, 201);
    assert.equal((data as Record<string, unknown>).name, 'api-agent-1');
    assert.equal((data as Record<string, unknown>).state, 'void');
  });

  it('POST /api/agents rejects duplicate', async () => {
    const { status } = await api('POST', '/api/agents', {
      name: 'api-agent-1',
      engine: 'claude',
      cwd: '/tmp',
    });
    assert.equal(status, 409);
  });

  it('POST /api/agents validates required fields', async () => {
    const { status } = await api('POST', '/api/agents', { name: 'no-engine' });
    assert.equal(status, 400);
  });

  it('GET /api/agents lists agents', async () => {
    const { status, data } = await api('GET', '/api/agents');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok((data as Array<Record<string, unknown>>).some(a => a.name === 'api-agent-1'));
  });

  it('GET /api/agents/:name retrieves single agent', async () => {
    const { status, data } = await api('GET', '/api/agents/api-agent-1');
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).name, 'api-agent-1');
  });

  it('GET /api/agents/:name returns 404 for missing', async () => {
    const { status } = await api('GET', '/api/agents/nope');
    assert.equal(status, 404);
  });

  it('agent state can be updated via DB for test setup', () => {
    const agent = db.getAgent('api-agent-1')!;
    const updated = db.updateAgentState('api-agent-1', 'active', agent.version, {
      tmuxSession: 'agent-api-agent-1',
    });
    assert.equal(updated.state, 'active');
    assert.equal(updated.tmuxSession, 'agent-api-agent-1');
  });

  it('DELETE /api/agents/:name deletes agent', async () => {
    await api('POST', '/api/agents', { name: 'del-agent', engine: 'claude', cwd: '/tmp' });
    const { status } = await api('DELETE', '/api/agents/del-agent');
    assert.equal(status, 200);

    const { status: s2 } = await api('GET', '/api/agents/del-agent');
    assert.equal(s2, 404);
  });

  // ── Dashboard Messages ──

  it('POST /api/dashboard/send enqueues message', async () => {
    // Register a proxy first
    db.registerProxy('proxy-test', 'tok', 'localhost:3100');

    const { status, data } = await api('POST', '/api/dashboard/send', {
      agent: 'api-agent-1',
      message: 'Hello from dashboard',
      topic: 'testing',
    });
    assert.equal(status, 202);
    assert.ok((data as Record<string, unknown>).ok);
    assert.ok((data as Record<string, unknown>).queueId);
    assert.equal((data as Record<string, unknown>).status, 'pending');
  });

  it('POST /api/dashboard/reply stores reply', async () => {
    const { status, data } = await api('POST', '/api/dashboard/reply', {
      agent: 'api-agent-1',
      message: 'Reply from agent',
      topic: 'testing',
    });
    assert.equal(status, 200);
    const msg = (data as Record<string, unknown>).msg as Record<string, unknown>;
    assert.equal(msg.direction, 'from_agent');
  });

  it('GET /api/dashboard/threads returns threads', async () => {
    const { status, data } = await api('GET', '/api/dashboard/threads');
    assert.equal(status, 200);
    const threads = data as Record<string, Array<Record<string, unknown>>>;
    assert.ok(threads['api-agent-1']);
    assert.ok(threads['api-agent-1']!.length >= 2);
  });

  it('GET /api/dashboard/threads?agent= filters by agent', async () => {
    const { status, data } = await api('GET', '/api/dashboard/threads?agent=api-agent-1');
    assert.equal(status, 200);
    const threads = data as Record<string, Array<Record<string, unknown>>>;
    assert.ok(threads['api-agent-1']);
  });

  // ── Agent Actions ──

  it('POST /api/agents/:name/interrupt sends escape keys', async () => {
    proxyCommands = [];
    const { status } = await api('POST', '/api/agents/api-agent-1/interrupt');
    assert.equal(status, 200);
    assert.ok(proxyCommands.some(c => c.action === 'send_keys'));
  });

  it('POST /api/agents/:name/compact sends compact command', async () => {
    proxyCommands = [];
    const { status } = await api('POST', '/api/agents/api-agent-1/compact');
    assert.equal(status, 200);
    assert.ok(proxyCommands.some(c => c.action === 'paste'));
  });

  it('POST /api/agents/:name/kill kills session', async () => {
    proxyCommands = [];
    const { status } = await api('POST', '/api/agents/api-agent-1/kill');
    assert.equal(status, 200);
    assert.ok(proxyCommands.some(c => c.action === 'kill_session'));

    // Agent should be suspended after kill
    const agent = db.getAgent('api-agent-1');
    assert.equal(agent?.state, 'suspended');
  });

  // ── Proxy Registration ──

  it('POST /api/proxy/register registers proxy', async () => {
    const { status, data } = await api('POST', '/api/proxy/register', {
      proxyId: 'new-proxy',
      token: 'new-token',
      host: 'localhost:3200',
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).proxyId, 'new-proxy');
  });

  it('POST /api/proxy/heartbeat updates heartbeat', async () => {
    const { status } = await api('POST', '/api/proxy/heartbeat', { proxyId: 'new-proxy' });
    assert.equal(status, 200);
  });

  it('POST /api/proxy/heartbeat rejects unknown proxy', async () => {
    const { status } = await api('POST', '/api/proxy/heartbeat', { proxyId: 'unknown' });
    assert.equal(status, 404);
  });

  it('GET /api/proxies lists proxies', async () => {
    const { status, data } = await api('GET', '/api/proxies');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('DELETE /api/proxy/:proxyId removes proxy', async () => {
    const { status } = await api('DELETE', '/api/proxy/new-proxy');
    assert.equal(status, 200);
    const proxy = db.getProxy('new-proxy');
    assert.equal(proxy, undefined);
  });

  // ── Events ──

  it('GET /api/events/:agentName returns events', async () => {
    const { status, data } = await api('GET', '/api/events/api-agent-1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  // ── 404 ──

  it('returns 404 for unknown routes', async () => {
    const { status } = await api('GET', '/api/nonexistent');
    assert.equal(status, 404);
  });

  // ── Inter-agent messaging ──

  it('POST /api/agents/send enqueues message', async () => {
    // Need agent with proxy and tmux session
    db.updateAgentState('api-agent-1', 'active', db.getAgent('api-agent-1')!.version, {
      proxyId: 'proxy-test',
      tmuxSession: 'agent-api-agent-1',
    });

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'api-agent-1',
      message: 'Test inter-agent message',
      re: 'test-topic',
    });

    assert.equal(status, 202);
    assert.ok((data as Record<string, unknown>).messageId);
    assert.ok((data as Record<string, unknown>).queueId);
    assert.equal((data as Record<string, unknown>).status, 'pending');
  });

  it('POST /api/agents/send rejects unknown target', async () => {
    const { status } = await api('POST', '/api/agents/send', {
      from: 'a',
      to: 'nonexistent',
      message: 'hello',
    });
    assert.equal(status, 404);
  });

  it('GET /api/queue returns queued messages', async () => {
    const { status, data } = await api('GET', '/api/queue?agent=api-agent-1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok((data as Array<Record<string, unknown>>).length > 0);
  });

  // ── Lifecycle Routes ──

  it('POST /api/agents/:name/suspend suspends active agent', async () => {
    // Ensure agent is active
    const a = db.getAgent('api-agent-1');
    if (a && a.state !== 'active') {
      db.updateAgentState('api-agent-1', 'active', a.version, {
        proxyId: 'proxy-test',
        tmuxSession: 'agent-api-agent-1',
      });
    }

    const { status, data } = await api('POST', '/api/agents/api-agent-1/suspend');
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).state, 'suspended');
  });

  it('POST /api/agents/:name/resume resumes suspended agent', async () => {
    const { status, data } = await api('POST', '/api/agents/api-agent-1/resume');
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).state, 'active');
  });

  it('POST /api/agents/:name/reload queues reload (non-immediate)', async () => {
    const { status, data } = await api('POST', '/api/agents/api-agent-1/reload', {
      task: 'check this',
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).reloadQueued, 1);
  });

  it('POST /api/agents/:name/destroy removes agent', async () => {
    // Create a disposable agent
    await api('POST', '/api/agents', { name: 'to-destroy', engine: 'claude', cwd: '/tmp' });

    const { status } = await api('POST', '/api/agents/to-destroy/destroy');
    assert.equal(status, 200);

    const { status: s2 } = await api('GET', '/api/agents/to-destroy');
    assert.equal(s2, 404);
  });

  // ── Orchestrator Control ──

  it('GET /api/orchestrator/status returns stats', async () => {
    const { status, data } = await api('GET', '/api/orchestrator/status');
    assert.equal(status, 200);
    assert.ok(typeof (data as Record<string, unknown>).totalAgents === 'number');
  });

  it('POST /api/orchestrator/shutdown suspends running agents', async () => {
    const { status, data } = await api('POST', '/api/orchestrator/shutdown');
    assert.equal(status, 200);
    assert.ok(typeof (data as Record<string, unknown>).suspended === 'number');
  });

  it('POST /api/orchestrator/restore restores agents', async () => {
    const { status, data } = await api('POST', '/api/orchestrator/restore');
    assert.equal(status, 200);
    assert.ok(typeof (data as Record<string, unknown>).restored === 'number');
  });
});

describe('API Routes — Auth', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const SECRET = 'test-secret-xyz';

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-auth-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const authLocks = new LockManager(db.rawDb);
    const authDispatch = async () => ({ ok: true as const });
    const ctx: RouteContext = {
      db,
      wss,
      locks: authLocks,
      proxyDispatch: authDispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: SECRET,
      messageDispatcher: makeTestDispatcher(db, authLocks, authDispatch),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function apiAuth(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers['authorization'] = `Bearer ${token}`;

    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('GET requests bypass auth', async () => {
    const { status } = await apiAuth('GET', '/api/agents');
    assert.equal(status, 200);
  });

  it('POST without token returns 401', async () => {
    const { status } = await apiAuth('POST', '/api/agents', {
      name: 'auth-test', engine: 'claude', cwd: '/tmp',
    });
    assert.equal(status, 401);
  });

  it('POST with wrong token returns 401', async () => {
    const { status } = await apiAuth('POST', '/api/agents', {
      name: 'auth-test', engine: 'claude', cwd: '/tmp',
    }, 'wrong-secret');
    assert.equal(status, 401);
  });

  it('POST with correct token succeeds', async () => {
    const { status } = await apiAuth('POST', '/api/agents', {
      name: 'auth-test', engine: 'claude', cwd: '/tmp',
    }, SECRET);
    assert.equal(status, 201);
  });

  it('DELETE with correct token succeeds', async () => {
    const { status } = await apiAuth('DELETE', '/api/agents/auth-test', undefined, SECRET);
    assert.equal(status, 200);
  });

  it('DELETE without token returns 401', async () => {
    const { status } = await apiAuth('DELETE', '/api/agents/auth-test');
    assert.equal(status, 401);
  });
});

describe('API Routes — Rate Limiting', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const SECRET = 'rate-limit-secret';

  before(async () => {
    // Override rate limit env for testing: very low limits
    process.env['RATE_LIMIT_MAX'] = '5';
    process.env['RATE_LIMIT_UPLOAD_MAX'] = '3';
    process.env['RATE_LIMIT_WINDOW_MS'] = '60000';

    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-rate-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const rateLocks = new LockManager(db.rawDb);
    const rateDispatch = async () => ({ ok: true as const });
    const ctx: RouteContext = {
      db,
      wss,
      locks: rateLocks,
      proxyDispatch: rateDispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: SECRET,
      messageDispatcher: makeTestDispatcher(db, rateLocks, rateDispatch),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['RATE_LIMIT_MAX'];
    delete process.env['RATE_LIMIT_UPLOAD_MAX'];
    delete process.env['RATE_LIMIT_WINDOW_MS'];
  });

  it('GET requests are not rate limited', async () => {
    // GET should work unlimited times
    for (let i = 0; i < 10; i++) {
      const resp = await fetch(`http://localhost:${port}/api/agents`);
      assert.equal(resp.status, 200);
    }
  });

  it('unauthenticated POST requests are rejected with 401 before rate limit applies', async () => {
    // Should get 401, not 429
    const resp = await fetch(`http://localhost:${port}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', engine: 'claude', cwd: '/tmp' }),
    });
    assert.equal(resp.status, 401);
  });
});

describe('API Routes — Personas', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let personasDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-persona-route-test-'));
    personasDir = join(tmpDir, 'personas');
    process.env['PERSONAS_DIR'] = personasDir;
    mkdtempSync; // force eval
    const { mkdirSync } = await import('node:fs');
    mkdirSync(personasDir, { recursive: true });

    writeFileSync(join(personasDir, 'researcher.md'), '# Researcher\nYou are a research agent.');
    writeFileSync(join(personasDir, 'builder.md'), '# Builder\nYou build things.');

    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const personaLocks = new LockManager(db.rawDb);
    const personaDispatch = async () => ({ ok: true as const });
    const ctx: RouteContext = {
      db,
      wss,
      locks: personaLocks,
      proxyDispatch: personaDispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, personaLocks, personaDispatch),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    delete process.env['PERSONAS_DIR'];
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('GET /api/personas lists persona files', async () => {
    const { status, data } = await api('GET', '/api/personas');
    assert.equal(status, 200);
    const personas = data as Array<{ name: string; filename: string }>;
    assert.equal(personas.length, 2);
    assert.equal(personas[0]!.name, 'builder');
    assert.equal(personas[1]!.name, 'researcher');
  });

  it('GET /api/personas/:name returns persona content', async () => {
    const { status, data } = await api('GET', '/api/personas/researcher');
    assert.equal(status, 200);
    const persona = data as { name: string; content: string };
    assert.equal(persona.name, 'researcher');
    assert.ok(persona.content.includes('research agent'));
  });

  it('GET /api/personas/:name returns 404 for missing persona', async () => {
    const { status } = await api('GET', '/api/personas/nonexistent');
    assert.equal(status, 404);
  });

  it('GET /api/personas/:name rejects invalid names', async () => {
    const { status } = await api('GET', '/api/personas/..etc');
    assert.equal(status, 400);
  });

  it('PUT /api/personas/:name creates a new persona', async () => {
    const { status, data } = await api('PUT', '/api/personas/tester', {
      content: '# Tester\nYou test things.',
    });
    assert.equal(status, 200);
    const persona = data as { name: string; content: string };
    assert.equal(persona.name, 'tester');
    assert.ok(persona.content.includes('test things'));

    // Verify it shows up in list
    const { data: list } = await api('GET', '/api/personas');
    const personas = list as Array<{ name: string }>;
    assert.ok(personas.some(p => p.name === 'tester'));
  });

  it('PUT /api/personas/:name updates an existing persona', async () => {
    const { status, data } = await api('PUT', '/api/personas/builder', {
      content: '# Builder v2\nYou build better things.',
    });
    assert.equal(status, 200);
    const persona = data as { name: string; content: string };
    assert.ok(persona.content.includes('better things'));
  });

  it('PUT /api/personas/:name rejects missing content', async () => {
    const { status } = await api('PUT', '/api/personas/bad', {});
    assert.equal(status, 400);
  });

  it('PUT /api/personas/:name rejects invalid names', async () => {
    const { status } = await api('PUT', '/api/personas/..etc', {
      content: 'evil',
    });
    assert.equal(status, 400);
  });
});
