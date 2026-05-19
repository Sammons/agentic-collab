/**
 * Tests for v3 Q8 crash recovery — boot reconciliation, proxy reconnect,
 * and orphaned-worktree sweep. Mirrors the patterns from
 * `instance-reaper.test.ts` and `topic-delivery.test.ts`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { TopicDelivery } from './topic-delivery.ts';
import { InstanceReaper } from './instance-reaper.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import {
  BootReconciler,
  ProxyReconnectHandler,
  OrphanedWorktreeSweep,
  type RecoveryFsAdapter,
} from './recovery.ts';
import type {
  AgentTemplateRow,
  ProxyCommand,
  ProxyResponse,
  TopicRow,
} from '../shared/types.ts';

function seedTemplate(db: Database, id: string, overrides?: Partial<AgentTemplateRow>): void {
  const row: AgentTemplateRow = {
    id,
    personaPath: null,
    engine: 'claude',
    model: null,
    persistent: false,
    cwdBase: '/tmp',
    cwdTemplate: null,
    repoRoot: '/tmp',
    hookStart: 'echo start',
    hookExit: null,
    hookPrepare: null,
    hookCleanup: 'echo cleanup',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
  db.upsertAgentTemplate(row);
}

function seedTopic(db: Database, templateId: string, overrides?: Partial<TopicRow>): void {
  const row: TopicRow = {
    agentTemplate: templateId,
    name: 'echo',
    hookPrepareOverride: null,
    hookStartOverride: null,
    hookCleanupOverride: null,
    monitorTemplate: null,
    concurrency: 1,
    schemaPath: null,
    replySchemaPath: null,
    ...overrides,
  };
  db.replaceTopicsForTemplate(templateId, [row]);
}

/**
 * Spawn one instance via TopicDelivery and wait for it to reach `running`
 * state — same harness used by the reaper tests. Returns the instance id.
 */
async function spawnAndWaitRunning(
  driver: TopicDelivery,
  db: Database,
  template: string,
  payload: string,
): Promise<string> {
  await driver.publish({ agentTemplate: template, topicName: 'echo', payload });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const live = db.listLiveAgentInstances();
    const running = live.find((r) => r.state === 'running');
    if (running) return running.id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('instance never reached running state');
}

type Recorded = { proxyId: string; command: ProxyCommand };

/**
 * Build a fresh DB, dispatcher mock, driver, reaper, and recovery surface
 * per test. `dispatchResponses` lets a test override the response for a
 * specific (proxyId, action) tuple.
 */
