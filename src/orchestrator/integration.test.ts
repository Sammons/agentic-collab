/**
 * Integration test: exercises the full HTTP server with realistic proxy behavior.
 * Tests the complete lifecycle flow through the API layer.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, createWriteStream, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

describe('Integration: full lifecycle via HTTP', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];
  let sessions: Set<string>; // simulate tmux session tracking

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'integration-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    proxyCommands = [];
    sessions = new Set();

    // Realistic proxy mock: tracks sessions, returns capture output
    const realisticProxy = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);

      switch (command.action) {
        case 'create_session':
          sessions.add(command.sessionName);
          return { ok: true };

        case 'kill_session':
          sessions.delete(command.sessionName);
          return { ok: true };

        case 'has_session':
          return { ok: true, data: sessions.has(command.sessionName) };

        case 'capture':
          // Simulate claude idle output
          return { ok: true, data: '> \n' };

        case 'paste':
        case 'send_keys':
          return { ok: true };

        default:
          return { ok: false, error: `Unknown action` };
      }
    };

    // Register a proxy
    db.registerProxy('int-proxy', 'tok', 'localhost:3100');

    const ctx: RouteContext = {
      db,
      wss,
      locks: new LockManager(db.rawDb),
      proxyDispatch: realisticProxy,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: 'test-secret-123',
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

  function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    return fetch(`http://localhost:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-secret-123',
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (resp) => ({
      status: resp.status,
      data: await resp.json(),
    }));
  }

  it('full lifecycle: create → spawn → suspend → resume → kill → destroy', async () => {
    // 1. Create agent
    const create = await api('POST', '/api/agents', {
      name: 'int-agent',
      engine: 'claude',
      cwd: '/tmp',
    });
    assert.equal(create.status, 201);

    // Verify agent is in void state
    const afterCreate = await api('GET', '/api/agents/int-agent');
    assert.equal(afterCreate.status, 200);
    assert.equal((afterCreate.data as Record<string, unknown>).state, 'void');

    // 2. Spawn agent
    const spawn = await api('POST', '/api/agents/int-agent/spawn', {
      proxyId: 'int-proxy',
    });
    assert.equal(spawn.status, 200);
    assert.equal((spawn.data as Record<string, unknown>).state, 'active');
    assert.ok(sessions.has('agent-int-agent'), 'tmux session should exist');

    // 3. Suspend agent
    const suspend = await api('POST', '/api/agents/int-agent/suspend');
    assert.equal(suspend.status, 200);
    assert.equal((suspend.data as Record<string, unknown>).state, 'suspended');

    // 4. Resume agent
    const resume = await api('POST', '/api/agents/int-agent/resume');
    assert.equal(resume.status, 200);
    assert.equal((resume.data as Record<string, unknown>).state, 'active');
    assert.ok(sessions.has('agent-int-agent'), 'tmux session should be re-created');

    // 5. Kill agent (hard stop without graceful exit)
    const kill = await api('POST', '/api/agents/int-agent/kill');
    assert.equal(kill.status, 200);

    // Kill returns { ok: true }, verify state via GET
    const afterKill = await api('GET', '/api/agents/int-agent');
    assert.equal((afterKill.data as Record<string, unknown>).state, 'suspended');

    // 6. Destroy agent
    const destroy = await api('POST', '/api/agents/int-agent/destroy');
    assert.equal(destroy.status, 200);

    // Verify agent is gone
    const afterDestroy = await api('GET', '/api/agents/int-agent');
    assert.equal(afterDestroy.status, 404);
  });

  it('message delivery: dashboard → agent → dashboard reply', async () => {
    // Create and activate an agent for messaging
    await api('POST', '/api/agents', { name: 'msg-agent', engine: 'claude', cwd: '/tmp' });
    await api('POST', '/api/agents/msg-agent/spawn', { proxyId: 'int-proxy' });

    // Send message from dashboard to agent
    const send = await api('POST', '/api/dashboard/send', {
      agent: 'msg-agent',
      message: 'Hello agent, please check the PR',
    });
    assert.equal(send.status, 202); // 202 Accepted — message queued for async delivery

    // Verify message is queued
    const queue = await api('GET', '/api/queue?agent=msg-agent');
    assert.equal(queue.status, 200);
    const messages = queue.data as Record<string, unknown>[];
    assert.ok(messages.length > 0, 'message should be queued');

    // Reply from agent back to dashboard
    const reply = await api('POST', '/api/dashboard/reply', {
      agent: 'msg-agent',
      message: 'PR looks good, merged.',
    });
    assert.equal(reply.status, 200);

    // Verify thread exists (threads is a Record<agentName, messages[]>)
    const threads = await api('GET', '/api/dashboard/threads?agent=msg-agent');
    assert.equal(threads.status, 200);
    const threadMap = threads.data as Record<string, unknown[]>;
    assert.ok(threadMap['msg-agent'] && threadMap['msg-agent'].length > 0, 'thread should exist');

    // Cleanup
    await api('POST', '/api/agents/msg-agent/destroy');
  });

  it('auth: rejects unauthenticated mutating requests', async () => {
    const resp = await fetch(`http://localhost:${port}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-auth', engine: 'claude', cwd: '/tmp' }),
    });
    assert.equal(resp.status, 401);
  });

  it('auth: allows GET without token', async () => {
    const resp = await fetch(`http://localhost:${port}/api/agents`);
    assert.equal(resp.status, 200);
  });

  it('orchestrator status reflects agent counts', async () => {
    await api('POST', '/api/agents', { name: 'status-agent', engine: 'claude', cwd: '/tmp' });
    await api('POST', '/api/agents/status-agent/spawn', { proxyId: 'int-proxy' });

    const status = await api('GET', '/api/orchestrator/status');
    assert.equal(status.status, 200);
    const data = status.data as Record<string, unknown>;
    const byState = data.byState as Record<string, number>;
    assert.ok((byState.active ?? 0) >= 1 || (byState.idle ?? 0) >= 1);
    assert.ok((data.totalProxies as number) >= 1);

    // Cleanup
    await api('POST', '/api/agents/status-agent/destroy');
  });

  it('workstreams: create and list', async () => {
    await api('POST', '/api/agents', { name: 'ws-agent-1', engine: 'claude', cwd: '/tmp' });
    await api('POST', '/api/agents', { name: 'ws-agent-2', engine: 'claude', cwd: '/tmp' });

    const create = await api('POST', '/api/workstreams', {
      name: 'feature-x',
      goal: 'Build feature X',
      plan: 'Step 1: design. Step 2: implement.',
      agents: ['ws-agent-1', 'ws-agent-2'],
    });
    assert.equal(create.status, 201);

    const list = await api('GET', '/api/workstreams');
    assert.equal(list.status, 200);
    const workstreams = list.data as Record<string, unknown>[];
    assert.ok(workstreams.some(w => w.name === 'feature-x'));

    // Cleanup
    await api('DELETE', '/api/agents/ws-agent-1');
    await api('DELETE', '/api/agents/ws-agent-2');
  });

  it('shutdown and restore cycle', async () => {
    await api('POST', '/api/agents', { name: 'cycle-agent', engine: 'claude', cwd: '/tmp' });
    await api('POST', '/api/agents/cycle-agent/spawn', { proxyId: 'int-proxy' });

    // Shutdown: all agents suspended
    const shutdown = await api('POST', '/api/orchestrator/shutdown');
    assert.equal(shutdown.status, 200);

    const afterShutdown = await api('GET', '/api/agents/cycle-agent');
    assert.equal((afterShutdown.data as Record<string, unknown>).state, 'suspended');

    // Restore: agents come back
    const restore = await api('POST', '/api/orchestrator/restore');
    assert.equal(restore.status, 200);

    const afterRestore = await api('GET', '/api/agents/cycle-agent');
    assert.equal((afterRestore.data as Record<string, unknown>).state, 'active');

    // Cleanup
    await api('POST', '/api/agents/cycle-agent/destroy');
  });

  it('event log tracks lifecycle operations', async () => {
    await api('POST', '/api/agents', { name: 'event-agent', engine: 'claude', cwd: '/tmp' });
    await api('POST', '/api/agents/event-agent/spawn', { proxyId: 'int-proxy' });
    await api('POST', '/api/agents/event-agent/suspend');

    const events = await api('GET', '/api/events/event-agent');
    assert.equal(events.status, 200);
    const eventList = events.data as Record<string, unknown>[];
    assert.ok(eventList.length >= 2, 'should have spawn + suspend events');

    // Cleanup
    await api('POST', '/api/agents/event-agent/destroy');
  });

  it('proxy lifecycle: register, heartbeat, list, deregister', async () => {
    // Register a new proxy
    const reg = await api('POST', '/api/proxy/register', {
      proxyId: 'int-proxy-2',
      token: 'tok2',
      host: 'localhost:3200',
    });
    assert.equal(reg.status, 200);

    // Heartbeat
    const hb = await api('POST', '/api/proxy/heartbeat', { proxyId: 'int-proxy-2' });
    assert.equal(hb.status, 200);

    // List proxies
    const list = await api('GET', '/api/proxies');
    assert.equal(list.status, 200);
    const proxies = list.data as Record<string, unknown>[];
    assert.ok(proxies.some(p => p.proxyId === 'int-proxy-2'));

    // Deregister
    const dereg = await api('DELETE', '/api/proxy/int-proxy-2');
    assert.equal(dereg.status, 200);

    // Verify gone
    const listAfter = await api('GET', '/api/proxies');
    const proxiesAfter = listAfter.data as Record<string, unknown>[];
    assert.ok(!proxiesAfter.some(p => p.proxyId === 'int-proxy-2'));
  });
});

describe('Integration: file upload via streaming', () => {
  let orchestrator: Server;
  let mockProxy: Server;
  let db: Database;
  let wss: WebSocketServer;
  let orchPort: number;
  let proxyPort: number;
  let tmpDir: string;
  const PROXY_TOKEN = 'upload-proxy-tok';
  const SECRET = 'upload-test-secret';

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-int-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    // ── Mock proxy that handles /upload ──
    mockProxy = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url?.startsWith('/upload')) {
        const url = new URL(req.url, 'http://localhost');
        const cwd = url.searchParams.get('cwd');
        const filename = url.searchParams.get('filename');

        if (!filename || filename.includes('/') || filename.includes('\\') ||
            filename === '.' || filename === '..') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid filename' }));
          return;
        }

        if (!cwd || !existsSync(cwd)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid cwd' }));
          return;
        }

        const resolvedCwd = realpathSync(cwd);
        const targetPath = join(resolvedCwd, filename);
        const ws = createWriteStream(targetPath);
        let size = 0;
        req.on('data', (chunk: Buffer) => { size += chunk.length; });
        req.pipe(ws);
        ws.on('finish', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data: { path: targetPath, size } }));
        });
        ws.on('error', (err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockProxy.listen(0, () => {
        const addr = mockProxy.address();
        proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // Register proxy with the DB using the actual mock proxy port
    db.registerProxy('upload-proxy', PROXY_TOKEN, `localhost:${proxyPort}`);

    const ctx: RouteContext = {
      db,
      wss,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async () => ({ ok: true }), // Not used for upload
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: SECRET,
    };

    const router = createRouter(ctx);
    orchestrator = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      orchestrator.listen(0, () => {
        const addr = orchestrator.address();
        orchPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // Create an agent with cwd = tmpDir and assign the mock proxy
    db.createAgent({ name: 'upload-agent', engine: 'claude', cwd: tmpDir });
    const agent = db.getAgent('upload-agent')!;
    db.updateAgentState('upload-agent', 'active', agent.version, { proxyId: 'upload-proxy' });
  });

  after(() => {
    wss.close();
    orchestrator.close();
    mockProxy.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function uploadFile(agent: string, filename: string, data: string | Buffer): Promise<{ status: number; data: Record<string, unknown> }> {
    return fetch(
      `http://localhost:${orchPort}/api/dashboard/upload?agent=${encodeURIComponent(agent)}&filename=${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'authorization': `Bearer ${SECRET}`,
        },
        body: data,
      },
    ).then(async (resp) => ({
      status: resp.status,
      data: await resp.json() as Record<string, unknown>,
    }));
  }

  it('uploads a file to agent cwd and enqueues message', async () => {
    const content = 'Hello from upload test!';
    const res = await uploadFile('upload-agent', 'hello.txt', content);

    assert.equal(res.status, 202);
    assert.equal(res.data.ok, true);
    assert.ok((res.data.path as string).endsWith('/hello.txt'));
    assert.equal(res.data.size, Buffer.byteLength(content));
    assert.ok(res.data.queueId, 'should have a queueId');

    // Verify file was written to disk
    const filePath = join(tmpDir, 'hello.txt');
    assert.ok(existsSync(filePath), 'File should exist on disk');
    assert.equal(readFileSync(filePath, 'utf-8'), content);

    // Verify message was enqueued
    const msg = res.data.msg as Record<string, unknown>;
    assert.equal(msg.direction, 'to_agent');
    assert.ok((msg.message as string).includes('hello.txt'));
    assert.equal(msg.topic, 'file-upload');
  });

  it('uploads binary data correctly', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
    const res = await uploadFile('upload-agent', 'image.png', data);

    assert.equal(res.status, 202);
    const written = readFileSync(join(tmpDir, 'image.png'));
    assert.deepEqual(written, data);
  });

  it('rejects missing agent param', async () => {
    const res = await fetch(
      `http://localhost:${orchPort}/api/dashboard/upload?filename=test.txt`,
      {
        method: 'POST',
        headers: { 'authorization': `Bearer ${SECRET}`, 'content-type': 'application/octet-stream' },
        body: 'data',
      },
    );
    assert.equal(res.status, 400);
  });

  it('rejects missing filename param', async () => {
    const res = await fetch(
      `http://localhost:${orchPort}/api/dashboard/upload?agent=upload-agent`,
      {
        method: 'POST',
        headers: { 'authorization': `Bearer ${SECRET}`, 'content-type': 'application/octet-stream' },
        body: 'data',
      },
    );
    assert.equal(res.status, 400);
  });

  it('rejects nonexistent agent', async () => {
    const res = await uploadFile('ghost-agent', 'test.txt', 'data');
    assert.equal(res.status, 404);
  });

  it('rejects invalid filename', async () => {
    const res = await uploadFile('upload-agent', '../etc/passwd', 'evil');
    assert.equal(res.status, 400);
  });

  it('rejects agent with no proxy', async () => {
    db.createAgent({ name: 'no-proxy-agent', engine: 'codex', cwd: '/tmp' });
    const res = await uploadFile('no-proxy-agent', 'test.txt', 'data');
    assert.equal(res.status, 400);
    assert.ok((res.data.error as string).includes('no proxy'));
  });

  it('rejects unauthenticated request', async () => {
    const res = await fetch(
      `http://localhost:${orchPort}/api/dashboard/upload?agent=upload-agent&filename=test.txt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'data',
      },
    );
    assert.equal(res.status, 401);
  });
});
