/**
 * API endpoint contract tests.
 * Verifies every mock API endpoint returns the expected shape and status code.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('API Contract', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── GET /api/agents ──

  it('GET /api/agents returns 200 with array of AgentRecord', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const agents = (await res.json()) as Record<string, unknown>[];
    assert.ok(Array.isArray(agents));
    assert.equal(agents.length, 3);

    // Verify each agent has string name and engine
    for (const agent of agents) {
      assert.equal(typeof agent['name'], 'string');
      assert.equal(typeof agent['engine'], 'string');
      assert.equal(typeof agent['state'], 'string');
      assert.equal(typeof agent['cwd'], 'string');
      assert.equal(typeof agent['version'], 'number');
      assert.equal(typeof agent['spawnCount'], 'number');
      assert.equal(typeof agent['sortOrder'], 'number');
      assert.equal(typeof agent['createdAt'], 'string');
    }
  });

  it('GET /api/agents has CORS header', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  // ── GET /api/dashboard/threads ──

  it('GET /api/dashboard/threads returns 200 with object', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const threads = await res.json();
    assert.ok(typeof threads === 'object' && !Array.isArray(threads));
  });

  it('GET /api/dashboard/threads returns Record<string, DashboardMessage[]> after messages', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'contract test' }),
    });

    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, Record<string, unknown>[]>;
    assert.ok('test-claude' in threads);
    assert.ok(Array.isArray(threads['test-claude']));

    const msg = threads['test-claude']![0]!;
    assert.equal(typeof msg['id'], 'number');
    assert.equal(typeof msg['agent'], 'string');
    assert.equal(typeof msg['direction'], 'string');
    assert.equal(typeof msg['message'], 'string');
    assert.equal(typeof msg['createdAt'], 'string');
    assert.equal(typeof msg['withdrawn'], 'boolean');
  });

  // ── GET /api/proxies ──

  it('GET /api/proxies returns 200 with array of ProxyRegistration', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/proxies`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const proxies = (await res.json()) as Record<string, unknown>[];
    assert.ok(Array.isArray(proxies));
    assert.equal(proxies.length, 1);

    const proxy = proxies[0]!;
    assert.equal(typeof proxy['proxyId'], 'string');
    assert.equal(typeof proxy['token'], 'string');
    assert.equal(typeof proxy['host'], 'string');
    assert.equal(typeof proxy['versionMatch'], 'boolean');
    assert.equal(typeof proxy['lastHeartbeat'], 'string');
    assert.equal(typeof proxy['registeredAt'], 'string');
  });

  // ── GET /api/reminders ──

  it('GET /api/reminders returns 200 with empty array', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/reminders`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const reminders = await res.json();
    assert.ok(Array.isArray(reminders));
    assert.equal(reminders.length, 0);
  });

  // ── GET /api/personas/:name ──

  it('GET /api/personas/:name returns 404 with error body', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/personas/nonexistent`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'not found');
  });

  it('GET /api/personas/any-name returns 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/personas/some-persona-name`);
    assert.equal(res.status, 404);
  });

  // ── GET /api/voice/status ──

  it('GET /api/voice/status returns 200 with { enabled: false }', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/voice/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const body = (await res.json()) as { enabled: boolean };
    assert.equal(body.enabled, false);
  });

  // ── POST catch-all ──

  it('POST to unknown endpoint returns { ok: true }', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/some/random/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'test' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('POST catch-all works with empty body', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  // ── GET /dashboard ──

  it('GET /dashboard returns HTML with test-probe.js injected', async () => {
    const res = await fetch(`${ctx.baseUrl}/dashboard`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));

    const html = await res.text();
    assert.ok(html.includes('test-probe.js'), 'should include probe script tag');
    assert.ok(html.includes('</html>'), 'should be full HTML document');
    assert.ok(html.includes('<script src="/test-probe.js"></script>'), 'probe tag should be properly formed');
  });

  // ── GET /test-probe.js ──

  it('GET /test-probe.js returns JavaScript', async () => {
    const res = await fetch(`${ctx.baseUrl}/test-probe.js`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('javascript'));

    const js = await res.text();
    assert.ok(js.includes('probe_ready'), 'should contain probe_ready signal');
    assert.ok(js.includes('WebSocket'), 'should contain WebSocket code');
  });

  // ── POST /test/reset ──

  it('POST /test/reset clears all state back to defaults', async () => {
    // Mutate state
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { name: 'test-claude', state: 'suspended' },
        { name: 'extra', engine: 'codex', state: 'idle' },
      ]),
    });
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'before reset' }),
    });
    await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-claude',
        indicators: [{ id: 'pre-reset', badge: 'X', style: 'danger' }],
      }),
    });

    // Reset
    const resetRes = await fetch(`${ctx.baseUrl}/test/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    const resetBody = (await resetRes.json()) as { ok: boolean };
    assert.equal(resetBody.ok, true);

    // Verify agents restored
    const agentsRes = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await agentsRes.json()) as { name: string; state: string }[];
    assert.equal(agents.length, 3, 'should have 3 default agents');
    assert.ok(!agents.some((a) => a.name === 'extra'), 'extra agent should be gone');
    const claude = agents.find((a) => a.name === 'test-claude');
    assert.equal(claude?.state, 'idle', 'test-claude should be back to idle');

    // Verify threads cleared
    const threadsRes = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = await threadsRes.json();
    assert.deepEqual(threads, {});

    // Verify proxies restored
    const proxiesRes = await fetch(`${ctx.baseUrl}/api/proxies`);
    const proxies = (await proxiesRes.json()) as { proxyId: string }[];
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0]!.proxyId, 'test-proxy');
  });

  // ── CORS preflight ──

  it('OPTIONS request returns 204 with CORS headers', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`, {
      method: 'OPTIONS',
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'));
    assert.ok(res.headers.get('access-control-allow-headers')?.includes('content-type'));
  });

  // ── 404 for unknown GET ──

  it('GET unknown path returns 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/totally/unknown/path`);
    assert.equal(res.status, 404);
  });

  // ── Request Log ──

  it('GET /test/request-log captures request/response entries', async () => {
    // Make a few requests to populate the log
    await fetch(`${ctx.baseUrl}/api/agents`);
    await fetch(`${ctx.baseUrl}/api/proxies`);
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'log test' }),
    });

    const logRes = await fetch(`${ctx.baseUrl}/test/request-log`);
    assert.equal(logRes.status, 200);
    const log = (await logRes.json()) as {
      timestamp: string;
      method: string;
      path: string;
      requestBody: unknown;
      responseStatus: number;
      responseBody: unknown;
    }[];
    assert.ok(Array.isArray(log), 'request log should be an array');
    assert.ok(log.length >= 3, 'should have at least 3 entries');

    // Verify entry structure
    for (const entry of log) {
      assert.equal(typeof entry.timestamp, 'string');
      assert.equal(typeof entry.method, 'string');
      assert.equal(typeof entry.path, 'string');
      assert.equal(typeof entry.responseStatus, 'number');
    }

    // Verify specific entries exist
    const agentsEntry = log.find(e => e.path === '/api/agents' && e.method === 'GET');
    assert.ok(agentsEntry, 'should have logged GET /api/agents');
    assert.equal(agentsEntry!.responseStatus, 200);
    assert.ok(Array.isArray(agentsEntry!.responseBody), 'response body should be agents array');

    const sendEntry = log.find(e => e.path === '/test/send-message' && e.method === 'POST');
    assert.ok(sendEntry, 'should have logged POST /test/send-message');
    assert.equal(sendEntry!.responseStatus, 200);
    assert.ok(sendEntry!.requestBody !== null, 'POST request body should be captured');
  });

  it('POST /test/reset clears request log', async () => {
    // Generate some log entries
    await fetch(`${ctx.baseUrl}/api/agents`);

    // Verify log is non-empty
    const beforeRes = await fetch(`${ctx.baseUrl}/test/request-log`);
    const before = (await beforeRes.json()) as unknown[];
    assert.ok(before.length > 0, 'log should have entries before reset');

    // Reset
    await fetch(`${ctx.baseUrl}/test/reset`, { method: 'POST' });

    // Verify log is cleared
    const afterRes = await fetch(`${ctx.baseUrl}/test/request-log`);
    const after = (await afterRes.json()) as unknown[];
    assert.equal(after.length, 0, 'log should be empty after reset');
  });
});