function makeEnv(tmpDir: string, opts?: {
  dispatchOverride?: (pid: string, cmd: ProxyCommand) => ProxyResponse | null;
}) {
  const db = new Database(join(tmpDir, `rec-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  db.registerProxy('p1', 'tok', 'localhost:3100');

  const recorded: Recorded[] = [];
  const dispatch = async (pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
    recorded.push({ proxyId: pid, command: cmd });
    const override = opts?.dispatchOverride?.(pid, cmd);
    if (override) return override;
    if (cmd.action === 'has_session') return { ok: true, data: true };
    if (cmd.action === 'kill_session') return { ok: true };
    if (cmd.action === 'exec') return { ok: true, data: '' };
    if (cmd.action === 'create_session') return { ok: true };
    if (cmd.action === 'paste') return { ok: true };
    if (cmd.action === 'send_keys') return { ok: true };
    return { ok: true };
  };
  const locks = new LockManager(db.rawDb);
  const messageDispatcher = new MessageDispatcher({
    db, locks, proxyDispatch: dispatch, orchestratorHost: 'http://localhost:3000',
  });
  const ipcRoot = mkdtempSync(join(tmpDir, 'ipc-'));
  const driver = new TopicDelivery({
    db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks,
  });
  const reaper = new InstanceReaper({
    db, proxyDispatch: dispatch, messageDispatcher, topicDelivery: driver, sweepIntervalMs: 50,
  });
  return { db, dispatch, recorded, driver, reaper, messageDispatcher, ipcRoot };
}

describe('BootReconciler — Q8 crash recovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recovery-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('STATUS file exists but no notify → reconciler finalises via reaper', async () => {
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir);
    seedTemplate(db, 'tStatus', { hookCleanup: 'echo cleanup-tStatus' });
    seedTopic(db, 'tStatus');

    const id = await spawnAndWaitRunning(driver, db, 'tStatus', '{"echo":"hi"}');
    const inst = db.getAgentInstance(id)!;

    // Simulate "agent already signaled but orchestrator missed it" — write the
    // reply + status files BEFORE the reconciler runs. The reconciler must
    // route this through the reaper, not the failure path.
    writeFileSync(inst.replyPath, JSON.stringify({ echoed: { echo: 'hi' } }));
    writeFileSync(inst.statusPath, 'ok\n');

    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, topicDelivery: driver,
    });
    const beforeLen = recorded.length;
    const summary = await reconciler.reconcile();

    assert.equal(summary.finalised, 1, 'one row finalised via reaper');
    assert.equal(summary.failed, 0, 'no rows marked failed');
    assert.equal(summary.resumed, 0, 'no rows resumed (status was ready)');

    // Reaper finalisation flows through kill_session + cleanup exec — confirm
    // the reconciler actually invoked the reaper (it must not just mark the
    // row failed without running the reply path).
    const tail = recorded.slice(beforeLen);
    const sawKill = tail.some((r) => r.command.action === 'kill_session');
    assert.ok(sawKill, 'reaper.wake → kill_session dispatched');

    const finalRow = db.getAgentInstance(id)!;
    assert.equal(finalRow.state, 'completed', 'instance reached terminal completed state');
  });

  it('live tmux session + no status → instance resumed (not failed, not finalised)', async () => {
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      // has_session returns true → session is alive.
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: true } : null,
    });
    seedTemplate(db, 'tLive');
    seedTopic(db, 'tLive');

    const id = await spawnAndWaitRunning(driver, db, 'tLive', '{}');
    // No status file. No reply.

    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, topicDelivery: driver,
    });
    const summary = await reconciler.reconcile();

    assert.equal(summary.resumed, 1, 'one row resumed');
    assert.equal(summary.failed, 0, 'no rows failed');
    assert.equal(summary.finalised, 0, 'no rows finalised');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'running', 'instance state preserved as running');
  });

  it('dead tmux session + no status → instance marked failed, cleanup attempted, queue row failed', async () => {
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      // has_session returns false → session is gone.
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    seedTemplate(db, 'tDead', { hookCleanup: 'echo cleanup-tDead-marker' });
    seedTopic(db, 'tDead');

    const id = await spawnAndWaitRunning(driver, db, 'tDead', '{}');
    const inst = db.getAgentInstance(id)!;

    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, topicDelivery: driver,
    });
    const beforeLen = recorded.length;
    const summary = await reconciler.reconcile();

    assert.equal(summary.failed, 1, 'one row failed');
    assert.equal(summary.resumed, 0);
    assert.equal(summary.finalised, 0);

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'failed', 'instance is failed');
    assert.ok(row.failureReason && row.failureReason.includes('tmux session gone'), 'failure reason set');

    // Cleanup hook ran via proxy `exec` (best-effort).
    const tail = recorded.slice(beforeLen);
    const cleanupExec = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-tDead-marker'),
    );
    assert.ok(cleanupExec, 'cleanup hook dispatched via exec');
    assert.equal(
      (cleanupExec!.command as Extract<ProxyCommand, { action: 'exec' }>).timeoutMs,
      60_000,
      'cleanup exec used 60s timeout',
    );

    // The originating topic_queue row is marked failed (per Q8: do NOT requeue).
    if (inst.queueId != null) {
      const row = db.rawDb.prepare(
        'SELECT status FROM topic_queue WHERE id = ?',
      ).get(inst.queueId) as { status: string };
      assert.equal(row.status, 'failed', 'topic_queue row marked failed (no auto-requeue)');
    }
  });

  it('idempotent: re-running reconcile is a no-op on already-reconciled rows', async () => {
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    seedTemplate(db, 'tIdem');
    seedTopic(db, 'tIdem');
    await spawnAndWaitRunning(driver, db, 'tIdem', '{}');

    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, topicDelivery: driver,
    });
    const first = await reconciler.reconcile();
    const second = await reconciler.reconcile();
    assert.equal(first.failed, 1, 'first pass fails the row');
    assert.equal(second.failed, 0, 'second pass finds no live rows');
    assert.equal(second.resumed, 0);
    assert.equal(second.finalised, 0);
  });

  it('proxy unreachable → row skipped (proxy-reconnect handler will pick it up)', async () => {
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) =>
        cmd.action === 'has_session' ? { ok: false, error: 'unreachable' } : null,
    });
    seedTemplate(db, 'tUnreach');
    seedTopic(db, 'tUnreach');
    const id = await spawnAndWaitRunning(driver, db, 'tUnreach', '{}');

    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, topicDelivery: driver,
    });
    const summary = await reconciler.reconcile();
    assert.equal(summary.skipped, 1, 'row skipped because proxy unreachable');
    assert.equal(summary.failed, 0, 'NOT marked failed prematurely');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'running', 'state unchanged');
  });
});

describe('ProxyReconnectHandler — Q8 crash recovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recovery-pxy-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('proxy reconnect → all live instances on that proxy marked failed + queue rows failed', async () => {
    const { db, dispatch, recorded, driver } = makeEnv(tmpDir);
    seedTemplate(db, 'tProxyA', { hookCleanup: 'echo cleanup-A' });
    seedTopic(db, 'tProxyA', { concurrency: 4 });

    // Spawn 3 instances on p1.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await spawnAndWaitRunning(driver, db, 'tProxyA', `{"n":${i}}`));
    }
    assert.equal(db.listAgentInstancesByProxy('p1', { onlyLive: true }).length, 3);

    // Build a recovery fsAdapter that reports worktree paths as absent so we
    // don't pretend they're on disk — the handler then skips cleanup execs.
    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false,
      readdir: () => [],
      fileSize: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, fsAdapter: fakeFs,
    });

    const beforeLen = recorded.length;
    const summary = await handler.onProxyRegister('p1');
    assert.equal(summary.failed, 3, '3 orphaned instances marked failed');

    // Every instance is now terminal.
    for (const id of ids) {
      const row = db.getAgentInstance(id)!;
      assert.equal(row.state, 'failed', `${id} is failed`);
      assert.ok(row.failureReason && row.failureReason.includes('proxy reconnected'), 'reason set');
    }

    // Their queue rows are failed.
    const queueRow = db.rawDb.prepare(
      `SELECT status FROM topic_queue WHERE agent_template = 'tProxyA' AND status = 'failed'`,
    ).all() as Array<{ status: string }>;
    assert.equal(queueRow.length, 3, 'all 3 queue rows marked failed');

    // No cleanup exec was attempted (no worktree on disk).
    const tail = recorded.slice(beforeLen);
    const cleanupAttempts = tail.filter((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-A'),
    );
    assert.equal(cleanupAttempts.length, 0, 'cleanup skipped when worktree absent');
  });

  it('proxy reconnect → cleanup runs only for instances whose worktree exists on disk', async () => {
    const { db, dispatch, recorded, driver } = makeEnv(tmpDir);
    seedTemplate(db, 'tProxyB', { hookCleanup: 'echo cleanup-B-marker' });
    seedTopic(db, 'tProxyB', { concurrency: 4 });

    const id = await spawnAndWaitRunning(driver, db, 'tProxyB', '{}');
    const inst = db.getAgentInstance(id)!;
    // Pretend a worktree was created on disk.
    const stubPath = inst.worktreePath ?? '/tmp/recovery-test-wt';
    // Update the instance row so worktreePath is set (the harness doesn't
    // populate it, since the template's cwd_template is null).
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?')
      .run(stubPath, id);

    const seenPaths = new Set<string>([stubPath]);
    const fakeFs: RecoveryFsAdapter = {
      isDirectory: (p) => seenPaths.has(p),
      readdir: () => [],
      fileSize: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, fsAdapter: fakeFs,
    });

    const beforeLen = recorded.length;
    await handler.onProxyRegister('p1');
    const tail = recorded.slice(beforeLen);

    const cleanupExec = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-B-marker'),
    );
    assert.ok(cleanupExec, 'cleanup ran for instance with on-disk worktree');
  });

  it('proxy reconnect → other proxies\' instances are untouched', async () => {
    const { db, dispatch, driver } = makeEnv(tmpDir);
    db.registerProxy('p2', 'tok2', 'localhost:3101');
    seedTemplate(db, 'tProxyC');
    seedTopic(db, 'tProxyC', { concurrency: 4 });

    // Spawn two instances. Wait for both rows to be running so they have
    // distinct ids, then partition them across proxies via raw UPDATE.
    // (The topic-delivery proxy resolver picks `proxies[0]` which is
    // non-deterministic when multiple proxies are registered; partitioning
    // post-spawn isolates the handler's proxy-id filter as the unit under
    // test.)
    await driver.publish({ agentTemplate: 'tProxyC', topicName: 'echo', payload: '{}' });
    await driver.publish({ agentTemplate: 'tProxyC', topicName: 'echo', payload: '{}' });
    const deadline = Date.now() + 2000;
    let runningRows = db.listLiveAgentInstances().filter((r) => r.state === 'running');
    while (runningRows.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      runningRows = db.listLiveAgentInstances().filter((r) => r.state === 'running');
    }
    assert.equal(runningRows.length, 2, 'two distinct instances reached running');
    const [idA, idB] = [runningRows[0]!.id, runningRows[1]!.id];
    db.rawDb.prepare('UPDATE agent_instances SET proxy_id = ? WHERE id = ?').run('p2', idA);
    db.rawDb.prepare('UPDATE agent_instances SET proxy_id = ? WHERE id = ?').run('p1', idB);

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false,
      readdir: () => [],
      fileSize: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, fsAdapter: fakeFs,
    });
    const summary = await handler.onProxyRegister('p1');
    assert.equal(summary.failed, 1, 'only the p1 instance failed');

    const rowA = db.getAgentInstance(idA)!;
    const rowB = db.getAgentInstance(idB)!;
    assert.notEqual(rowA.state, 'failed', 'p2 instance untouched');
    assert.equal(rowB.state, 'failed', 'p1 instance failed');
  });
});

describe('OrphanedWorktreeSweep — Q8 crash recovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recovery-sweep-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('worktree on disk with no agent_instances row → removal exec dispatched', async () => {
    const { db, dispatch, recorded } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-base-'));
    seedTemplate(db, 'tSweep', { cwdBase: base });
    seedTopic(db, 'tSweep');

    // Create two `wt-*` dirs on disk; neither is referenced by any instance row.
    const orphan1 = join(base, 'wt-orphan-1');
    const orphan2 = join(base, 'wt-orphan-2');
    mkdirSync(orphan1, { recursive: true });
    mkdirSync(orphan2, { recursive: true });
    // And a non-`wt-*` dir we expect to be ignored.
    const ignored = join(base, 'random-dir');
    mkdirSync(ignored, { recursive: true });

    const sweep = new OrphanedWorktreeSweep({ db, proxyDispatch: dispatch });
    const beforeLen = recorded.length;
    const result = await sweep.sweep();
    const tail = recorded.slice(beforeLen);

    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 2, 'two removal execs dispatched');
    assert.equal(result.removed, 2, 'two removals reported');

    // Each exec must use the 60s timeout and reference the orphan path.
    const paths = new Set(execs.map((r) => (r.command as Extract<ProxyCommand, { action: 'exec' }>).command));
    assert.ok([...paths].some((p) => p.includes('wt-orphan-1')), 'orphan1 targeted');
    assert.ok([...paths].some((p) => p.includes('wt-orphan-2')), 'orphan2 targeted');
    assert.ok([...paths].every((p) => !p.includes('random-dir')), 'random-dir not targeted');
    for (const e of execs) {
      const ex = e.command as Extract<ProxyCommand, { action: 'exec' }>;
      assert.equal(ex.timeoutMs, 60_000, 'exec used 60s timeout');
    }
  });

  it('worktree referenced by a live agent_instances row → NOT removed', async () => {
    const { db, dispatch, recorded, driver } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-base-keep-'));
    seedTemplate(db, 'tKeep', { cwdBase: base, cwdTemplate: null });
    seedTopic(db, 'tKeep');

    const id = await spawnAndWaitRunning(driver, db, 'tKeep', '{}');
    // Pretend the kernel made a worktree dir for this instance.
    const keepPath = join(base, 'wt-keep-me');
    mkdirSync(keepPath, { recursive: true });
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?').run(keepPath, id);

    // And an actual orphan to sanity-check the sweep still fires for things
    // it should remove.
    const orphan = join(base, 'wt-real-orphan');
    mkdirSync(orphan, { recursive: true });

    const sweep = new OrphanedWorktreeSweep({ db, proxyDispatch: dispatch });
    const beforeLen = recorded.length;
    await sweep.sweep();
    const execs = recorded.slice(beforeLen).filter((r) => r.command.action === 'exec');

    assert.equal(execs.length, 1, 'only the real orphan targeted');
    const targeted = (execs[0]!.command as Extract<ProxyCommand, { action: 'exec' }>).command;
    assert.ok(targeted.includes('wt-real-orphan'), 'orphan targeted');
    assert.ok(!targeted.includes('wt-keep-me'), 'live worktree untouched');
  });

  it('worktree row pointing at non-existent dir → graceful (no error, sweep continues)', async () => {
    const { db, dispatch, recorded, driver } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-base-missing-'));
    seedTemplate(db, 'tMissing', { cwdBase: base });
    seedTopic(db, 'tMissing');

    const id = await spawnAndWaitRunning(driver, db, 'tMissing', '{}');
    // Point worktree_path at a path that does NOT exist on disk.
    const ghost = join(base, 'wt-ghost-never-existed');
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?').run(ghost, id);

    // And a real orphan to confirm the sweep didn't bail out.
    const orphan = join(base, 'wt-actual');
    mkdirSync(orphan, { recursive: true });

    const sweep = new OrphanedWorktreeSweep({ db, proxyDispatch: dispatch });
    const beforeLen = recorded.length;
    const result = await sweep.sweep();
    const execs = recorded.slice(beforeLen).filter((r) => r.command.action === 'exec');

    assert.equal(result.removed, 1, 'orphan removed despite ghost row');
    assert.equal(execs.length, 1);
    const cmd = (execs[0]!.command as Extract<ProxyCommand, { action: 'exec' }>).command;
    assert.ok(cmd.includes('wt-actual'), 'actual orphan targeted');
  });

  it('persistent templates are ignored — only cwd_base from ephemeral templates is swept', async () => {
    const { db, dispatch, recorded } = makeEnv(tmpDir);
    const persistentBase = mkdtempSync(join(tmpDir, 'wt-persistent-'));
    const ephemeralBase = mkdtempSync(join(tmpDir, 'wt-ephemeral-'));

    seedTemplate(db, 'tPersist', { persistent: true, cwdBase: persistentBase });
    seedTemplate(db, 'tEphem', { persistent: false, cwdBase: ephemeralBase });
    seedTopic(db, 'tEphem');

    // Both bases have an orphan-shaped dir; only the ephemeral one should be
    // visited.
    mkdirSync(join(persistentBase, 'wt-persist-orphan'), { recursive: true });
    mkdirSync(join(ephemeralBase, 'wt-ephem-orphan'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({ db, proxyDispatch: dispatch });
    const beforeLen = recorded.length;
    await sweep.sweep();
    const tail = recorded.slice(beforeLen);
    const execs = tail.filter((r) => r.command.action === 'exec');

    assert.equal(execs.length, 1, 'only the ephemeral base was swept');
    const cmd = (execs[0]!.command as Extract<ProxyCommand, { action: 'exec' }>).command;
    assert.ok(cmd.includes('wt-ephem-orphan'), 'ephemeral orphan targeted');
    assert.ok(!cmd.includes('wt-persist-orphan'), 'persistent template ignored');
  });

  it('no proxy available → sweep skips removal (does not throw)', async () => {
    const { db, dispatch } = makeEnv(tmpDir);
    db.removeProxy('p1');

    const base = mkdtempSync(join(tmpDir, 'wt-base-noproxy-'));
    seedTemplate(db, 'tNoProxy', { cwdBase: base });
    seedTopic(db, 'tNoProxy');
    mkdirSync(join(base, 'wt-stranded'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({ db, proxyDispatch: dispatch });
    const result = await sweep.sweep();
    assert.equal(result.removed, 0);
    assert.ok(result.skipped >= 1, 'skipped due to no proxy');
  });
});
