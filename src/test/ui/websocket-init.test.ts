/**
 * WebSocket initialization tests.
 * Verifies the init event structure, field completeness, and data consistency.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

/** Connect to the mock server's WebSocket and return the first message (init event). */
function connectAndGetInit(baseUrl: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS init timeout')), 3000);
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
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
}

describe('WebSocket Initialization', () => {
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

  // ── Init event presence ──

  it('connecting to /ws receives an init event', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    assert.equal(event['type'], 'init');
  });

  // ── Init event fields ──

  it('init contains agents array', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    assert.ok(Array.isArray(event['agents']), 'init.agents should be an array');
  });

  it('init contains threads object', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    assert.ok(typeof event['threads'] === 'object' && !Array.isArray(event['threads']), 'init.threads should be an object');
  });

  it('init contains proxies array', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    assert.ok(Array.isArray(event['proxies']), 'init.proxies should be an array');
  });

  it('init contains indicators field', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    assert.ok('indicators' in event, 'init should have indicators field');
    assert.ok(typeof event['indicators'] === 'object', 'init.indicators should be an object');
  });

  it('init contains unreadCounts field', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    assert.ok('unreadCounts' in event, 'init should have unreadCounts field');
    assert.ok(typeof event['unreadCounts'] === 'object', 'init.unreadCounts should be an object');
  });

  // ── Init agent data matches fixtures ──

  it('agents in init match fixture data', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    const agents = event['agents'] as { name: string; engine: string; state: string }[];
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

  it('proxies in init match fixture data', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    const proxies = event['proxies'] as { proxyId: string; host: string }[];
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0]!.proxyId, 'test-proxy');
    assert.equal(proxies[0]!.host, 'localhost:9000');
  });

  it('threads in init are empty by default', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    const threads = event['threads'] as Record<string, unknown>;
    assert.deepEqual(threads, {});
  });

  it('indicators in init are empty by default', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    const indicators = event['indicators'] as Record<string, unknown>;
    assert.deepEqual(indicators, {});
  });

  it('unreadCounts in init are empty by default', async () => {
    const event = await connectAndGetInit(ctx.baseUrl);
    const unread = event['unreadCounts'] as Record<string, unknown>;
    assert.deepEqual(unread, {});
  });

  // ── Init reflects mutated state ──

  it('after set-agents, new WebSocket connections get updated agent data', async () => {
    // Mutate agent state
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', state: 'suspended' }]),
    });

    const event = await connectAndGetInit(ctx.baseUrl);
    const agents = event['agents'] as { name: string; state: string }[];
    const claude = agents.find((a) => a.name === 'test-claude');
    assert.equal(claude?.state, 'suspended', 'init should reflect the updated state');
  });

  it('after set-agents adding a new agent, init includes it', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'ws-new-agent', engine: 'claude', state: 'void' }]),
    });

    const event = await connectAndGetInit(ctx.baseUrl);
    const agents = event['agents'] as { name: string }[];
    assert.equal(agents.length, 4);
    assert.ok(agents.some((a) => a.name === 'ws-new-agent'));
  });

  it('after send-message, init includes thread data', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'init-thread-test' }),
    });

    const event = await connectAndGetInit(ctx.baseUrl);
    const threads = event['threads'] as Record<string, { message: string }[]>;
    assert.ok(threads['test-claude'], 'init should have thread for test-claude');
    assert.equal(threads['test-claude']![0]!.message, 'init-thread-test');
  });

  it('after trigger-indicator, init includes indicator data', async () => {
    await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-codex',
        indicators: [{ id: 'init-ind', badge: 'CHECK', style: 'info' }],
      }),
    });

    const event = await connectAndGetInit(ctx.baseUrl);
    const indicators = event['indicators'] as Record<string, { id: string }[]>;
    assert.ok(indicators['test-codex'], 'init should have indicators for test-codex');
    assert.equal(indicators['test-codex']![0]!.id, 'init-ind');
  });

  // ── Reset restores init defaults ──

  it('after reset, init returns to default state', async () => {
    // Mutate everything
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'extra-agent', state: 'idle' }]),
    });
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'reset test' }),
    });

    // Reset
    await fetch(`${ctx.baseUrl}/test/reset`, { method: 'POST' });

    const event = await connectAndGetInit(ctx.baseUrl);
    const agents = event['agents'] as { name: string }[];
    assert.equal(agents.length, 3, 'should have exactly 3 agents after reset');
    assert.ok(!agents.some((a) => a.name === 'extra-agent'), 'extra-agent should be gone');

    const threads = event['threads'] as Record<string, unknown>;
    assert.deepEqual(threads, {}, 'threads should be empty after reset');
  });
});
