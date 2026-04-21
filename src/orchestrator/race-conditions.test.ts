/**
 * Race condition tests for message delivery.
 *
 * Race 1: Fire-and-forget error swallowing
 *   - tryDeliver() fails → no retry scheduled
 *   - Fix: schedule retry on failure
 *
 * Race 2: Compact state transition vs tryDeliver
 *   - tryDeliver reads agent, passes canSuspend()
 *   - compactAgent changes state idle→active concurrently
 *   - Fix: cool-down after interrupt/compact before delivery
 *
 * Race 3: Stale agent record in deliverToAgent
 *   - deliverNextMessage reads agent at line ~167 (pre-lock)
 *   - Passes stale record to deliverToAgent()
 *   - Fix: re-read agent inside deliverToAgent() lock
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { compactAgent, deliverToAgent, type LifecycleContext } from './lifecycle.ts';
import type { AgentState, ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';

describe('Race Conditions', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'race-test-'));
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

  function makeLifecycleCtx(
    proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>,
  ): LifecycleContext {
    return {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch,
      orchestratorHost: 'http://localhost:3000',
    };
  }

  describe('Race 1: Fire-and-forget error swallowing', () => {
    it('schedules retry when tryDeliver fails due to proxy error', async () => {
      db.createAgent({ name: 'retry-on-fail', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('retry-on-fail', 'idle');

      db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'retry-on-fail',
        envelope: 'Message that will fail',
      });

      let deliveryAttempts = 0;
      const dispatcher = new MessageDispatcher({
        db,
        locks: new LockManager(db.rawDb),
        proxyDispatch: async (_proxyId, _command) => {
          deliveryAttempts++;
          // Simulate proxy failure
          return { ok: false, error: 'Proxy connection refused' };
        },
        orchestratorHost: 'http://localhost:3000',
      });

      // First delivery attempt should fail
      const delivered = await dispatcher.tryDeliver('retry-on-fail');
      assert.equal(delivered, false, 'delivery should fail on proxy error');
      assert.equal(deliveryAttempts, 1, 'should have attempted delivery once');

      // The key assertion: after a failure, a drain loop SHOULD be scheduled
      // to retry delivery later (when backoff expires). We can't easily test
      // the actual retry without waiting 30+ seconds, but we can verify:
      // 1. The message is still in the pending queue (not lost)
      // 2. A drain timer was scheduled

      // Access internal state to verify drain timer was scheduled
      const dispatcherInternal = dispatcher as unknown as {
        drainTimers: Map<string, ReturnType<typeof setTimeout>>;
        draining: Set<string>;
      };

      // Verify drain timer is scheduled OR draining is active
      const hasTimer = dispatcherInternal.drainTimers.has('retry-on-fail');
      const isDraining = dispatcherInternal.draining.has('retry-on-fail');
      assert.ok(
        hasTimer || isDraining,
        'should have scheduled a drain timer or be draining after failure',
      );

      // Verify message is still in the queue (not lost)
      const messages = db.getPendingMessageById(1);
      assert.ok(messages, 'message should still exist in database');
      assert.notEqual(messages.status, 'delivered', 'message should not be delivered');

      dispatcher.stop();
    });

    it('does not lose messages when delivery fails during tryDeliver', async () => {
      db.createAgent({ name: 'no-lost-msgs', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('no-lost-msgs', 'idle');

      const msg = db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'no-lost-msgs',
        envelope: 'Important message',
      });

      const dispatcher = new MessageDispatcher({
        db,
        locks: new LockManager(db.rawDb),
        proxyDispatch: async (_proxyId, _command) => {
          // Always fail
          return { ok: false, error: 'Persistent error' };
        },
        orchestratorHost: 'http://localhost:3000',
      });

      try {
        // Attempt delivery - will fail
        await dispatcher.tryDeliver('no-lost-msgs');

        // Message should still be pending (not lost)
        const pending = db.getPendingMessageById(msg.id);
        assert.ok(pending, 'message should not be lost after failure');
        assert.equal(pending.status, 'pending', 'should still be pending');

        // Retry count should be incremented
        assert.equal(pending.retryCount, 1, 'retry count should be incremented');

        // Error should be recorded
        assert.ok(pending.error?.includes('Persistent error'), 'error should be recorded');

        // nextAttemptAt should be set (backoff scheduled)
        assert.ok(pending.nextAttemptAt, 'next attempt should be scheduled');

        // Drain timer should be scheduled for eventual retry
        const dispatcherInternal = dispatcher as unknown as {
          drainTimers: Map<string, ReturnType<typeof setTimeout>>;
          draining: Set<string>;
        };
        const hasTimer = dispatcherInternal.drainTimers.has('no-lost-msgs');
        const isDraining = dispatcherInternal.draining.has('no-lost-msgs');
        assert.ok(
          hasTimer || isDraining,
          'drain timer should be scheduled for retry',
        );
      } finally {
        dispatcher.stop();
      }
    });
  });

  describe('Race 2: Compact state transition vs tryDeliver', () => {
    it('delivery waits for cool-down after compact operation', async () => {
      db.createAgent({ name: 'compact-race', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('compact-race', 'idle');

      // Enqueue a message
      db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'compact-race',
        envelope: 'Message during compact',
      });

      // Track when compact and delivery pastes happen
      let compactPasteTime = 0;
      let deliveryPasteTime = 0;
      let compactDone = false;

      const sharedProxyDispatch = async (_proxyId: string, command: ProxyCommand) => {
        if (command.action === 'paste') {
          if (!compactDone) {
            compactPasteTime = Date.now();
          } else {
            deliveryPasteTime = Date.now();
          }
        }
        return { ok: true } as ProxyResponse;
      };

      const dispatcher = new MessageDispatcher({
        db,
        locks: new LockManager(db.rawDb),
        proxyDispatch: sharedProxyDispatch,
        orchestratorHost: 'http://localhost:3000',
      });

      const ctx = makeLifecycleCtx(sharedProxyDispatch);
      ctx.onLifecycleOp = (agentName) => dispatcher.signalLifecycleOp(agentName);

      try {
        // Run compact operation
        await compactAgent(ctx, 'compact-race');
        compactDone = true;

        // Immediately try to deliver - should wait for cool-down
        await dispatcher.tryDeliver('compact-race');

        // Verify: there should be a cool-down delay between compact and delivery
        // With the fix, delivery waits for LIFECYCLE_COOLDOWN_MS (~300ms)
        assert.ok(compactPasteTime > 0, 'compact should have pasted');
        assert.ok(deliveryPasteTime > 0, 'delivery should have pasted');

        const delay = deliveryPasteTime - compactPasteTime;
        assert.ok(
          delay >= 200,
          `expected cool-down delay >= 200ms, got ${delay}ms`,
        );
      } finally {
        dispatcher.stop();
      }
    });

    it('prevents delivery during compact operation', async () => {
      db.createAgent({ name: 'interleave-test', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('interleave-test', 'idle');

      db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'interleave-test',
        envelope: 'Test message',
      });

      const commandOrder: string[] = [];
      const sharedProxyDispatch = async (_proxyId: string, command: ProxyCommand) => {
        commandOrder.push(`${command.action}:${Date.now()}`);
        await new Promise(r => setTimeout(r, 50));
        return { ok: true } as ProxyResponse;
      };

      const dispatcher = new MessageDispatcher({
        db,
        locks: new LockManager(db.rawDb),
        proxyDispatch: sharedProxyDispatch,
        orchestratorHost: 'http://localhost:3000',
      });

      const ctx = makeLifecycleCtx(sharedProxyDispatch);
      ctx.onLifecycleOp = (agentName) => dispatcher.signalLifecycleOp(agentName);

      try {
        // Run compact and delivery concurrently
        await Promise.all([
          compactAgent(ctx, 'interleave-test'),
          dispatcher.tryDeliver('interleave-test'),
        ]);

        // With proper locking + cool-down, compact should complete before delivery
        // The cool-down ensures the agent processes compact before receiving a message
        const pasteCommands = commandOrder.filter(c => c.startsWith('paste:'));
        assert.ok(
          pasteCommands.length >= 2,
          `expected at least 2 paste commands, got ${pasteCommands.length}`,
        );
        // Verify timing: second paste (delivery) should be 200ms+ after first (compact)
        if (pasteCommands.length >= 2) {
          const compactPasteTime = parseInt(pasteCommands[0]!.split(':')[1]!, 10);
          const deliveryPasteTime = parseInt(pasteCommands[1]!.split(':')[1]!, 10);
          const gap = deliveryPasteTime - compactPasteTime;
          assert.ok(
            gap >= 200,
            `expected 200ms+ gap between compact and delivery, got ${gap}ms`,
          );
        }
      } finally {
        dispatcher.stop();
      }
    });
  });

  describe('Race 3: Stale agent record in deliverToAgent', () => {
    it('re-reads agent inside lock to prevent stale record delivery', async () => {
      db.createAgent({ name: 'stale-record', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('stale-record', 'idle');

      // Get the agent record BEFORE any changes
      const staleRecord = db.getAgent('stale-record')!;

      // Now modify the agent (simulate concurrent update)
      const updated = db.getAgent('stale-record')!;
      db.updateAgentState('stale-record', 'active', updated.version, {
        proxyId: 'p2', // Changed proxy!
        tmuxSession: 'agent-stale-record-v2',
      });
      db.registerProxy('p2', 'tok2', 'localhost:3200');

      // Track which proxy received the delivery
      const deliveriesBy: Record<string, number> = { p1: 0, p2: 0 };

      const ctx = makeLifecycleCtx(async (proxyId, _command) => {
        deliveriesBy[proxyId]++;
        return { ok: true };
      });

      // Pass the STALE record to deliverToAgent
      // With the race: it uses proxyId 'p1' from the stale record
      // After fix: it should re-read inside the lock and use 'p2'
      await deliverToAgent(ctx, staleRecord, 'Test message');

      // The fix: deliverToAgent should re-read the agent inside its lock
      // and use the updated proxyId (p2), not the stale one (p1)
      assert.equal(
        deliveriesBy['p1'],
        0,
        `delivery went to stale proxy p1 (expected 0, got ${deliveriesBy['p1']})`,
      );
      assert.ok(
        deliveriesBy['p2'] >= 1,
        `delivery should use current proxy p2 (expected >= 1, got ${deliveriesBy['p2']})`,
      );
    });

    it('handles agent disappearing between read and lock', async () => {
      db.createAgent({ name: 'disappearing', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('disappearing', 'idle');

      const agentRecord = db.getAgent('disappearing')!;

      // Delete the agent before delivery (simulate concurrent delete)
      db.deleteAgent('disappearing');

      const ctx = makeLifecycleCtx(async (_proxyId, _command) => {
        return { ok: true };
      });

      // deliverToAgent receives a record that no longer exists in DB
      // After fix: should re-read inside lock and return error
      const error = await deliverToAgent(ctx, agentRecord, 'Test message');

      // Should return an error, not crash
      assert.ok(error !== null, 'should return error when agent disappears');
      assert.ok(
        error.includes('not found') || error.includes('disappeared') || error.includes('no longer exists'),
        `expected 'not found' error, got: ${error}`,
      );
    });

    it('handles session changing between read and delivery', async () => {
      db.createAgent({ name: 'session-change', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      setAgentState('session-change', 'idle');

      const staleRecord = db.getAgent('session-change')!;

      // Update the session
      const current = db.getAgent('session-change')!;
      db.updateAgentState('session-change', 'active', current.version, {
        tmuxSession: 'agent-session-change-NEW',
      });

      // Track which session received the paste
      const sessionsPasted: string[] = [];

      const ctx = makeLifecycleCtx(async (_proxyId, command) => {
        if (command.action === 'paste' && 'sessionName' in command) {
          sessionsPasted.push((command as { sessionName: string }).sessionName);
        }
        return { ok: true };
      });

      await deliverToAgent(ctx, staleRecord, 'Test message');

      // After fix: should use the current session, not the stale one
      assert.ok(sessionsPasted.length > 0, 'should have pasted to a session');
      assert.ok(
        sessionsPasted.every(s => s === 'agent-session-change-NEW'),
        `should use current session, got: ${sessionsPasted.join(', ')}`,
      );
    });
  });
});
