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
});
