import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { HealthMonitor } from './health-monitor.ts';

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

  function makeMonitor(overrides?: Partial<ConstructorParameters<typeof HealthMonitor>[0]>): HealthMonitor {
    return new HealthMonitor({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'capture') {
          return { ok: true, data: captureOutput };
        }
        if (command.action === 'has_session') {
          return { ok: true, data: true };
        }
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
      ...overrides,
    });
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

  it('detects idle state transition from active', async () => {
    captureOutput = 'some output\n> '; // waiting_for_input

    const monitor = makeMonitor();
    await monitor.pollAll();

    const agent = db.getAgent('health-a1');
    assert.equal(agent?.state, 'idle');
  });

  it('detects active transition from idle when agent is working', async () => {
    captureOutput = 'some output\n⠋ Processing...'; // running_tool

    const monitor = makeMonitor();
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

    const failMonitor = new HealthMonitor({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async () => ({ ok: false, error: 'Session not found' }),
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
    });

    await failMonitor.pollAll();

    const agent = db.getAgent('health-fail');
    assert.equal(agent?.state, 'failed');
    assert.ok(agent?.failureReason?.includes('Health check failed'));
  });

  it('fires onAgentUpdate callback on state transitions', async () => {
    const updates: string[] = [];

    // Set health-a1 back to active for this test
    const a = db.getAgent('health-a1')!;
    if (a.state !== 'active') {
      db.updateAgentState('health-a1', 'active', a.version, {
        proxyId: 'p1',
        tmuxSession: 'agent-health-a1',
      });
    }

    captureOutput = 'some output\n> '; // waiting_for_input → idle transition

    const monitor = makeMonitor({
      onAgentUpdate: (name) => updates.push(name),
    });
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
    const failMonitor = new HealthMonitor({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async () => ({ ok: false, error: 'Session not found' }),
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
      onAgentUpdate: (name) => updates.push(name),
    });

    await failMonitor.pollAll();
    assert.ok(updates.includes('health-cb-fail'));
  });

  it('triggers compact at threshold', async () => {
    db.createAgent({ name: 'health-compact', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-compact')!;
    db.updateAgentState('health-compact', 'active', a.version, {
      tmuxSession: 'agent-health-compact',
      proxyId: 'p1',
    });

    captureOutput = 'some output\n82% context remaining\n> ';

    const monitor = makeMonitor({ autoCompactThreshold: 80 });
    proxyCommands = [];
    await monitor.pollAll();

    // Should have sent a compact command (paste action)
    assert.ok(proxyCommands.some(c => c.action === 'paste'));
  });

  it('delivers pending messages when agent is waiting_for_input', async () => {
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

    captureOutput = 'some output\n> '; // waiting_for_input

    const queueUpdates: import('../shared/types.ts').PendingMessage[] = [];
    const monitor = makeMonitor({
      onQueueUpdate: (msg) => queueUpdates.push(msg),
    });
    proxyCommands = [];
    await monitor.pollAll();

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

    captureOutput = 'some output\n> ';

    // Use a dispatch that fails on paste
    const failMonitor = new HealthMonitor({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        if (command.action === 'capture') return { ok: true, data: captureOutput };
        if (command.action === 'has_session') return { ok: true, data: true };
        if (command.action === 'paste') return { ok: false, error: 'tmux paste failed' };
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
    });

    await failMonitor.pollAll();

    const updated = db.getPendingMessageById(queued.id)!;
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.status, 'pending'); // still pending, will retry
    assert.ok(updated.nextAttemptAt !== null);
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

    captureOutput = 'some output\n> ';

    const failMonitor = new HealthMonitor({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        if (command.action === 'capture') return { ok: true, data: captureOutput };
        if (command.action === 'has_session') return { ok: true, data: true };
        if (command.action === 'paste') return { ok: false, error: 'final failure' };
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
    });

    await failMonitor.pollAll();

    // Original message should be permanently failed
    const updated = db.getPendingMessageById(queued.id)!;
    assert.equal(updated.status, 'failed');

    // Auto-reply should be enqueued to the sender
    const senderMessages = db.getDeliverableMessages('notify-me');
    assert.ok(senderMessages.length >= 1);
    assert.ok(senderMessages.some(m => m.envelope.includes('[system]')));
  });
});
