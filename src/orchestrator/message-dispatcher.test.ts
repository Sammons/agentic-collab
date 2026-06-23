import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import type { AgentState, ProxyCommand, ProxyResponse } from '../shared/types.ts';

/**
 * Poll a predicate until it returns true, or throw after `timeout` ms.
 * Used in place of fixed `setTimeout` waits before assertions on
 * timer-driven drain outcomes so the test waits only as long as the drain
 * actually takes — deterministic regardless of runner speed.
 */
async function waitFor(
  predicate: () => boolean,
  { timeout = 20000, interval = 50 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}

describe('MessageDispatcher', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatcher-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setAgentState(name: string, state: AgentState): void {
    const agent = db.getAgent(name)!;
    db.updateAgentState(name, state, agent.version, {
      proxyId: 'p1',
      tmuxSession: `agent-${name}`,
    });
  }

  function makeDispatcher(
    proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>,
  ): MessageDispatcher {
    return new MessageDispatcher({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch,
      orchestratorHost: 'http://localhost:3000',
    });
  }

  it('delivers to active Codex agents without pane capture', async () => {
    db.createAgent({ name: 'codex-active', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('codex-active', 'active');

    const queued = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-active',
      envelope: 'Please review the diff',
    });

    const commands: ProxyCommand[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      commands.push(command);
      if (command.action === 'capture') {
        return { ok: false, error: 'delivery should not capture pane output' };
      }
      return { ok: true };
    });

    const delivered = await dispatcher.tryDeliver('codex-active');

    assert.equal(delivered, true);
    assert.ok(!commands.some(c => c.action === 'capture'));
    assert.equal(commands.filter(c => c.action === 'paste').length, 1);
    assert.equal(db.getPendingMessageById(queued.id)?.status, 'delivered');
  });

  it('drains queued delivery without waiting for an idle transition', async () => {
    db.createAgent({ name: 'codex-drain', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('codex-drain', 'active');

    const first = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-drain',
      envelope: 'First message',
    });
    const second = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-drain',
      envelope: 'Second message',
    });

    const commands: ProxyCommand[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      commands.push(command);
      if (command.action === 'capture') {
        return { ok: false, error: 'drain loop should not capture pane output' };
      }
      return { ok: true };
    });

    const dispatcherInternals = MessageDispatcher as unknown as { DRAIN_INTERVAL_MS: number };
    const originalDrainIntervalMs = dispatcherInternals.DRAIN_INTERVAL_MS;
    dispatcherInternals.DRAIN_INTERVAL_MS = 20;

    try {
      const delivered = await dispatcher.tryDeliver('codex-drain');
      assert.equal(delivered, true);
      assert.equal(db.getPendingMessageById(first.id)?.status, 'delivered');
      assert.equal(db.getPendingMessageById(second.id)?.status, 'pending');
      assert.ok(!commands.some(c => c.action === 'capture'));
      assert.equal(commands.filter(c => c.action === 'paste').length, 1);

      // Codex submit actions include a delayed second Enter after the paste,
      // and the drain loop fires on a timer (DRAIN_INTERVAL_MS, set to 20ms
      // above). Poll for the drain to finish delivering the 2nd message
      // rather than sleeping a fixed window — a slow runner can need longer
      // than 1400ms, which read 'pending' and flaked.
      await waitFor(() =>
        db.getPendingMessageById(second.id)?.status === 'delivered'
        && commands.filter(c => c.action === 'paste').length === 2,
      );

      assert.equal(db.getPendingMessageById(second.id)?.status, 'delivered');
      assert.equal(commands.filter(c => c.action === 'paste').length, 2);
    } finally {
      dispatcher.stop();
      dispatcherInternals.DRAIN_INTERVAL_MS = originalDrainIntervalMs;
    }
  });

  it('a tryDeliver racing an in-flight delivery does not double-paste the same message', async () => {
    // Live incident 2026-06-12 (queue id 315): an approval auto-notify was
    // pasted twice. The second enqueue-triggered tryDeliver read the head
    // row while the first paste was still in flight — the row stays
    // status='pending' until markMessageDelivered — so both calls pasted
    // the same envelope. The queue showed one cleanly delivered row
    // (markMessageDelivered is idempotent), hiding the duplicate.
    db.createAgent({ name: 'codex-race', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('codex-race', 'active');

    const queued = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-race',
      envelope: 'Approval abc APPROVED (terminal)',
    });

    const pastes: string[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      if (command.action === 'paste') {
        pastes.push(command.text);
        // Hold the paste in flight so the racing call overlaps it.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { ok: true };
    });

    try {
      const results = await Promise.all([
        dispatcher.tryDeliver('codex-race'),
        dispatcher.tryDeliver('codex-race'),
      ]);

      assert.equal(
        pastes.filter(text => text.includes('Approval abc APPROVED')).length,
        1,
        `expected exactly one paste of the envelope; pastes=${JSON.stringify(pastes)}`,
      );
      // Exactly one call wins; the loser reports undelivered and defers to
      // the drain loop.
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(db.getPendingMessageById(queued.id)?.status, 'delivered');
    } finally {
      dispatcher.stop();
    }
  });
});
