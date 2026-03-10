import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { HealthMonitor } from './health-monitor.ts';
import { MessageDispatcher } from './message-dispatcher.ts';

describe('HealthMonitor', () => {
  let db: Database;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];
  let captureOutput: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    proxyCommands = [];
    captureOutput = '> \n';
  });

  function makeDispatcherAndMonitor(overrides?: Partial<ConstructorParameters<typeof HealthMonitor>[0]>): HealthMonitor {
    const dispatch = overrides?.proxyDispatch ?? (async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);
      if (command.action === 'capture') {
        return { ok: true, data: captureOutput };
      }
      if (command.action === 'has_session') {
        return { ok: true, data: true };
      }
      return { ok: true };
    });

    const locks = new LockManager(db.rawDb);
    const dispatcher = new MessageDispatcher({
      db,
      locks,
      proxyDispatch: dispatch,
      orchestratorHost: 'http://localhost:3000',
      onQueueUpdate: overrides?.onQueueUpdate,
      onDashboardMessage: overrides?.onDashboardMessage,
    });

    return new HealthMonitor({
      db,
      locks,
      proxyDispatch: dispatch,
      orchestratorHost: 'http://localhost:3000',
      messageDispatcher: dispatcher,
      pollIntervalMs: 100,
      ...overrides,
    });
  }

  // Alias for backward compatibility in tests
  const makeMonitor = makeDispatcherAndMonitor;

  /** Ensure an agent is in active state for testing. */
  function ensureActive(name: string): void {
    const a = db.getAgent(name);
    if (a && a.state !== 'active') {
      db.updateAgentState(name, 'active', a.version, {
        proxyId: 'p1',
        tmuxSession: `agent-${name}`,
      });
    }
  }

  it('starts and stops without error', () => {
    const monitor = makeMonitor();
    monitor.start();
    monitor.start(); // idempotent
    monitor.stop();
    monitor.stop(); // idempotent
  });

  it('polls active agents and captures pane output', async () => {
    db.createAgent({ name: 'health-a1', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-a1')!;
    db.updateAgentState('health-a1', 'active', a.version, {
      tmuxSession: 'agent-health-a1',
      proxyId: 'p1',
    });

    const monitor = makeMonitor();
    await monitor.pollAll();

    assert.ok(proxyCommands.some(c => c.action === 'capture'));
  });

  it('skips void/suspended agents', async () => {
    db.createAgent({ name: 'health-void', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });

    const monitor = makeMonitor();
    proxyCommands = [];
    await monitor.pollAll();

    // Only health-a1 (active) should be polled, not health-void (void)
    const captureForVoid = proxyCommands.filter(
      c => c.action === 'capture' && 'sessionName' in c && c.sessionName.includes('health-void'),
    );
    assert.equal(captureForVoid.length, 0);
  });

  it('detects idle via screen-diff (unchanged output across polls)', async () => {
    ensureActive('health-a1');
    captureOutput = 'some output\n> '; // static output

    // Same monitor instance for both polls — screen-diff state is per-instance
    const monitor = makeMonitor();

    // First poll — establishes baseline, no transition yet
    await monitor.pollAll();
    assert.equal(db.getAgent('health-a1')?.state, 'active', 'still active after first poll (baseline)');

    // Second poll — same output → IDLE_THRESHOLD reached → idle
    await monitor.pollAll();
    assert.equal(db.getAgent('health-a1')?.state, 'idle', 'idle after 2 consecutive unchanged polls');
  });

  it('detects active transition when screen changes', async () => {
    // Agent should be idle from previous test
    const a = db.getAgent('health-a1')!;
    assert.equal(a.state, 'idle', 'precondition: agent should be idle');

    // Start with same output to establish baseline, then change it
    captureOutput = 'some output\n> '; // same as last test
    const monitor = makeMonitor();
    await monitor.pollAll(); // baseline with current output

    // Now change the output — this should trigger active transition
    captureOutput = 'new output\n⠋ Processing...';
    await monitor.pollAll();

    const agent = db.getAgent('health-a1');
    assert.equal(agent?.state, 'active');
  });

  it('marks agent failed when capture fails', async () => {
    db.createAgent({ name: 'health-fail', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-fail')!;
    db.updateAgentState('health-fail', 'active', a.version, {
      tmuxSession: 'agent-health-fail',
      proxyId: 'p1',
    });

    const failDispatch = async () => ({ ok: false as const, error: 'Session not found' });
    const failLocks = new LockManager(db.rawDb);
    const failDispatcher = new MessageDispatcher({
      db, locks: failLocks, proxyDispatch: failDispatch, orchestratorHost: 'http://localhost:3000',
    });
    const failMonitor = new HealthMonitor({
      db,
      locks: failLocks,
      proxyDispatch: failDispatch,
      orchestratorHost: 'http://localhost:3000',
      messageDispatcher: failDispatcher,
      pollIntervalMs: 100,
    });

    // Requires 3 consecutive failures before marking as failed
    await failMonitor.pollAll();
    assert.equal(db.getAgent('health-fail')?.state, 'active', 'still active after 1 failure');
    await failMonitor.pollAll();
    assert.equal(db.getAgent('health-fail')?.state, 'active', 'still active after 2 failures');
    await failMonitor.pollAll();

    const agent = db.getAgent('health-fail');
    assert.equal(agent?.state, 'failed');
    assert.ok(agent?.failureReason?.includes('Health check failed'));
  });

  it('fires onAgentUpdate callback on state transitions', async () => {
    const updates: string[] = [];
    ensureActive('health-a1');
    captureOutput = 'stable output\nprompt> '; // will be same across polls

    const monitor = makeMonitor({
      onAgentUpdate: (name) => updates.push(name),
    });

    // Need 2 polls with same output for idle transition via screen-diff
    await monitor.pollAll();
    await monitor.pollAll();

    assert.ok(updates.includes('health-a1'));
  });

  it('fires onAgentUpdate on capture failure', async () => {
    db.createAgent({ name: 'health-cb-fail', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-cb-fail')!;
    db.updateAgentState('health-cb-fail', 'active', a.version, {
      tmuxSession: 'agent-health-cb-fail',
      proxyId: 'p1',
    });

    const updates: string[] = [];
    const cbFailDispatch = async () => ({ ok: false as const, error: 'Session not found' });
    const cbFailLocks = new LockManager(db.rawDb);
    const cbFailDispatcher = new MessageDispatcher({
      db, locks: cbFailLocks, proxyDispatch: cbFailDispatch, orchestratorHost: 'http://localhost:3000',
    });
    const failMonitor = new HealthMonitor({
      db,
      locks: cbFailLocks,
      proxyDispatch: cbFailDispatch,
      orchestratorHost: 'http://localhost:3000',
      messageDispatcher: cbFailDispatcher,
      pollIntervalMs: 100,
      onAgentUpdate: (name) => updates.push(name),
    });

    // Requires 3 consecutive failures before marking as failed
    await failMonitor.pollAll();
    assert.ok(!updates.includes('health-cb-fail'), 'should not fail after 1 attempt');
    await failMonitor.pollAll();
    assert.ok(!updates.includes('health-cb-fail'), 'should not fail after 2 attempts');
    await failMonitor.pollAll();
    assert.ok(updates.includes('health-cb-fail'), 'should fail after 3 attempts');
  });

  it('records context % without triggering compact or reload', async () => {
    db.createAgent({ name: 'health-compact', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-compact')!;
    db.updateAgentState('health-compact', 'active', a.version, {
      tmuxSession: 'agent-health-compact',
      proxyId: 'p1',
    });

    captureOutput = 'some output\n95% context remaining\n> ';

    const monitor = makeMonitor();
    proxyCommands = [];
    await monitor.pollAll();

    // Context % should be recorded in DB
    const updated = db.getAgent('health-compact')!;
    assert.equal(updated.lastContextPct, 95);

    // No compact or reload actions — only capture commands
    const nonCapture = proxyCommands.filter(c => c.action !== 'capture');
    assert.equal(nonCapture.length, 0, 'should not send any compact/reload commands');
  });

  it('fires onMessageDelivered callback after successful delivery', async () => {
    db.createAgent({ name: 'health-cb-deliver', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-cb-deliver')!;
    db.updateAgentState('health-cb-deliver', 'active', a.version, {
      tmuxSession: 'agent-health-cb-deliver',
      proxyId: 'p1',
    });

    db.enqueueMessage({
      sourceAgent: 'sender',
      targetAgent: 'health-cb-deliver',
      envelope: '[from: sender]: callback test',
    });

    captureOutput = 'some output\n> ';

    const deliveredAgents: string[] = [];
    const locks = new LockManager(db.rawDb);
    const dispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      if (command.action === 'has_session') return { ok: true, data: true };
      return { ok: true };
    };
    const dispatcher = new MessageDispatcher({
      db,
      locks,
      proxyDispatch: dispatch,
      orchestratorHost: 'http://localhost:3000',
      onMessageDelivered: (name) => deliveredAgents.push(name),
    });

    await dispatcher.tryDeliver('health-cb-deliver');
    assert.ok(deliveredAgents.includes('health-cb-deliver'));
  });

  it('delivers pending messages when agent becomes idle via screen-diff', async () => {
    db.createAgent({ name: 'health-deliver', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-deliver')!;
    db.updateAgentState('health-deliver', 'active', a.version, {
      tmuxSession: 'agent-health-deliver',
      proxyId: 'p1',
    });

    // Enqueue a message
    const queued = db.enqueueMessage({
      sourceAgent: 'other-agent',
      targetAgent: 'health-deliver',
      envelope: '[from: other-agent]: hello',
    });

    captureOutput = 'stable output for delivery\n> '; // unchanged across polls → idle

    const queueUpdates: import('../shared/types.ts').PendingMessage[] = [];
    const monitor = makeMonitor({
      onQueueUpdate: (msg) => queueUpdates.push(msg),
    });
    proxyCommands = [];

    // Same monitor instance: first poll establishes baseline, second detects idle
    await monitor.pollAll(); // baseline
    await monitor.pollAll(); // unchanged → idle → delivers message

    // Should have pasted the message via proxy
    assert.ok(proxyCommands.some(c => c.action === 'paste'));

    // Queue update callback should have fired
    assert.ok(queueUpdates.length >= 1);
    const delivered = queueUpdates.find(m => m.id === queued.id);
    assert.equal(delivered?.status, 'delivered');
  });

  it('retries failed delivery with backoff', async () => {
    db.createAgent({ name: 'health-retry', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-retry')!;
    db.updateAgentState('health-retry', 'active', a.version, {
      tmuxSession: 'agent-health-retry',
      proxyId: 'p1',
    });

    // Enqueue a message
    const queued = db.enqueueMessage({
      sourceAgent: 'sender',
      targetAgent: 'health-retry',
      envelope: '[from: sender]: will fail',
    });

    captureOutput = 'retry test output\n> ';

    // Use a dispatch that fails on paste but succeeds on capture
    const retryDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') return { ok: false, error: 'tmux paste failed' };
      return { ok: true };
    };
    const retryLocks = new LockManager(db.rawDb);
    const retryDispatcher = new MessageDispatcher({
      db, locks: retryLocks, proxyDispatch: retryDispatch, orchestratorHost: 'http://localhost:3000',
    });
    const failMonitor = new HealthMonitor({
      db,
      locks: retryLocks,
      proxyDispatch: retryDispatch,
      orchestratorHost: 'http://localhost:3000',
      messageDispatcher: retryDispatcher,
      pollIntervalMs: 100,
    });

    // Same monitor: first establishes baseline, second detects idle and attempts delivery
    await failMonitor.pollAll();
    await failMonitor.pollAll();

    const updated = db.getPendingMessageById(queued.id)!;
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.status, 'pending'); // still pending, will retry
    assert.ok(updated.nextAttemptAt !== null);
  });

  it('scheduleQuickPoll triggers a one-shot poll after ~1s', async () => {
    ensureActive('health-a1');
    captureOutput = 'quick-poll-test output\n> ';

    const updates: string[] = [];
    const monitor = makeMonitor({
      onAgentUpdate: (name) => updates.push(name),
    });

    // Establish baseline with a poll so the quick poll can do screen-diff
    await monitor.pollAll();

    // Reset agent to active for the quick poll transition test
    ensureActive('health-a1');

    monitor.scheduleQuickPoll('health-a1');
    // Duplicate should be deduplicated
    monitor.scheduleQuickPoll('health-a1');

    // Wait for the 1s timer to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    // Quick poll sees same output as baseline → idle
    const agent = db.getAgent('health-a1');
    assert.equal(agent?.state, 'idle');

    monitor.stop();
  });

  it('stop() clears pending quick poll timers', () => {
    const monitor = makeMonitor();
    monitor.scheduleQuickPoll('health-a1');
    monitor.stop(); // should not throw, timers cleared
  });

  it('auto-replies to sender on permanent failure', async () => {
    db.createAgent({ name: 'health-autoreply', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-autoreply')!;
    db.updateAgentState('health-autoreply', 'active', a.version, {
      tmuxSession: 'agent-health-autoreply',
      proxyId: 'p1',
    });

    // Enqueue and pre-fail 4 times so next failure is permanent
    const queued = db.enqueueMessage({
      sourceAgent: 'notify-me',
      targetAgent: 'health-autoreply',
      envelope: '[from: notify-me]: permanent fail',
    });
    for (let i = 0; i < 4; i++) {
      db.markAttemptStarted(queued.id);
      db.markAttemptFailed(queued.id, `fail ${i + 1}`);
    }
    // Clear next_attempt_at so it's deliverable
    db.rawDb.prepare(`UPDATE pending_messages SET next_attempt_at = NULL WHERE id = ?`).run(queued.id);

    captureOutput = 'autoreply-test output\n> ';

    const autoReplyDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') return { ok: false, error: 'final failure' };
      return { ok: true };
    };
    const autoReplyLocks = new LockManager(db.rawDb);
    const autoReplyDispatcher = new MessageDispatcher({
      db, locks: autoReplyLocks, proxyDispatch: autoReplyDispatch, orchestratorHost: 'http://localhost:3000',
    });
    const failMonitor = new HealthMonitor({
      db,
      locks: autoReplyLocks,
      proxyDispatch: autoReplyDispatch,
      orchestratorHost: 'http://localhost:3000',
      messageDispatcher: autoReplyDispatcher,
      pollIntervalMs: 100,
    });

    // Same monitor: first establishes baseline, second detects idle + attempts delivery
    await failMonitor.pollAll();
    await failMonitor.pollAll();

    // Original message should be permanently failed
    const updated = db.getPendingMessageById(queued.id)!;
    assert.equal(updated.status, 'failed');

    // Auto-reply should be enqueued to the sender
    const senderMessages = db.getDeliverableMessages('notify-me');
    assert.ok(senderMessages.length >= 1);
    assert.ok(senderMessages.some(m => m.envelope.includes('[system]')));
  });

  it('drains queued messages after first delivery', async () => {
    db.createAgent({ name: 'health-drain', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-drain')!;
    db.updateAgentState('health-drain', 'active', a.version, {
      tmuxSession: 'agent-health-drain',
      proxyId: 'p1',
    });

    // Enqueue two messages
    const msg1 = db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain', envelope: '[from: sender]: msg1' });
    const msg2 = db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain', envelope: '[from: sender]: msg2' });

    // Agent starts idle, then goes active after first delivery, then back to idle
    let deliveryCount = 0;
    const drainDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') {
        // After first delivery, simulate agent going active then idle again
        return { ok: true, data: 'some output\n> ' }; // always idle for test
      }
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') {
        deliveryCount++;
        return { ok: true };
      }
      return { ok: true };
    };

    const drainLocks = new LockManager(db.rawDb);
    const drainDispatcher = new MessageDispatcher({
      db, locks: drainLocks, proxyDispatch: drainDispatch, orchestratorHost: 'http://localhost:3000',
    });

    // First delivery
    const delivered = await drainDispatcher.tryDeliver('health-drain');
    assert.ok(delivered, 'first message should be delivered');
    assert.equal(deliveryCount, 1);

    // Drain timer is scheduled — wait for it to fire (3s + buffer)
    await new Promise(resolve => setTimeout(resolve, 3500));

    // Second message should have been delivered by drain
    assert.equal(deliveryCount, 2);

    const updated1 = db.getPendingMessageById(msg1.id)!;
    const updated2 = db.getPendingMessageById(msg2.id)!;
    assert.equal(updated1.status, 'delivered');
    assert.equal(updated2.status, 'delivered');

    drainDispatcher.stop();
  });

  it('detects idle on first poll after self-heal (screen-diff baseline)', async () => {
    // Screen-diff needs 2 polls with same output to detect idle.
    db.createAgent({ name: 'health-selfheal', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-selfheal')!;
    db.updateAgentState('health-selfheal', 'active', a.version, {
      tmuxSession: 'agent-health-selfheal',
      proxyId: 'p1',
    });

    captureOutput = 'some output\n› ';

    const healDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      return { ok: true };
    };

    const healLocks = new LockManager(db.rawDb);
    const healDispatcher = new MessageDispatcher({
      db, locks: healLocks, proxyDispatch: healDispatch, orchestratorHost: 'http://localhost:3000',
    });
    const healMonitor = new HealthMonitor({
      db, locks: healLocks, proxyDispatch: healDispatch,
      orchestratorHost: 'http://localhost:3000',
      messageDispatcher: healDispatcher, pollIntervalMs: 100,
    });

    // First poll establishes baseline
    await healMonitor.pollAll();
    assert.equal(db.getAgent('health-selfheal')?.state, 'active', 'still active after baseline poll');

    // Second poll — same output → idle
    await healMonitor.pollAll();
    assert.equal(db.getAgent('health-selfheal')?.state, 'idle', 'idle after 2 consecutive unchanged polls');

    healMonitor.stop();
  });

  it('stop() clears drain timers', async () => {
    db.createAgent({ name: 'health-drain-stop', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-drain-stop')!;
    db.updateAgentState('health-drain-stop', 'active', a.version, {
      tmuxSession: 'agent-health-drain-stop',
      proxyId: 'p1',
    });

    db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain-stop', envelope: '[from: sender]: msg1' });
    db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain-stop', envelope: '[from: sender]: msg2' });

    let deliveryCount = 0;
    const stopDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: 'some output\n> ' };
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') { deliveryCount++; return { ok: true }; }
      return { ok: true };
    };

    const stopLocks = new LockManager(db.rawDb);
    const stopDispatcher = new MessageDispatcher({
      db, locks: stopLocks, proxyDispatch: stopDispatch, orchestratorHost: 'http://localhost:3000',
    });

    await stopDispatcher.tryDeliver('health-drain-stop');
    assert.equal(deliveryCount, 1);

    // Stop before drain fires
    stopDispatcher.stop();

    await new Promise(resolve => setTimeout(resolve, 3500));
    // Should still be 1 — drain was cancelled
    assert.equal(deliveryCount, 1);
  });
});

describe('HealthMonitor.stripAnsi', () => {
  it('strips CSI color sequences', () => {
    assert.equal(HealthMonitor.stripAnsi('\x1b[32mgreen\x1b[0m'), 'green');
    assert.equal(HealthMonitor.stripAnsi('\x1b[1;31mred bold\x1b[0m'), 'red bold');
  });

  it('strips OSC hyperlink sequences', () => {
    assert.equal(
      HealthMonitor.stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'),
      'link',
    );
  });

  it('returns plain text unchanged', () => {
    assert.equal(HealthMonitor.stripAnsi('hello world'), 'hello world');
    assert.equal(HealthMonitor.stripAnsi(''), '');
  });

  it('strips cursor movement sequences', () => {
    assert.equal(HealthMonitor.stripAnsi('\x1b[2J\x1b[Hcontent'), 'content');
  });
});

describe('HealthMonitor.takeSnapshot', () => {
  it('captures last N lines', () => {
    const output = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
    const snapshot = HealthMonitor.takeSnapshot(output, 3);
    assert.equal(snapshot, 'line5\nline6\nline7');
  });

  it('strips ANSI codes before snapshotting', () => {
    const output = '\x1b[32mline1\x1b[0m\n\x1b[31mline2\x1b[0m';
    const snapshot = HealthMonitor.takeSnapshot(output, 5);
    assert.equal(snapshot, 'line1\nline2');
  });

  it('trims trailing whitespace per line', () => {
    const output = 'line1   \nline2  \t\nline3';
    const snapshot = HealthMonitor.takeSnapshot(output, 5);
    assert.equal(snapshot, 'line1\nline2\nline3');
  });

  it('handles fewer lines than requested', () => {
    const output = 'only\ntwo';
    const snapshot = HealthMonitor.takeSnapshot(output, 5);
    assert.equal(snapshot, 'only\ntwo');
  });

  it('handles empty output', () => {
    assert.equal(HealthMonitor.takeSnapshot('', 5), '');
    assert.equal(HealthMonitor.takeSnapshot('\n\n', 5), '\n\n');
  });
});
