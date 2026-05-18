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
import { AccountStore } from './accounts.ts';
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
      if (command.action === 'capture') {
        return { ok: true, data: '> prompt\n' };
      }
      if (command.action === 'display_message') {
        return { ok: true, data: '#{session_name}:0.0' };
      }
      if (command.action === 'has_session') {
        return { ok: true, data: true };
      }
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
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
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

  it('POST /api/agents accepts optional group field', async () => {
    const { status, data } = await api('POST', '/api/agents', {
      name: 'api-agent-grouped',
      engine: 'claude',
      cwd: '/tmp/test',
      group: 'infra',
    });
    assert.equal(status, 201);
    assert.equal((data as Record<string, unknown>).agentGroup, 'infra');
  });

  it('PATCH /api/agents/:name/group updates and returns the agent', async () => {
    // Ensure agent exists (created in earlier test)
    const { status, data } = await api('PATCH', '/api/agents/api-agent-grouped/group', { group: 'platform' });
    assert.equal(status, 200);
    // Verify the group actually persisted
    const { data: agent } = await api('GET', '/api/agents/api-agent-grouped');
    assert.equal((agent as Record<string, unknown>).agentGroup, 'platform');
  });

  it('PATCH /api/agents/:name/group returns 404 for unknown agent', async () => {
    const { status } = await api('PATCH', '/api/agents/nonexistent-agent/group', { group: 'x' });
    assert.equal(status, 404);
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

  // ── Read Cursor ──

  it('PUT /api/dashboard/read-cursor updates cursor', async () => {
    const { status, data } = await api('PUT', '/api/dashboard/read-cursor', { agent: 'api-agent-1' });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).ok, true);
  });

  it('PUT /api/dashboard/read-cursor rejects missing agent', async () => {
    const { status } = await api('PUT', '/api/dashboard/read-cursor', {});
    assert.equal(status, 400);
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

  it('POST /api/proxy/register includes version match info', async () => {
    const { status, data } = await api('POST', '/api/proxy/register', {
      proxyId: 'versioned-proxy',
      token: 'v-token',
      host: 'localhost:3300',
      version: 'test-sha-abc',
    });
    assert.equal(status, 200);
    const result = data as Record<string, unknown>;
    assert.equal(result['proxyId'], 'versioned-proxy');
    assert.equal(result['version'], 'test-sha-abc');
    // orchestratorVersion should be present in response
    assert.ok('orchestratorVersion' in result);
    // versionMatch should be false since test-sha-abc won't match
    assert.equal(result['versionMatch'], false);
  });

  it('POST /api/proxy/register without version sets versionMatch false', async () => {
    const { status, data } = await api('POST', '/api/proxy/register', {
      proxyId: 'no-version-proxy',
      token: 'nv-token',
      host: 'localhost:3400',
    });
    assert.equal(status, 200);
    const result = data as Record<string, unknown>;
    assert.equal(result['version'], null);
    assert.equal(result['versionMatch'], false);
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
      topic: 'test-topic',
    });

    assert.equal(status, 202);
    assert.ok((data as Record<string, unknown>).messageId);
    assert.ok((data as Record<string, unknown>).queueId);
    assert.equal((data as Record<string, unknown>).status, 'pending');
    const queued = db.listPendingMessages('api-agent-1');
    assert.ok(queued.some(m => m.envelope.includes('collab send dashboard --topic test-topic')));
  });

  it('POST /api/agents/send rejects unknown target', async () => {
    const { status } = await api('POST', '/api/agents/send', {
      from: 'a',
      to: 'nonexistent',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 404);
  });

  // ── Q1: address-prefix routing ──

  it('POST /api/agents/send accepts agent:<name> and stores bare name', async () => {
    const before = db.listPendingMessages('api-agent-1').length;
    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'agent:api-agent-1',
      message: 'addressed send',
      topic: 'test-topic',
    });
    assert.equal(status, 202);
    const body = data as Record<string, unknown>;
    assert.ok(body['queueId']);

    const after = db.listPendingMessages('api-agent-1');
    assert.equal(after.length, before + 1, 'one new pending message should be queued');
    const newest = after.at(-1)!;
    // Storage continues to use the bare name — no prefix leakage.
    assert.equal(newest.targetAgent, 'api-agent-1');
    assert.ok(!newest.targetAgent.includes(':'), 'target_agent must not contain prefix colon');
  });

  it('POST /api/agents/send returns 503 for topic: addresses when topicDelivery not configured', async () => {
    // Q3: when ctx.topicDelivery is absent (this fixture omits it), topic: routes 503.
    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'topic:foo/bar',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 503);
    const body = data as Record<string, unknown>;
    assert.equal(body['error'], 'topic delivery not configured');
  });

  it('POST /api/agents/send returns 503 for approval: addresses (not yet wired)', async () => {
    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'approval:chan',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 503);
    const body = data as Record<string, unknown>;
    assert.equal(body['error'], 'address class not yet wired');
    assert.equal(body['class'], 'approval');
  });

  it('POST /api/agents/send returns 503 for agent:<tmpl>/<inst> addresses with unknown instance', async () => {
    // Q3: instance addresses are delivered synchronously; an unknown instance returns 503.
    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'agent:tmpl/inst-1',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 503);
    const body = data as Record<string, unknown>;
    assert.equal(body['error'], 'instance not deliverable');
    assert.equal(body['reason'], 'instance-not-found');
  });

  it('POST /api/agents/send returns 400 for malformed addresses', async () => {
    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'weird:foo',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 400);
    const body = data as Record<string, unknown>;
    assert.equal(body['error'], 'malformed address');
    assert.equal(typeof body['reason'], 'string');
  });

  it('POST /api/dashboard/send returns 503 for topic: addresses when topicDelivery not configured', async () => {
    // Q3: when ctx.topicDelivery is absent (this fixture omits it), topic: routes 503.
    const { status, data } = await api('POST', '/api/dashboard/send', {
      agent: 'topic:foo/bar',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 503);
    const body = data as Record<string, unknown>;
    assert.equal(body['error'], 'topic delivery not configured');
  });

  it('POST /api/dashboard/send returns 400 for malformed addresses', async () => {
    const { status } = await api('POST', '/api/dashboard/send', {
      agent: 'weird:foo',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 400);
  });

  it('GET /api/queue returns queued messages', async () => {
    const { status, data } = await api('GET', '/api/queue?agent=api-agent-1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok((data as Array<Record<string, unknown>>).length > 0);
  });

  it('POST /api/agents/:name/tmux maps send-keys through the proxy', async () => {
    proxyCommands = [];
    const { status, data } = await api('POST', '/api/agents/api-agent-1/tmux', {
      args: ['send-keys', '/exit', 'Enter'],
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).ok, true);
    assert.deepEqual(proxyCommands.at(-1), {
      action: 'send_keys_raw',
      sessionName: 'agent-api-agent-1',
      keys: ['/exit', 'Enter'],
    });
  });

  it('POST /api/agents/:name/tmux maps display-message through the proxy', async () => {
    proxyCommands = [];
    const { status, data } = await api('POST', '/api/agents/api-agent-1/tmux', {
      args: ['display-message', '-p', '#{session_name}:#{window_index}.#{pane_index}'],
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).data, '#{session_name}:0.0');
    assert.deepEqual(proxyCommands.at(-1), {
      action: 'display_message',
      sessionName: 'agent-api-agent-1',
      format: '#{session_name}:#{window_index}.#{pane_index}',
    });
  });

  it('POST /api/agents/:name/tmux rejects unsupported commands', async () => {
    const { status } = await api('POST', '/api/agents/api-agent-1/tmux', {
      args: ['list-sessions'],
    });
    assert.equal(status, 400);
  });

  // ── Lifecycle Routes ──

  it('POST /api/agents/:name/exit exits (suspends) active agent', async () => {
    // Ensure agent is active
    const a = db.getAgent('api-agent-1');
    if (a && a.state !== 'active') {
      db.updateAgentState('api-agent-1', 'active', a.version, {
        proxyId: 'proxy-test',
        tmuxSession: 'agent-api-agent-1',
      });
    }

    const { status, data } = await api('POST', '/api/agents/api-agent-1/exit');
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
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
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
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
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
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
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

  it('GET /api/personas/:name includes filePath and hostname', async () => {
    const { status, data } = await api('GET', '/api/personas/researcher');
    assert.equal(status, 200);
    const persona = data as { filePath: string; hostname: string };
    assert.ok(persona.filePath.endsWith('/researcher.md'), `expected filePath ending with /researcher.md, got: ${persona.filePath}`);
    // personasDir may differ from the resolved filePath due to symlinks (e.g., /tmp → /private/tmp on macOS)
    const personasDirBasename = personasDir.split('/').pop()!;
    assert.ok(persona.filePath.includes(personasDirBasename), 'filePath should include personas dir basename');
    assert.equal(typeof persona.hostname, 'string');
    assert.ok(persona.hostname.length > 0, 'hostname should not be empty');
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

  it('POST /api/personas creates persona file and agent atomically', async () => {
    const content = '---\nengine: claude\nmodel: opus\ncwd: /my-project\n---\n# Atomic Agent\nDoes atomic things.';
    const { status, data } = await api('POST', '/api/personas', { name: 'atomic-agent', content });
    assert.equal(status, 201);

    const result = data as { persona: { name: string; frontmatter: Record<string, string> }; agent: { name: string; engine: string; cwd: string; state: string } };
    assert.equal(result.persona.name, 'atomic-agent');
    assert.equal(result.persona.frontmatter.engine, 'claude');
    assert.equal(result.agent.name, 'atomic-agent');
    assert.equal(result.agent.engine, 'claude');
    assert.equal(result.agent.cwd, '/my-project');
    assert.equal(result.agent.state, 'void');

    // Verify file exists via GET
    const { status: getStatus, data: getData } = await api('GET', '/api/personas/atomic-agent');
    assert.equal(getStatus, 200);
    assert.ok((getData as { content: string }).content.includes('Atomic Agent'));

    // Verify agent is in agent list
    const { data: agents } = await api('GET', '/api/agents');
    const agentList = agents as Array<{ name: string }>;
    assert.ok(agentList.some(a => a.name === 'atomic-agent'));
  });

  it('POST /api/personas updates existing agent on re-create', async () => {
    const content = '---\nengine: claude\nmodel: sonnet\ncwd: /my-project-v2\n---\n# Atomic Agent v2';
    const { status, data } = await api('POST', '/api/personas', { name: 'atomic-agent', content });
    assert.equal(status, 201);

    const result = data as { agent: { model: string; cwd: string } };
    assert.equal(result.agent.model, 'sonnet');
    assert.equal(result.agent.cwd, '/my-project-v2');
  });

  it('POST /api/personas rejects missing name', async () => {
    const { status } = await api('POST', '/api/personas', { content: '---\nengine: claude\ncwd: /tmp\n---\nBody' });
    assert.equal(status, 400);
  });

  it('POST /api/personas rejects missing content', async () => {
    const { status } = await api('POST', '/api/personas', { name: 'test' });
    assert.equal(status, 400);
  });

  it('POST /api/personas rejects invalid name', async () => {
    const { status } = await api('POST', '/api/personas', { name: '../escape', content: '---\nengine: claude\ncwd: /tmp\n---\n' });
    assert.equal(status, 400);
  });

  it('POST /api/personas rejects content missing required frontmatter', async () => {
    const { status, data } = await api('POST', '/api/personas', { name: 'bad-fm', content: '# No frontmatter' });
    assert.equal(status, 400);
    assert.ok((data as { error: string }).error.includes('engine and cwd are required'));
  });

  it('POST /api/agents/:name/reload syncs persona from disk before reloading', async () => {
    // Create agent via persona with engine: claude
    const initial = '---\nengine: claude\ncwd: /tmp/sync-test\n---\n# Sync Agent\nOriginal.';
    await api('POST', '/api/personas', { name: 'sync-test-agent', content: initial });

    // Verify agent was created with engine=claude
    const { data: before } = await api('GET', '/api/agents/sync-test-agent');
    assert.equal((before as Record<string, unknown>).engine, 'claude');

    // Update persona file on disk to engine: codex
    writeFileSync(
      join(personasDir, 'sync-test-agent.md'),
      '---\nengine: codex\ncwd: /tmp/sync-test\n---\n# Sync Agent\nUpdated to codex.',
    );

    // Reload — this should sync persona from disk first, updating engine in DB
    // Agent is in void state so reload will fail, but syncSinglePersona runs before the lifecycle call
    await api('POST', '/api/agents/sync-test-agent/reload', {});

    // Verify engine was updated in DB regardless of reload outcome
    const { data: after } = await api('GET', '/api/agents/sync-test-agent');
    assert.equal((after as Record<string, unknown>).engine, 'codex');
  });
});

// ── v3 Q3: /api/topics/publish + /api/instances/:id/complete + /api/personas/reload ──

describe('API Routes — v3 Q3 endpoints', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let ipcRoot: string;
  const commandsLog: Array<{ action: string }> = [];

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-q3-test-'));
    ipcRoot = join(tmpDir, 'instances');
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    // Seed one ephemeral template + topic so publish has a target.
    db.upsertAgentTemplate({
      id: 'q3-tmpl',
      personaPath: null,
      engine: 'claude',
      model: null,
      persistent: false,
      cwdBase: '/tmp',
      cwdTemplate: null,
      repoRoot: '/tmp',
      hookStart: 'echo start',
      hookExit: null,
      hookPrepare: null,
      hookCleanup: null,
      createdAt: '',
      updatedAt: '',
    });
    db.replaceTopicsForTemplate('q3-tmpl', [{
      agentTemplate: 'q3-tmpl',
      name: 'echo',
      hookPrepareOverride: null,
      hookStartOverride: null,
      hookCleanupOverride: null,
      monitorTemplate: null,
      concurrency: 1,
      schemaPath: null,
      replySchemaPath: null,
    }]);
    db.registerProxy('p1', 'tok', 'localhost:3100');

    const q3Locks = new LockManager(db.rawDb);
    const q3Dispatch = async (_pid: string, command: ProxyCommand): Promise<ProxyResponse> => {
      commandsLog.push(command);
      return { ok: true, data: '' };
    };
    const q3MsgDispatcher = makeTestDispatcher(db, q3Locks, q3Dispatch);
    // Build the real driver + reaper.
    const { TopicDelivery } = await import('./topic-delivery.ts');
    const { InstanceReaper } = await import('./instance-reaper.ts');
    const driver = new TopicDelivery({ db, proxyDispatch: q3Dispatch, orchestratorHost: 'x', ipcRoot, locks: q3Locks });
    const reaper = new InstanceReaper({ db, proxyDispatch: q3Dispatch, messageDispatcher: q3MsgDispatcher, topicDelivery: driver, sweepIntervalMs: 50 });
    const reloadCalls = { n: 0 };
    const ctx: RouteContext = {
      db,
      wss,
      locks: q3Locks,
      proxyDispatch: q3Dispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: q3MsgDispatcher,
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      topicDelivery: driver,
      instanceReaper: reaper,
      reloadPersonas: () => {
        reloadCalls.n++;
        return { synced: 0, created: [], updated: [], skipped: [] };
      },
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

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('POST /api/topics/publish enqueues a topic message and 202s', async () => {
    const { status, data } = await api('POST', '/api/topics/publish', {
      agentTemplate: 'q3-tmpl',
      topicName: 'echo',
      payload: '{"hello":"world"}',
    });
    assert.equal(status, 202);
    const body = data as Record<string, unknown>;
    assert.equal(body['ok'], true);
    assert.equal(body['templateId'], 'q3-tmpl');
    assert.equal(body['topicName'], 'echo');
    assert.equal(typeof body['queueId'], 'number');
  });

  it('POST /api/topics/publish 400s for unknown template', async () => {
    const { status, data } = await api('POST', '/api/topics/publish', {
      agentTemplate: 'nope',
      topicName: 'x',
      payload: '{}',
    });
    assert.equal(status, 400);
    assert.match(String((data as { error: string }).error), /template/);
  });

  it('POST /api/instances/:id/complete wakes the reaper (202) when instance is live', async () => {
    // Seed a live (running) instance via the claim path so the reaper can wake it.
    db.enqueueTopicMessage({ agentTemplate: 'q3-tmpl', topicName: 'echo', payload: '{}' });
    const claim = db.claimAndCreateInstance({
      agentTemplate: 'q3-tmpl', topicName: 'echo',
      instanceId: 'live-1', instanceAddr: 'agent:q3-tmpl/live-1',
      tmuxSession: 'inst-q3-tmpl-live-1', proxyId: 'p1',
      messageId: 'live-1', messagePath: '/tmp/m', replyPath: '/tmp/r', statusPath: '/tmp/s',
      worktreePath: null,
    });
    assert.ok(claim);
    db.updateInstanceState('live-1', 'running');
    const { status, data } = await api('POST', '/api/instances/live-1/complete');
    assert.equal(status, 202);
    assert.equal((data as Record<string, unknown>)['ok'], true);
  });

  it('POST /api/instances/:id/complete returns 404 for unknown instance', async () => {
    const { status, data } = await api('POST', '/api/instances/never-existed/complete');
    assert.equal(status, 404);
    assert.equal((data as Record<string, unknown>)['error'], 'unknown instance');
  });

  // BLOCKER 1: second `complete` POST on a terminal instance must 409.
  it('POST /api/instances/:id/complete returns 409 on second call (already terminal)', async () => {
    // Seed a directly-terminal instance via the claim path.
    db.enqueueTopicMessage({ agentTemplate: 'q3-tmpl', topicName: 'echo', payload: '{}' });
    const claim = db.claimAndCreateInstance({
      agentTemplate: 'q3-tmpl', topicName: 'echo',
      instanceId: 'terminal-1', instanceAddr: 'agent:q3-tmpl/terminal-1',
      tmuxSession: 'inst-q3-tmpl-terminal-1', proxyId: 'p1',
      messageId: 'terminal-1', messagePath: '/tmp/m', replyPath: '/tmp/r', statusPath: '/tmp/s',
      worktreePath: null,
    });
    assert.ok(claim);
    // Force terminal state.
    db.updateInstanceState('terminal-1', 'completed', { completedAt: new Date().toISOString() });

    const first = await api('POST', '/api/instances/terminal-1/complete');
    assert.equal(first.status, 409, 'already terminal → 409');
    const body = first.data as Record<string, unknown>;
    assert.equal(body['error'], 'already terminal');
    assert.equal(body['state'], 'completed');

    // Second call still 409 (idempotent terminal).
    const second = await api('POST', '/api/instances/terminal-1/complete');
    assert.equal(second.status, 409);
  });

  it('POST /api/personas/reload returns 200 with diff', async () => {
    const { status, data } = await api('POST', '/api/personas/reload');
    assert.equal(status, 200);
    const body = data as Record<string, unknown>;
    assert.equal(body['ok'], true);
    assert.equal(typeof body['synced'], 'number');
    assert.ok(Array.isArray(body['created']));
    // BLOCKER 2 fix: the parse-failure list is named `skipped`, not `removed`.
    // `skipped` ≠ deletion; reaper2 review caught the mislabel.
    assert.ok(Array.isArray(body['skipped']), 'response carries `skipped`');
    assert.equal(body['removed'], undefined, 'response does NOT carry `removed` (renamed to `skipped`)');
  });

  it('POST /api/agents/send with topic: forwards through TopicDelivery (202)', async () => {
    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'topic:q3-tmpl/echo',
      message: '{"k":"v"}',
      topic: 'system',
    });
    assert.equal(status, 202);
    const body = data as Record<string, unknown>;
    assert.equal(body['status'], 'queued');
  });
});
