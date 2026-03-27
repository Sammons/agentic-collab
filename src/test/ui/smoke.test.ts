/**
 * UI test framework smoke test.
 * Verifies mock server HTTP endpoints, API layer, WebSocket init, and test control API.
 * No browser required — probe-dependent tests are skipped.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('UI Test Framework - Smoke', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await ctx.close();
  });

  // ── Dashboard serving ──

  it('mock server serves dashboard HTML with probe script injected', async () => {
    const res = await fetch(ctx.url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('test-probe.js'), 'should inject probe script tag');
    assert.ok(html.includes('</html>'), 'should contain full HTML document');
  });

  it('mock server serves probe script', async () => {
    const res = await fetch(`${ctx.baseUrl}/test-probe.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('probe_ready'), 'should contain probe_ready signal');
    assert.ok(js.includes('WebSocket'), 'should contain WebSocket client code');
  });

  // ── API endpoints ──

  it('agents API returns fixture data', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    assert.equal(res.status, 200);
    const agents = (await res.json()) as { name: string; engine: string; state: string }[];
    assert.equal(agents.length, 3);
    assert.equal(agents[0]!.name, 'test-claude');
    assert.equal(agents[0]!.engine, 'claude');
    assert.equal(agents[0]!.state, 'idle');
    assert.equal(agents[1]!.name, 'test-codex');
    assert.equal(agents[1]!.engine, 'codex');
    assert.equal(agents[1]!.state, 'active');
    assert.equal(agents[2]!.name, 'test-failed');
    assert.equal(agents[2]!.state, 'failed');
  });

  it('threads API returns empty object', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    assert.equal(res.status, 200);
    const threads = await res.json();
    assert.deepEqual(threads, {});
  });

  it('proxies API returns fixture proxy', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/proxies`);
    assert.equal(res.status, 200);
    const proxies = (await res.json()) as { proxyId: string }[];
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0]!.proxyId, 'test-proxy');
  });

  it('reminders API returns empty array', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/reminders`);
    assert.equal(res.status, 200);
    const reminders = await res.json();
    assert.deepEqual(reminders, []);
  });

  it('personas API returns 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/personas/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('voice status API returns disabled', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/voice/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { enabled: boolean };
    assert.equal(body.enabled, false);
  });

  it('POST catch-all returns ok', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/some/random/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  // ── Test control API ──

  it('set-agents adds a new agent to fixtures', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'new-agent', engine: 'claude', state: 'void' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    assert.ok(agents.some((a) => a.name === 'new-agent'), 'should include newly added agent');
  });

  it('set-agents updates an existing agent', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', state: 'active' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string; state: string }[];
    const claude = agents.find((a) => a.name === 'test-claude');
    assert.equal(claude?.state, 'active');
  });

  it('send-message creates a thread entry and broadcasts', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'hello from test', direction: 'from_agent' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.ok(threads['test-claude'], 'should have thread for test-claude');
    assert.ok(threads['test-claude']!.some((m) => m.message === 'hello from test'));
  });

  it('trigger-indicator updates indicator state', async () => {
    const indicatorRes = await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-claude',
        indicators: [{ id: 'test-ind', badge: 'WARN', style: 'warning' }],
      }),
    });
    assert.equal(indicatorRes.status, 200);
  });

  it('reset restores default fixtures', async () => {
    // After previous tests mutated state, reset should bring it back
    await fetch(`${ctx.baseUrl}/test/reset`, { method: 'POST' });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    assert.equal(agents.length, 3, 'should have exactly 3 default agents after reset');
    assert.ok(!agents.some((a) => a.name === 'new-agent'), 'new-agent should be gone after reset');

    const threadRes = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = await threadRes.json();
    assert.deepEqual(threads, {}, 'threads should be empty after reset');
  });

  // ── WebSocket init ──

  it('WebSocket sends well-formed init event on connect', async () => {
    const initEvent = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS init timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      ws.onmessage = (evt) => {
        clearTimeout(timer);
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        ws.close();
        resolve(parsed);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS connection error'));
      };
    });

    assert.equal(initEvent['type'], 'init');
    assert.ok(Array.isArray(initEvent['agents']), 'init should include agents array');
    assert.ok(typeof initEvent['threads'] === 'object', 'init should include threads object');
    assert.ok(Array.isArray(initEvent['proxies']), 'init should include proxies array');

    const agents = initEvent['agents'] as { name: string }[];
    assert.equal(agents.length, 3);
    assert.equal(agents[0]!.name, 'test-claude');
  });
});
