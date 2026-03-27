/**
 * Visual state snapshot tests.
 * Captures dashboard DOM + metadata at key states for human/AI review.
 * Skips gracefully when no browser probe is connected.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('Visual State Snapshots', () => {
  let ctx: TestContext;
  let probeConnected = false;

  before(async () => {
    ctx = await createTestContext();
    try {
      await ctx.waitForProbe(3000);
      probeConnected = true;
    } catch {
      console.log('[visual] No browser connected — skipping visual tests. Open:', ctx.url);
    }
  });

  after(async () => {
    await ctx.close();
  });

  it('captures initial load state', { skip: !probeConnected ? 'no browser connected' : false }, async () => {
    const { descriptor } = await ctx.snapshot('01-initial-load');
    await ctx.screenshot('01-initial-load');
    await ctx.saveRequestLog('01-initial-load');
    const cards = descriptor['agentCards'] as unknown[];
    assert.ok(cards.length >= 3, 'should show agent cards');
    assert.ok(descriptor['createFormVisible'], 'create button should be visible');
  });

  it('captures agent with active indicator', { skip: !probeConnected ? 'no browser connected' : false }, async () => {
    await ctx.triggerIndicator('test-claude', [{
      id: 'approval',
      badge: 'Needs Approval',
      style: 'warning',
      actions: { 'Yes': [{ type: 'keystroke', key: 'y' }], 'No': [{ type: 'keystroke', key: 'n' }] },
    }]);
    await new Promise(r => setTimeout(r, 500));
    const { descriptor } = await ctx.snapshot('02-indicator-active');
    await ctx.screenshot('02-indicator-active');
    await ctx.saveRequestLog('02-indicator-active');
    const cards = descriptor['agentCards'] as { name: string; indicators: string[]; indicatorActions: string[] }[];
    const claude = cards.find(c => c.name === 'test-claude');
    assert.ok(claude, 'test-claude card should exist');
    assert.ok(claude.indicators.includes('Needs Approval'), 'should show indicator badge');
    assert.ok(claude.indicatorActions.length >= 2, 'should show action buttons');
  });

  it('captures message thread', { skip: !probeConnected ? 'no browser connected' : false }, async () => {
    await ctx.click('[data-agent="test-claude"]');
    await new Promise(r => setTimeout(r, 300));
    await ctx.sendMessage('test-claude', 'Hello from the test!', { direction: 'to_agent', topic: 'test' });
    await ctx.sendMessage('test-claude', 'I received your message.', { direction: 'from_agent', topic: 'test' });
    await new Promise(r => setTimeout(r, 500));
    const { descriptor } = await ctx.snapshot('03-message-thread');
    await ctx.screenshot('03-message-thread');
    await ctx.saveRequestLog('03-message-thread');
    assert.ok((descriptor['threadMessageCount'] as number) >= 2, 'should show messages');
  });

  it('captures failed agent state', { skip: !probeConnected ? 'no browser connected' : false }, async () => {
    await ctx.click('[data-agent="test-failed"]');
    await new Promise(r => setTimeout(r, 300));
    const { descriptor } = await ctx.snapshot('04-failed-agent');
    await ctx.screenshot('04-failed-agent');
    await ctx.saveRequestLog('04-failed-agent');
    const cards = descriptor['agentCards'] as { name: string; stateText: string }[];
    const failed = cards.find(c => c.name === 'test-failed');
    assert.ok(failed, 'test-failed card should exist');
    assert.equal(failed.stateText, 'failed');
  });

  it('captures filter chip active', { skip: !probeConnected ? 'no browser connected' : false }, async () => {
    await ctx.click('.filter-chip[data-filter="active"]');
    await new Promise(r => setTimeout(r, 300));
    const { descriptor } = await ctx.snapshot('05-filter-active');
    await ctx.screenshot('05-filter-active');
    await ctx.saveRequestLog('05-filter-active');
    const chips = descriptor['filterChipsActive'] as string[];
    assert.ok(chips.length > 0, 'should have active filter');
  });

  it('captures create agent modal', { skip: !probeConnected ? 'no browser connected' : false }, async () => {
    await ctx.click('.create-agent-btn');
    await new Promise(r => setTimeout(r, 300));
    const { descriptor } = await ctx.snapshot('06-create-modal');
    await ctx.screenshot('06-create-modal');
    await ctx.saveRequestLog('06-create-modal');
    assert.ok(descriptor['modalVisible'], 'modal should be visible');
  });
});
