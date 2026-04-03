/**
 * Message flow tests.
 * Verifies message creation, broadcast, thread accumulation, and direction handling.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('Messaging', () => {
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

  // ── Basic message creation ──

  it('send-message creates a dashboard message in the thread', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'hello world', direction: 'from_agent' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.ok(threads['test-claude'], 'should have thread for test-claude');
    assert.equal(threads['test-claude']!.length, 1);
    assert.equal(threads['test-claude']![0]!.message, 'hello world');
  });

  it('send-message broadcasts message event via WebSocket', async () => {
    const msgPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS message timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/send-message`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'test-claude', message: 'ws-test', direction: 'from_agent' }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'message') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS connection error'));
      };
    });

    const event = await msgPromise;
    assert.equal(event['type'], 'message');
    const msg = event['msg'] as Record<string, unknown>;
    assert.equal(msg['agent'], 'test-claude');
    assert.equal(msg['message'], 'ws-test');
  });

  // ── Message structure ──

  it('messages have correct DashboardMessage structure', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'structure test', direction: 'to_agent', topic: 'test-topic' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, Record<string, unknown>[]>;
    const msg = threads['test-claude']![0]!;

    // Required fields
    assert.equal(typeof msg['id'], 'number');
    assert.equal(msg['agent'], 'test-claude');
    assert.equal(msg['direction'], 'to_agent');
    assert.equal(msg['topic'], 'test-topic');
    assert.equal(msg['message'], 'structure test');
    assert.equal(typeof msg['createdAt'], 'string');

    // Nullable fields present
    assert.ok('sourceAgent' in msg);
    assert.ok('targetAgent' in msg);
    assert.ok('queueId' in msg);
    assert.ok('deliveryStatus' in msg);
    assert.ok('withdrawn' in msg);
    assert.equal(msg['withdrawn'], false);
  });

  it('message IDs are auto-incrementing integers', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'first' }),
    });
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'second' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { id: number }[]>;
    const msgs = threads['test-claude']!;
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1]!.id > msgs[0]!.id, 'second message should have higher id');
  });

  // ── Thread accumulation ──

  it('multiple messages for same agent accumulate in one thread', async () => {
    for (let i = 0; i < 5; i++) {
      await fetch(`${ctx.baseUrl}/test/send-message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'test-claude', message: `msg-${i}` }),
      });
    }
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.equal(threads['test-claude']!.length, 5);
    assert.equal(threads['test-claude']![0]!.message, 'msg-0');
    assert.equal(threads['test-claude']![4]!.message, 'msg-4');
  });

  it('messages for different agents go to separate threads', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'claude msg' }),
    });
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-codex', message: 'codex msg' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.equal(Object.keys(threads).length, 2);
    assert.equal(threads['test-claude']!.length, 1);
    assert.equal(threads['test-claude']![0]!.message, 'claude msg');
    assert.equal(threads['test-codex']!.length, 1);
    assert.equal(threads['test-codex']![0]!.message, 'codex msg');
  });

  // ── Direction handling ──

  it('from_agent direction is set correctly', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'from agent', direction: 'from_agent' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { direction: string }[]>;
    assert.equal(threads['test-claude']![0]!.direction, 'from_agent');
  });

  it('to_agent direction is set correctly', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'to agent', direction: 'to_agent' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { direction: string }[]>;
    assert.equal(threads['test-claude']![0]!.direction, 'to_agent');
  });

  it('direction defaults to from_agent when not specified', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'no direction' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { direction: string }[]>;
    assert.equal(threads['test-claude']![0]!.direction, 'from_agent');
  });

  // ── Edge cases ──

  it('empty message body is stored correctly', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: '' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.equal(threads['test-claude']![0]!.message, '');
  });

  it('long message (1000+ chars) is stored correctly', async () => {
    const longMsg = 'x'.repeat(2000);
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: longMsg }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.equal(threads['test-claude']![0]!.message.length, 2000);
    assert.equal(threads['test-claude']![0]!.message, longMsg);
  });

  it('topic field defaults to null when not specified', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'no topic' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { topic: string | null }[]>;
    assert.equal(threads['test-claude']![0]!.topic, null);
  });

  it('topic field is preserved when specified', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'with topic', topic: 'deploy-status' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { topic: string | null }[]>;
    assert.equal(threads['test-claude']![0]!.topic, 'deploy-status');
  });
});
