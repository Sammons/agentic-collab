/**
 * Indicator system tests.
 * Verifies indicator broadcasting, structure, actions, and clearing behavior.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('Indicators', () => {
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

  // ── Basic indicator triggering ──

  it('trigger-indicator returns 200', async () => {
    const res = await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-claude',
        indicators: [{ id: 'test-ind', badge: 'WARN', style: 'warning' }],
      }),
    });
    assert.equal(res.status, 200);
  });

  it('trigger-indicator broadcasts indicator_update via WebSocket', async () => {
    const indicatorPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS indicator_update timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentName: 'test-claude',
              indicators: [{ id: 'ws-ind', badge: 'ERR', style: 'danger' }],
            }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'indicator_update') {
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

    const event = await indicatorPromise;
    assert.equal(event['type'], 'indicator_update');
    assert.equal(event['agentName'], 'test-claude');
    const indicators = event['indicators'] as { id: string; badge: string; style: string }[];
    assert.equal(indicators.length, 1);
    assert.equal(indicators[0]!.id, 'ws-ind');
    assert.equal(indicators[0]!.badge, 'ERR');
    assert.equal(indicators[0]!.style, 'danger');
  });

  // ── Indicator structure ──

  it('indicators have correct structure (id, badge, style)', async () => {
    const indicatorPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentName: 'test-codex',
              indicators: [{ id: 'struct-test', badge: 'INFO', style: 'info' }],
            }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'indicator_update') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS error'));
      };
    });

    const event = await indicatorPromise;
    const indicators = event['indicators'] as Record<string, unknown>[];
    const ind = indicators[0]!;
    assert.ok('id' in ind, 'indicator must have id');
    assert.ok('badge' in ind, 'indicator must have badge');
    assert.ok('style' in ind, 'indicator must have style');
    assert.equal(typeof ind['id'], 'string');
    assert.equal(typeof ind['badge'], 'string');
    assert.equal(typeof ind['style'], 'string');
  });

  // ── Indicators with actions ──

  it('indicators with actions serialize correctly', async () => {
    const actions = {
      'fix-it': [
        { type: 'keystroke', key: 'C-c' },
        { type: 'shell', command: 'echo fix' },
      ],
    };
    const indicatorPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentName: 'test-claude',
              indicators: [{ id: 'action-ind', badge: 'FIX', style: 'warning', actions }],
            }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'indicator_update') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS error'));
      };
    });

    const event = await indicatorPromise;
    const indicators = event['indicators'] as Record<string, unknown>[];
    const ind = indicators[0]!;
    assert.ok('actions' in ind, 'indicator should have actions');
    const indActions = ind['actions'] as Record<string, unknown[]>;
    assert.ok('fix-it' in indActions, 'should have fix-it action');
    assert.equal(indActions['fix-it']!.length, 2);
  });

  it('actions with $N capture group references are preserved', async () => {
    const actions = {
      'restart-$1': [
        { type: 'shell', command: 'restart $1 $2' },
      ],
    };
    const indicatorPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentName: 'test-claude',
              indicators: [{ id: 'capture-ind', badge: 'CAP', style: 'info', actions }],
            }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'indicator_update') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS error'));
      };
    });

    const event = await indicatorPromise;
    const indicators = event['indicators'] as Record<string, unknown>[];
    const ind = indicators[0]!;
    const indActions = ind['actions'] as Record<string, unknown[]>;
    assert.ok('restart-$1' in indActions, 'action key with $N reference should be preserved');
    const steps = indActions['restart-$1']!;
    const shellStep = steps[0] as Record<string, unknown>;
    assert.equal(shellStep['command'], 'restart $1 $2', 'command with $N references should be preserved');
  });

  // ── Clearing indicators ──

  it('clearing indicators (empty array) broadcasts correctly', async () => {
    // First set an indicator
    await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-claude',
        indicators: [{ id: 'temp', badge: 'TMP', style: 'info' }],
      }),
    });

    // Now clear it
    const clearPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentName: 'test-claude',
              indicators: [],
            }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'indicator_update') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS error'));
      };
    });

    const event = await clearPromise;
    assert.equal(event['agentName'], 'test-claude');
    const indicators = event['indicators'] as unknown[];
    assert.equal(indicators.length, 0, 'cleared indicators should be empty array');
  });

  // ── Multiple indicators on same agent ──

  it('multiple indicators on same agent work', async () => {
    const indicatorPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentName: 'test-claude',
              indicators: [
                { id: 'ind-1', badge: 'OOM', style: 'danger' },
                { id: 'ind-2', badge: 'SLOW', style: 'warning' },
                { id: 'ind-3', badge: 'CTX', style: 'info' },
              ],
            }),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'indicator_update') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS error'));
      };
    });

    const event = await indicatorPromise;
    const indicators = event['indicators'] as { id: string; badge: string; style: string }[];
    assert.equal(indicators.length, 3);
    assert.equal(indicators[0]!.id, 'ind-1');
    assert.equal(indicators[0]!.badge, 'OOM');
    assert.equal(indicators[1]!.id, 'ind-2');
    assert.equal(indicators[1]!.badge, 'SLOW');
    assert.equal(indicators[2]!.id, 'ind-3');
    assert.equal(indicators[2]!.badge, 'CTX');
  });

  // ── Indicator state persists in fixtures ──

  it('triggered indicators are reflected in WebSocket init for new connections', async () => {
    // Trigger an indicator
    await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-claude',
        indicators: [{ id: 'persist-ind', badge: 'LIVE', style: 'info' }],
      }),
    });

    // Connect a new WS and check init
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
        reject(new Error('WS error'));
      };
    });

    assert.equal(initEvent['type'], 'init');
    const indicators = initEvent['indicators'] as Record<string, { id: string }[]>;
    assert.ok(indicators['test-claude'], 'init should have indicators for test-claude');
    assert.equal(indicators['test-claude']![0]!.id, 'persist-ind');
  });
});
