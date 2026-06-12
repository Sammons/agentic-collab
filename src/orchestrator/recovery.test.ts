/**
 * Tests for v3 Q8 crash recovery — boot reconciliation, proxy reconnect,
 * and orphaned-worktree sweep. Mirrors the patterns from
 * `instance-reaper.test.ts` and `topic-delivery.test.ts`.
 *
 * Coverage notes (post hostile-review):
 *  - C1: boot reconcile bounded by `wallClockCapMs` (see "wall-clock cap").
 *  - C2: proxy-reconnect probes `has_session` before failing (multiple tests).
 *  - C3: sweep is single-flight (see "single-flight").
 *  - C4: sweep TOCTOU mitigation (see "race a new instance into the path").
 *  - C5: orphan removal routes via a proxy that has serviced the cwd_base.
 *  - C6: `'spawning'` rows are excluded from the RECONNECT handler; at BOOT
 *    they are adopted (CRITICAL-1, see "adopts stale spawning").
 *  - M1: ordering asserted via timeline arrays (cleanup BEFORE mark-failed).
 *  - M2: idempotency asserts no double cleanup / no double WS event.
 *  - M4: proxy-unreachable path covered for reconnect handler.
 *
 * Review round 2 coverage:
 *  - CRITICAL-1: boot adoption of stale 'spawning' rows (fail + requeue +
 *    status-ready variants; concurrency unbrick assertion).
 *  - CRITICAL-2: cleanup gate probes worktree existence via the OWNING
 *    PROXY, not the container-local filesystem.
 *  - HIGH-1: reconnect handler is status-first — finished work is finalised
 *    via the reaper, never failed/requeued.
 *  - HIGH-2: CAS + claim-guard (terminal state never overwritten; see also
 *    database.test.ts for the transactional method itself).
 *  - MEDIUM-2: absent orphan path counted skipped, warnings deduped.
 *  - LOW: custom sweep prefix is anchored; coincident proxy registers get a
 *    coalesced trailing run instead of being dropped.
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
  WsInstanceFailedEvent,
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

/**
 * Wait until every live row is in 'running' state (or timeout). Used by
 * multi-spawn tests where the proxy-reconnect handler excludes 'spawning'
 * rows (C6) — without this wait, a not-yet-promoted row could be filtered
 * out of the handler's working set.
 */
async function waitAllRunning(db: Database, expectedCount: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = db.listLiveAgentInstances();
    const running = live.filter((r) => r.state === 'running');
    if (running.length >= expectedCount && live.every((r) => r.state !== 'spawning')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`only ${db.listLiveAgentInstances().filter((r) => r.state === 'running').length} rows running; expected ${expectedCount}`);
}

type Recorded = { proxyId: string; command: ProxyCommand };

/**
 * Dispatch-override fragment answering the CRITICAL-2 worktree-existence
 * probe (`test -d <path> && echo __WT_DIR__ || echo __WT_ABSENT__`) with
 * "present on host". Tests compose it with their own overrides.
 */
function probeReportsPresent(cmd: ProxyCommand): ProxyResponse | null {
  if (cmd.action === 'exec' && cmd.command.startsWith('test -d ')) {
    return { ok: true, data: '__WT_DIR__' };
  }
  return null;
}

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

    // M1: instrument the reaper to assert `wake(id)` was actually called.
    // We can do that with a thin spy via the proxy timeline: the reaper
    // sequence is "kill_session → cleanup exec". Both events being observed
    // confirms reaper.wake ran (the reconciler routes status-ready rows via
    // the reaper, not the failure path).
    let wakeCalledWithId: string | null = null;
    const wrappedReaper = {
      wake: (instId: string) => {
        wakeCalledWithId = instId;
        return reaper.wake(instId);
      },
    } as unknown as InstanceReaper;

    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: wrappedReaper,
    });
    const beforeLen = recorded.length;
    const summary = await reconciler.reconcile();

    assert.equal(summary.finalised, 1, 'one row finalised via reaper');
    assert.equal(summary.failed, 0, 'no rows marked failed');
    assert.equal(summary.resumed, 0, 'no rows resumed (status was ready)');
    assert.equal(wakeCalledWithId, id, 'reaper.wake invoked with the instance id');

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
      db, proxyDispatch: dispatch, instanceReaper: reaper,
    });
    const summary = await reconciler.reconcile();

    assert.equal(summary.resumed, 1, 'one row resumed');
    assert.equal(summary.failed, 0, 'no rows failed');
    assert.equal(summary.finalised, 0, 'no rows finalised');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'running', 'instance state preserved as running');
  });

  it('dead tmux session + no status → instance marked failed, cleanup dispatched BEFORE mark-failed, queue row failed', async () => {
    // M1: assert ordering — cleanup exec MUST be dispatched BEFORE the state
    // transition to 'failed'. The timeline array below records both.
    type Event =
      | { kind: 'dispatch'; action: string; command?: string }
      | { kind: 'state'; state: string };
    const timeline: Event[] = [];

    const tmpFile = join(tmpDir, `ord-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(tmpFile);
    db.registerProxy('p1', 'tok', 'localhost:3100');

    const dispatch = async (_pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      const ev: { kind: 'dispatch'; action: string; command?: string } = { kind: 'dispatch', action: cmd.action };
      if (cmd.action === 'exec') ev.command = cmd.command;
      timeline.push(ev);
      if (cmd.action === 'has_session') return { ok: true, data: false };
      if (cmd.action === 'create_session') return { ok: true };
      if (cmd.action === 'paste') return { ok: true };
      if (cmd.action === 'send_keys') return { ok: true };
      // CRITICAL-2: the cleanup gate now probes the OWNING PROXY for the
      // worktree, not the orchestrator-local filesystem.
      const probed = probeReportsPresent(cmd);
      if (probed) return probed;
      return { ok: true, data: '' };
    };

    // Patch updateInstanceState to record state transitions, and the
    // transactional fail+settle (HIGH-2) which the recovery failure path
    // now uses instead of updateInstanceState.
    const origUpdate = db.updateInstanceState.bind(db);
    db.updateInstanceState = (id, state, extra) => {
      timeline.push({ kind: 'state', state });
      return origUpdate(id, state, extra);
    };
    const origSettle = db.failInstanceAndSettleQueue.bind(db);
    db.failInstanceAndSettleQueue = (opts) => {
      const result = origSettle(opts);
      if (result.instanceUpdated) {
        timeline.push({ kind: 'state', state: 'failed' });
      }
      return result;
    };

    const locks = new LockManager(db.rawDb);
    const messageDispatcher = new MessageDispatcher({ db, locks, proxyDispatch: dispatch, orchestratorHost: 'http://localhost:3000' });
    const ipcRoot = mkdtempSync(join(tmpDir, 'ord-ipc-'));
    const driver = new TopicDelivery({ db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks });
    const reaper = new InstanceReaper({ db, proxyDispatch: dispatch, messageDispatcher, topicDelivery: driver, sweepIntervalMs: 50 });

    // Pretend the worktree dir exists on disk so cleanup runs.
    const wtPath = join(tmpDir, `ord-wt-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wtPath, { recursive: true });

    seedTemplate(db, 'tDead', {
      hookCleanup: 'echo cleanup-tDead-marker',
      cwdTemplate: wtPath, // helps if used
    });
    seedTopic(db, 'tDead');

    const id = await spawnAndWaitRunning(driver, db, 'tDead', '{}');
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?').run(wtPath, id);
    const inst = db.getAgentInstance(id)!;

    const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
    timeline.length = 0; // reset for the reconcile pass only
    const summary = await reconciler.reconcile();

    assert.equal(summary.failed, 1, 'one row failed');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'failed', 'instance is failed');
    assert.ok(row.failureReason && row.failureReason.includes('tmux session gone'), 'failure reason set');

    // M1: cleanup exec MUST appear before the 'failed' state transition.
    const cleanupIdx = timeline.findIndex((e) =>
      e.kind === 'dispatch' && e.action === 'exec' && e.command?.includes('cleanup-tDead-marker'),
    );
    const failedIdx = timeline.findIndex((e) => e.kind === 'state' && e.state === 'failed');
    assert.ok(cleanupIdx >= 0, 'cleanup exec was dispatched');
    assert.ok(failedIdx >= 0, 'state was transitioned to failed');
    assert.ok(cleanupIdx < failedIdx, `cleanup(${cleanupIdx}) BEFORE mark-failed(${failedIdx})`);

    // The originating topic_queue row is marked failed (per Q8 default policy).
    if (inst.queueId != null) {
      const r = db.rawDb.prepare('SELECT status FROM topic_queue WHERE id = ?').get(inst.queueId) as { status: string };
      assert.equal(r.status, 'failed', 'topic_queue row marked failed (no auto-requeue)');
    }
  });

  it('dead tmux session + worktree absent on disk → cleanup is skipped (H1 gating)', async () => {
    // H1: cleanup MUST only run when the worktree directory is on disk.
    // Worktree path is null here (spawn harness doesn't allocate one for
    // templates with null cwd_template), so we expect no cleanup exec.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    seedTemplate(db, 'tDeadNoWt', { hookCleanup: 'echo cleanup-skipped-marker' });
    seedTopic(db, 'tDeadNoWt');

    const id = await spawnAndWaitRunning(driver, db, 'tDeadNoWt', '{}');

    const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
    const beforeLen = recorded.length;
    const summary = await reconciler.reconcile();

    assert.equal(summary.failed, 1, 'one row failed');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'failed', 'instance is failed');

    const tail = recorded.slice(beforeLen);
    const cleanupExec = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-skipped-marker'),
    );
    assert.equal(cleanupExec, undefined, 'cleanup NOT dispatched (worktree absent on disk)');
  });

  it('idempotent: re-running reconcile is a no-op + no duplicate cleanup exec / no duplicate WS event (M2)', async () => {
    // M2: assert (a) only ONE cleanup exec per failed row across two passes,
    // and (b) only ONE WS instance_failed event is emitted.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => {
        if (cmd.action === 'has_session') return { ok: true, data: false };
        return probeReportsPresent(cmd);
      },
    });
    seedTemplate(db, 'tIdem', { hookCleanup: 'echo cleanup-idem-marker' });
    seedTopic(db, 'tIdem');
    const id = await spawnAndWaitRunning(driver, db, 'tIdem', '{}');
    // Make worktree visible so cleanup actually runs.
    const wtPath = join(tmpDir, `idem-wt-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wtPath, { recursive: true });
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?').run(wtPath, id);

    const wsEvents: WsInstanceFailedEvent[] = [];
    const reconciler = new BootReconciler({
      db, proxyDispatch: dispatch, instanceReaper: reaper,
      onEvent: (e) => wsEvents.push(e),
    });
    const before = recorded.length;

    const first = await reconciler.reconcile();
    const second = await reconciler.reconcile();
    assert.equal(first.failed, 1, 'first pass fails the row');
    assert.equal(second.failed, 0, 'second pass finds no live rows');
    assert.equal(second.resumed, 0);
    assert.equal(second.finalised, 0);

    const tail = recorded.slice(before);
    const cleanups = tail.filter((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-idem-marker'),
    );
    assert.equal(cleanups.length, 1, 'EXACTLY one cleanup exec across both passes');

    const failedEvents = wsEvents.filter((e) => e.instance.id === id);
    assert.equal(failedEvents.length, 1, 'EXACTLY one instance_failed event for the row');
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
      db, proxyDispatch: dispatch, instanceReaper: reaper,
    });
    const summary = await reconciler.reconcile();
    assert.equal(summary.skipped, 1, 'row skipped because proxy unreachable');
    assert.equal(summary.failed, 0, 'NOT marked failed prematurely');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'running', 'state unchanged');
  });

  it('wall-clock cap → remaining rows skipped, server.listen unblocked (C1)', async () => {
    // C1: a slow proxyDispatch must not stall the entire reconcile.
    // Stub `has_session` to await 200ms per call; with a 100ms cap and 5
    // rows we should observe at least one `skipped` and `reconcile()` itself
    // should return within ~chunk-budget (1 chunk of 5 × 200ms ≈ 200ms — we
    // give it 1500ms in the assert below for CI noise).
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir);
    seedTemplate(db, 'tCap');
    seedTopic(db, 'tCap', { concurrency: 8 });

    // Spawn 5 rows + ensure all are 'running' so reconcile sees all 5.
    for (let i = 0; i < 5; i += 1) {
      await spawnAndWaitRunning(driver, db, 'tCap', `{"i":${i}}`);
    }
    await waitAllRunning(db, 5);

    const slowDispatch = async (pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      if (cmd.action === 'has_session') {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true, data: false };
      }
      return dispatch(pid, cmd);
    };

    const reconciler = new BootReconciler({
      db, proxyDispatch: slowDispatch, instanceReaper: reaper,
      wallClockCapMs: 100, // shorter than even one row's dispatch latency
      chunkSize: 1, // force serial so we definitely hit the cap
    });

    const t0 = Date.now();
    const summary = await reconciler.reconcile();
    const elapsed = Date.now() - t0;

    // 5 rows, chunkSize=1, 200ms each: total = 1000ms if no cap. With a
    // 100ms cap we should see at most ~300ms (1 chunk processes, deadline
    // check fires on next loop iteration).
    assert.ok(elapsed < 800, `reconcile returned within bounded time (${elapsed}ms)`);
    assert.ok(summary.skipped >= 1, `cap caused at least one skip (got ${summary.skipped})`);
  });

  it('adopts stale "spawning" rows at boot: killed, failed, queue row failed, concurrency unbricked (CRITICAL-1)', async () => {
    // CRITICAL-1: a row stuck in 'spawning' at boot means the claim flow
    // died with the previous process. Before adoption, NOTHING transitioned
    // it: the reaper skips 'spawning', the reconnect handler excludes it,
    // its claimed queue row was stranded forever, and concurrency=1 topics
    // bricked because countLiveInstancesForTopic counts 'spawning'.
    const { db, dispatch, recorded, reaper } = makeEnv(tmpDir);
    seedTemplate(db, 'tStale');
    seedTopic(db, 'tStale');

    // Simulate the exact crash shape: claim committed (queue row 'claimed',
    // instance row 'spawning'), then the process died before 'running'.
    db.enqueueTopicMessage({ agentTemplate: 'tStale', topicName: 'echo', payload: '{}' });
    const claim = db.claimAndCreateInstance({
      agentTemplate: 'tStale',
      topicName: 'echo',
      instanceId: 'stale-spawn-1',
      instanceAddr: 'agent:tStale/stale-spawn-1',
      tmuxSession: 'inst-tStale-stale1',
      proxyId: 'p1',
      messageId: 'stale-spawn-1',
      messagePath: join(tmpDir, 'stale1-msg'),
      replyPath: join(tmpDir, 'stale1-reply'),
      statusPath: join(tmpDir, 'stale1-status'),
      worktreePath: null,
      suffix: 'aaa111',
    })!;
    assert.equal(claim.instance.state, 'spawning', 'precondition: claim left row spawning');
    assert.equal(db.countLiveInstancesForTopic('tStale', 'echo'), 1, 'precondition: topic slot occupied');

    const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
    const beforeLen = recorded.length;
    const summary = await reconciler.reconcile();

    assert.equal(summary.failed, 1, 'stale spawning row adopted and failed');

    const row = db.getAgentInstance('stale-spawn-1')!;
    assert.equal(row.state, 'failed', 'instance failed');
    assert.ok(row.failureReason && row.failureReason.includes('stale spawning'), 'reason names the adoption');

    // Half-created session is killed best-effort so a requeued payload
    // can't end up running twice.
    const tail = recorded.slice(beforeLen);
    const kill = tail.find((r) => r.command.action === 'kill_session');
    assert.ok(kill, 'kill_session dispatched for the half-created session');

    // Queue row settled (default policy: failed) — not stranded 'claimed'.
    const queueRow = db.rawDb.prepare('SELECT status FROM topic_queue WHERE id = ?')
      .get(claim.queue.id) as { status: string };
    assert.equal(queueRow.status, 'failed', 'queue row no longer stranded in claimed');

    // The concurrency slot is released — the topic is unbricked.
    assert.equal(db.countLiveInstancesForTopic('tStale', 'echo'), 0, 'live count back to 0');
  });

  it('adopts stale "spawning" rows with requeue policy → queue row back to queued (CRITICAL-1 + H3)', async () => {
    const prev = process.env['V3_RECOVERY_QUEUE_POLICY'];
    process.env['V3_RECOVERY_QUEUE_POLICY'] = 'requeue';
    try {
      const { db, dispatch, reaper } = makeEnv(tmpDir);
      seedTemplate(db, 'tStaleReq');
      seedTopic(db, 'tStaleReq');
      db.enqueueTopicMessage({ agentTemplate: 'tStaleReq', topicName: 'echo', payload: '{}' });
      const claim = db.claimAndCreateInstance({
        agentTemplate: 'tStaleReq',
        topicName: 'echo',
        instanceId: 'stale-spawn-2',
        instanceAddr: 'agent:tStaleReq/stale-spawn-2',
        tmuxSession: 'inst-tStaleReq-stale2',
        proxyId: 'p1',
        messageId: 'stale-spawn-2',
        messagePath: join(tmpDir, 'stale2-msg'),
        replyPath: join(tmpDir, 'stale2-reply'),
        statusPath: join(tmpDir, 'stale2-status'),
        worktreePath: null,
        suffix: 'bbb222',
      })!;

      const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
      await reconciler.reconcile();

      const queueRow = db.rawDb.prepare(
        'SELECT status, claimed_by_instance FROM topic_queue WHERE id = ?',
      ).get(claim.queue.id) as { status: string; claimed_by_instance: string | null };
      assert.equal(queueRow.status, 'queued', 'queue row REQUEUED for redelivery');
      assert.equal(queueRow.claimed_by_instance, null, 'claim cleared');
    } finally {
      if (prev === undefined) delete process.env['V3_RECOVERY_QUEUE_POLICY'];
      else process.env['V3_RECOVERY_QUEUE_POLICY'] = prev;
    }
  });

  it('adopts stale "spawning" rows whose status is ready → finalised via reaper, work never discarded (CRITICAL-1)', async () => {
    // Crash landed between paste(start) and the 'running' transition, and
    // the agent FINISHED before its session died. Adoption must route this
    // through the reaper (promote → wake), not the failure path.
    const { db, dispatch, reaper } = makeEnv(tmpDir);
    seedTemplate(db, 'tStaleDone');
    seedTopic(db, 'tStaleDone');
    db.enqueueTopicMessage({ agentTemplate: 'tStaleDone', topicName: 'echo', payload: '{}' });
    const statusPath = join(tmpDir, 'stale3-status');
    const replyPath = join(tmpDir, 'stale3-reply');
    const claim = db.claimAndCreateInstance({
      agentTemplate: 'tStaleDone',
      topicName: 'echo',
      instanceId: 'stale-spawn-3',
      instanceAddr: 'agent:tStaleDone/stale-spawn-3',
      tmuxSession: 'inst-tStaleDone-stale3',
      proxyId: 'p1',
      messageId: 'stale-spawn-3',
      messagePath: join(tmpDir, 'stale3-msg'),
      replyPath,
      statusPath,
      worktreePath: null,
      suffix: 'ccc333',
    })!;
    writeFileSync(replyPath, JSON.stringify({ done: true }));
    writeFileSync(statusPath, 'ok\n');

    const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
    const summary = await reconciler.reconcile();

    assert.equal(summary.finalised, 1, 'status-ready spawning row finalised, not failed');
    assert.equal(summary.failed, 0);

    const row = db.getAgentInstance('stale-spawn-3')!;
    assert.equal(row.state, 'completed', 'reaper completed the finished work');
    const queueRow = db.rawDb.prepare('SELECT status FROM topic_queue WHERE id = ?')
      .get(claim.queue.id) as { status: string };
    assert.equal(queueRow.status, 'completed', 'queue row completed');
  });

  it('cleanup gate probes worktree existence via the OWNING PROXY, not local fs (CRITICAL-2)', async () => {
    // In the Docker deployment, worktrees live on the host and are invisible
    // to the orchestrator container. The row's worktree_path points at a
    // path that does NOT exist locally; the proxy reports it present —
    // cleanup must be dispatched anyway.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => {
        if (cmd.action === 'has_session') return { ok: true, data: false };
        return probeReportsPresent(cmd);
      },
    });
    seedTemplate(db, 'tDocker', { hookCleanup: 'echo cleanup-docker-marker' });
    seedTopic(db, 'tDocker');

    const id = await spawnAndWaitRunning(driver, db, 'tDocker', '{}');
    // Host-only path — never exists on the orchestrator filesystem.
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?')
      .run('/host-only/worktrees/wt-not-visible-here', id);

    const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
    const beforeLen = recorded.length;
    const summary = await reconciler.reconcile();
    assert.equal(summary.failed, 1);

    const tail = recorded.slice(beforeLen);
    const probe = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.startsWith('test -d '),
    );
    assert.ok(probe, 'existence probe routed through the proxy');
    const cleanup = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-docker-marker'),
    );
    assert.ok(cleanup, 'cleanup dispatched despite the path being invisible locally');
  });

  it('V3_RECOVERY_QUEUE_POLICY=requeue → topic_queue row reset to queued (H3)', async () => {
    const prev = process.env['V3_RECOVERY_QUEUE_POLICY'];
    process.env['V3_RECOVERY_QUEUE_POLICY'] = 'requeue';
    try {
      const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
        dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
      });
      seedTemplate(db, 'tReq');
      seedTopic(db, 'tReq');
      const id = await spawnAndWaitRunning(driver, db, 'tReq', '{}');
      const inst = db.getAgentInstance(id)!;

      const reconciler = new BootReconciler({ db, proxyDispatch: dispatch, instanceReaper: reaper });
      await reconciler.reconcile();

      assert.notEqual(inst.queueId, null, 'precondition: queue id is set');
      const r = db.rawDb.prepare('SELECT status FROM topic_queue WHERE id = ?').get(inst.queueId!) as { status: string };
      assert.equal(r.status, 'queued', 'topic_queue row was REQUEUED (not failed)');
    } finally {
      if (prev === undefined) delete process.env['V3_RECOVERY_QUEUE_POLICY'];
      else process.env['V3_RECOVERY_QUEUE_POLICY'] = prev;
    }
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

  it('proxy reconnect → has_session=false → instances marked failed + queue rows failed (C2 dead branch)', async () => {
    // C2: handler probes has_session FIRST. When the probe returns false,
    // mark the row failed.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    seedTemplate(db, 'tProxyA', { hookCleanup: 'echo cleanup-A' });
    seedTopic(db, 'tProxyA', { concurrency: 4 });

    // Spawn 3 instances on p1.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await spawnAndWaitRunning(driver, db, 'tProxyA', `{"n":${i}}`));
    }
    // Make sure all 3 are 'running' (not still 'spawning') — the handler
    // excludes 'spawning' (C6).
    await waitAllRunning(db, 3);
    assert.equal(db.listAgentInstancesByProxy('p1', { onlyLive: true }).length, 3);

    // Build a recovery fsAdapter that reports worktree paths as absent so we
    // don't pretend they're on disk — the handler then skips cleanup execs.
    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false,
      readdir: () => [],
      fileSize: () => null,
      mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs,
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

    // C2: the timeline must show a has_session probe per instance.
    const probes = tail.filter((r) => r.command.action === 'has_session');
    assert.equal(probes.length, 3, 'has_session probed once per row');
  });

  it('proxy reconnect → has_session=true → instance LEFT ALONE (C2 live branch)', async () => {
    // C2: the proxy heartbeat lapsed but tmux survived. The handler must
    // NOT terminate the live row.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: true } : null,
    });
    seedTemplate(db, 'tLiveBlip', { hookCleanup: 'echo cleanup-blip' });
    seedTopic(db, 'tLiveBlip');

    const id = await spawnAndWaitRunning(driver, db, 'tLiveBlip', '{}');

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({ db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs });

    const beforeLen = recorded.length;
    const summary = await handler.onProxyRegister('p1');

    assert.equal(summary.failed, 0, 'live instance was NOT failed');
    assert.equal(summary.skipped, 1, 'live instance was counted as skipped');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'running', 'instance still running');
    assert.equal(row.failureReason, null, 'no failure reason was set');

    const tail = recorded.slice(beforeLen);
    const cleanupAttempts = tail.filter((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-blip'),
    );
    assert.equal(cleanupAttempts.length, 0, 'no cleanup exec dispatched for live row');
  });

  it('proxy reconnect → has_session returns ok:false → row skipped (M4 — proxy unreachable mid-handler)', async () => {
    // M4: probe itself can fail with ok:false (proxy went away again
    // between register and probe). Skip — don't terminate.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) =>
        cmd.action === 'has_session' ? { ok: false, error: 'connection refused' } : null,
    });
    seedTemplate(db, 'tProbeFail');
    seedTopic(db, 'tProbeFail');

    const id = await spawnAndWaitRunning(driver, db, 'tProbeFail', '{}');

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({ db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs });

    const beforeLen = recorded.length;
    const summary = await handler.onProxyRegister('p1');

    assert.equal(summary.failed, 0, 'row NOT marked failed when probe is inconclusive');
    assert.equal(summary.skipped, 1, 'row counted as skipped');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'running', 'instance state preserved');

    const tail = recorded.slice(beforeLen);
    // Only the probe was dispatched (no kill_session, no cleanup exec).
    const nonProbe = tail.filter((r) => r.command.action !== 'has_session');
    assert.equal(nonProbe.length, 0, 'no kill or cleanup dispatched');
  });

  it('proxy reconnect → cleanup runs only for instances whose worktree exists on the HOST (H1 + CRITICAL-2)', async () => {
    // The gate is the proxy-routed `test -d` probe, not the orchestrator's
    // local filesystem — in Docker the worktree is never visible locally.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => {
        if (cmd.action === 'has_session') return { ok: true, data: false };
        return probeReportsPresent(cmd);
      },
    });
    seedTemplate(db, 'tProxyB', { hookCleanup: 'echo cleanup-B-marker' });
    seedTopic(db, 'tProxyB', { concurrency: 4 });

    const id = await spawnAndWaitRunning(driver, db, 'tProxyB', '{}');
    // Host-only path — does NOT exist on the orchestrator filesystem.
    const stubPath = '/host-only/worktrees/wt-reconnect-test';
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?')
      .run(stubPath, id);

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false,
      readdir: () => [],
      fileSize: () => null,
      mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs,
    });

    const beforeLen = recorded.length;
    await handler.onProxyRegister('p1');
    const tail = recorded.slice(beforeLen);

    const probe = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.startsWith('test -d '),
    );
    assert.ok(probe, 'worktree existence probed via the proxy');
    const cleanupExec = tail.find((r) =>
      r.command.action === 'exec' && r.command.command.includes('cleanup-B-marker'),
    );
    assert.ok(cleanupExec, 'cleanup ran for instance whose worktree exists on the host');
  });

  it('proxy reconnect → other proxies\' instances are untouched', async () => {
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    db.registerProxy('p2', 'tok2', 'localhost:3101');
    seedTemplate(db, 'tProxyC');
    seedTopic(db, 'tProxyC', { concurrency: 4 });

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
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs,
    });
    const summary = await handler.onProxyRegister('p1');
    assert.equal(summary.failed, 1, 'only the p1 instance failed');

    const rowA = db.getAgentInstance(idA)!;
    const rowB = db.getAgentInstance(idB)!;
    assert.notEqual(rowA.state, 'failed', 'p2 instance untouched');
    assert.equal(rowB.state, 'failed', 'p1 instance failed');
  });

  it('"completing" rows are excluded from reconnect handler (H2 — reaper owns them)', async () => {
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    seedTemplate(db, 'tCompleting');
    seedTopic(db, 'tCompleting');
    const id = await spawnAndWaitRunning(driver, db, 'tCompleting', '{}');

    // Move the row to 'completing' — the reaper has claimed it for
    // finalisation. The reconnect handler must NOT touch it.
    db.updateInstanceState(id, 'completing');

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({ db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs });
    const summary = await handler.onProxyRegister('p1');

    assert.equal(summary.failed, 0, '"completing" row NOT marked failed');
    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'completing', 'state unchanged');
  });

  it('concurrent re-registrations are single-flight per proxy (H4)', async () => {
    // H4: two concurrent onProxyRegister('p1') calls must not double-process.
    let dispatchCalls = 0;
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => {
        if (cmd.action === 'has_session') {
          dispatchCalls += 1;
          return { ok: true, data: false };
        }
        return null;
      },
    });
    seedTemplate(db, 'tConcurrent');
    seedTopic(db, 'tConcurrent', { concurrency: 4 });
    await spawnAndWaitRunning(driver, db, 'tConcurrent', '{}');

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({ db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs });

    const [a, b] = await Promise.all([handler.onProxyRegister('p1'), handler.onProxyRegister('p1')]);
    // One call does the work; the other returns early (its request is
    // coalesced into a trailing run, which finds no live rows left).
    const totalFailed = a.failed + b.failed;
    assert.equal(totalFailed, 1, 'EXACTLY one of the two concurrent calls did the work');
    // There must be exactly one has_session probe (single row, single
    // effective pass — the trailing run sees the row already terminal).
    assert.equal(dispatchCalls, 1, 'single-flight: only one probe dispatched across two register calls');
  });

  it('status-ready rows are finalised via the reaper, never failed (HIGH-1)', async () => {
    // Interleaving from the review: agent finishes + writes STATUS + session
    // dies; proxy re-registers. The old handler probed has_session, saw the
    // dead session, and FAILED the row — overwriting completed work and
    // (with requeue policy) executing the payload twice. Status-first stops
    // that: the reaper finalises, the queue row completes.
    const { db, dispatch, recorded, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) =>
        cmd.action === 'has_session' ? { ok: true, data: false } : null,
    });
    seedTemplate(db, 'tStatusFirst', { hookCleanup: 'echo cleanup-status-first' });
    seedTopic(db, 'tStatusFirst');

    const id = await spawnAndWaitRunning(driver, db, 'tStatusFirst', '{"echo":"done"}');
    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, JSON.stringify({ echoed: { echo: 'done' } }));
    writeFileSync(inst.statusPath, 'ok\n');

    const failedEvents: WsInstanceFailedEvent[] = [];
    // Default fs adapter — the status files are real, so statusReady fires.
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, instanceReaper: reaper,
      onEvent: (e) => failedEvents.push(e),
    });

    const beforeLen = recorded.length;
    const summary = await handler.onProxyRegister('p1');

    assert.equal(summary.finalised, 1, 'row finalised via reaper');
    assert.equal(summary.failed, 0, 'row NOT failed');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'completed', 'completed work preserved');
    if (inst.queueId != null) {
      const queueRow = db.rawDb.prepare('SELECT status FROM topic_queue WHERE id = ?')
        .get(inst.queueId) as { status: string };
      assert.equal(queueRow.status, 'completed', 'queue row completed — no requeue, no double delivery');
    }
    assert.equal(failedEvents.length, 0, 'no instance_failed event emitted');

    // The reaper path is observable: kill_session was dispatched.
    const tail = recorded.slice(beforeLen);
    assert.ok(tail.some((r) => r.command.action === 'kill_session'), 'reaper finalisation ran');
  });

  it('reaper finalising mid-handler wins: CAS refuses to overwrite the terminal state (HIGH-1 + HIGH-2)', async () => {
    // Simulate the reaper completing the instance BETWEEN the handler's
    // dead-session probe and its failure write. The CAS in
    // failInstanceAndSettleQueue must refuse; the queue row must not flip.
    const { db, dispatch, driver, reaper } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => {
        if (cmd.action === 'has_session') {
          // The "reaper" finalises the row while the handler is probing.
          db.rawDb.prepare(
            `UPDATE agent_instances SET state = 'completed', completed_at = 'now' WHERE state = 'running'`,
          ).run();
          db.rawDb.prepare(
            `UPDATE topic_queue SET status = 'completed' WHERE status = 'claimed'`,
          ).run();
          return { ok: true, data: false };
        }
        return null;
      },
    });
    seedTemplate(db, 'tReaperRace');
    seedTopic(db, 'tReaperRace');
    const id = await spawnAndWaitRunning(driver, db, 'tReaperRace', '{}');
    const inst = db.getAgentInstance(id)!;

    const failedEvents: WsInstanceFailedEvent[] = [];
    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: dispatch, instanceReaper: reaper, fsAdapter: fakeFs,
      onEvent: (e) => failedEvents.push(e),
    });
    const summary = await handler.onProxyRegister('p1');

    assert.equal(summary.failed, 0, 'CAS-refused write not counted as failed');
    assert.ok(summary.skipped >= 1, 'row counted as skipped — reaper outcome stands');

    const row = db.getAgentInstance(id)!;
    assert.equal(row.state, 'completed', 'terminal completed state NOT overwritten');
    if (inst.queueId != null) {
      const queueRow = db.rawDb.prepare('SELECT status FROM topic_queue WHERE id = ?')
        .get(inst.queueId) as { status: string };
      assert.equal(queueRow.status, 'completed', 'queue row untouched — no double delivery');
    }
    assert.equal(failedEvents.length, 0, 'no contradictory instance_failed event');
  });

  it('a register landing mid-run is coalesced into a trailing run, not dropped (LOW)', async () => {
    // The old single-flight returned {0,0} for coincident registers — rows
    // that appeared after the in-flight pass listed its working set were
    // never re-examined until the next register.
    const { db, dispatch, reaper, driver } = makeEnv(tmpDir, {
      dispatchOverride: (_pid, cmd) => {
        if (cmd.action === 'has_session') return { ok: true, data: false };
        return null;
      },
    });
    seedTemplate(db, 'tTrailing');
    seedTopic(db, 'tTrailing', { concurrency: 4 });
    await spawnAndWaitRunning(driver, db, 'tTrailing', '{}');

    const slowDispatch = async (pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      if (cmd.action === 'has_session') {
        await new Promise((r) => setTimeout(r, 120));
      }
      return dispatch(pid, cmd);
    };

    const fakeFs: RecoveryFsAdapter = {
      isDirectory: () => false, readdir: () => [], fileSize: () => null, mtimeMs: () => null,
    };
    const handler = new ProxyReconnectHandler({
      db, proxyDispatch: slowDispatch, instanceReaper: reaper, fsAdapter: fakeFs,
    });

    const first = handler.onProxyRegister('p1');
    // While the first pass is wedged in its slow probe, a second running row
    // appears (e.g. spawned just before its proxy blipped) and the proxy
    // re-registers.
    await new Promise((r) => setTimeout(r, 30));
    db.rawDb.prepare(`
      INSERT INTO agent_instances (
        id, agent_template, spawned_from_topic, instance_addr,
        tmux_session, worktree_path, proxy_id, state,
        reply_to_addr, message_id, message_path, reply_path, status_path,
        queue_id, monitor_of_instance, suffix
      ) VALUES (?, 'tTrailing', 'echo', ?, ?, NULL, 'p1', 'running',
        NULL, ?, '/tmp/trail-msg', '/tmp/trail-reply', '/tmp/trail-status',
        NULL, NULL, 'fff000')
    `).run('trailing-2', 'agent:tTrailing/trailing-2', 'inst-tTrailing-trail2', 'trailing-2');
    const second = await handler.onProxyRegister('p1');
    assert.deepEqual(second, { finalised: 0, failed: 0, skipped: 0 }, 'coincident register returns immediately');

    const firstSummary = await first;
    assert.equal(firstSummary.failed, 2, 'trailing run picked up the row that appeared mid-flight');

    const trailingRow = db.getAgentInstance('trailing-2')!;
    assert.equal(trailingRow.state, 'failed', 'mid-flight row was processed');
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

    // Use a custom proxyResolver (p1 may not own any row referencing this
    // base) and disable the mtime grace so freshly-mkdir'd dirs are eligible.
    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
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
    const keepPath = join(base, 'wt-keep-me');
    mkdirSync(keepPath, { recursive: true });
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?').run(keepPath, id);

    const orphan = join(base, 'wt-real-orphan');
    mkdirSync(orphan, { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
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
    const ghost = join(base, 'wt-ghost-never-existed');
    db.rawDb.prepare('UPDATE agent_instances SET worktree_path = ? WHERE id = ?').run(ghost, id);

    const orphan = join(base, 'wt-actual');
    mkdirSync(orphan, { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
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

    mkdirSync(join(persistentBase, 'wt-persist-orphan'), { recursive: true });
    mkdirSync(join(ephemeralBase, 'wt-ephem-orphan'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
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

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      // Default resolver returns null since no instances exist for this cwdBase
      mtimeGraceMs: 0,
    });
    const result = await sweep.sweep();
    assert.equal(result.removed, 0);
    assert.ok(result.skipped >= 1, 'skipped due to no proxy');
  });

  it('mtime grace: dirs younger than the grace window are not removed (C4)', async () => {
    // C4: a fresh `wt-*` dir is likely a just-spawned instance whose row
    // hasn't yet been observed by the sweep. Default 60s grace protects it.
    const { db, dispatch, recorded } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-grace-'));
    seedTemplate(db, 'tGrace', { cwdBase: base });
    seedTopic(db, 'tGrace');
    mkdirSync(join(base, 'wt-fresh'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      // Default 60s grace — fresh dir is skipped.
    });
    const beforeLen = recorded.length;
    const result = await sweep.sweep();
    const tail = recorded.slice(beforeLen);

    assert.equal(result.removed, 0, 'no removal — dir is too fresh');
    assert.ok(result.skipped >= 1, 'fresh dir was skipped');
    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 0, 'no exec dispatched');
  });

  it('TOCTOU: new instance claims the path between snapshot and rm → rm is NOT dispatched (C4)', async () => {
    // C4: we read the live-instance snapshot, then re-query immediately
    // before rm. If a new instance claimed the same path in the interim,
    // the rm must be cancelled.
    const { db, dispatch, recorded } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-toctou-'));
    seedTemplate(db, 'tTOCTOU', { cwdBase: base });
    seedTopic(db, 'tTOCTOU');
    const orphanPath = join(base, 'wt-contended');
    mkdirSync(orphanPath, { recursive: true });

    // Wedge between the snapshot and the rm by intercepting dispatch on
    // the first `exec` and inserting a live instance row pointing at the
    // contended path JUST BEFORE the rm would happen — but we want the
    // re-query AFTER our insert. Simulate by spying via dispatch.
    const wedgedDispatch = async (pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      recorded.push({ proxyId: pid, command: cmd });
      return { ok: true, data: '' };
    };

    // Manually insert a live instance pointing at `orphanPath` BEFORE we
    // call sweep — this simulates the TOCTOU window. (Production code's
    // re-query catches this.)
    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: wedgedDispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
      fsAdapter: {
        isDirectory: (_p) => true,
        readdir: (_p) => ['wt-contended'],
        fileSize: () => null,
        mtimeMs: () => Date.now() - 120_000, // old enough to skip grace
      },
    });

    // BEFORE sweep, insert a live row that the sweep's INITIAL snapshot will
    // NOT see (we patch listLiveAgentInstances) — but the re-query DOES see.
    // Easier: stub listLiveAgentInstances to return [] the first time, then
    // [{ worktreePath: orphanPath }] the second.
    let snapshotCallCount = 0;
    const origList = db.listLiveAgentInstances.bind(db);
    db.listLiveAgentInstances = ((_opts?: { excludeStates?: any[] }) => {
      snapshotCallCount += 1;
      if (snapshotCallCount === 1) return [];
      // Second + later calls (the re-query): instance has claimed the path.
      return [{
        id: 'sneak-1', agentTemplate: 'tTOCTOU', spawnedFromTopic: 'echo',
        instanceAddr: 'tTOCTOU/echo-sneak-1', tmuxSession: 'tTOCTOU-sneak-1',
        worktreePath: orphanPath, proxyId: 'p1', state: 'running',
        failureReason: null, replyToAddr: null, messageId: 'msg',
        messagePath: '/tmp/m', replyPath: '/tmp/r', statusPath: '/tmp/s',
        queueId: null, monitorOfInstance: null, startedAt: '', completedAt: null,
      }];
    }) as typeof db.listLiveAgentInstances;

    let result: { removed: number; skipped: number };
    let tail: typeof recorded;
    try {
      const beforeLen = recorded.length;
      result = await sweep.sweep();
      tail = recorded.slice(beforeLen);
    } finally {
      // Always restore (defense-in-depth — exception inside sweep mustn't
      // leak a monkey-patched method into the next test's DB instance,
      // even though each test gets a fresh DB).
      db.listLiveAgentInstances = origList;
    }

    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 0, 'rm exec was NOT dispatched — re-query caught the race');
    assert.equal(result.removed, 0);
    assert.ok(result.skipped >= 1, 'TOCTOU-protected path skipped');
  });

  it('single-flight: overlapping ticks do not double-rm (C3)', async () => {
    // C3: if sweep() is invoked twice concurrently, the second call returns
    // immediately without doing a second pass.
    const { db, dispatch, recorded } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-singleflight-'));
    seedTemplate(db, 'tSF', { cwdBase: base });
    seedTopic(db, 'tSF');
    mkdirSync(join(base, 'wt-sf1'), { recursive: true });

    // Make the dispatch slow so concurrent invocation has a chance to race.
    const slowDispatch = async (pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      recorded.push({ proxyId: pid, command: cmd });
      if (cmd.action === 'exec') {
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: true, data: '' };
    };

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: slowDispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });

    const beforeLen = recorded.length;
    const [a, b] = await Promise.all([sweep.sweep(), sweep.sweep()]);
    const tail = recorded.slice(beforeLen);

    // Exactly one exec across both calls.
    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 1, 'single-flight: only one rm exec for one orphan across overlapping ticks');
    const totalRemoved = a.removed + b.removed;
    assert.equal(totalRemoved, 1, 'one removal reported across both calls');
  });

  it('multi-host: orphan routed via proxy that has serviced this cwd_base (C5)', async () => {
    // C5: in a 2-proxy deployment, the orphan under base_for_p2 must be
    // dispatched to p2 (which has serviced the cwd_base), not p1.
    const { db, dispatch, recorded, driver } = makeEnv(tmpDir);
    db.registerProxy('p2', 'tok2', 'localhost:3101');

    const baseForP2 = mkdtempSync(join(tmpDir, 'wt-p2-'));
    seedTemplate(db, 'tP2', { cwdBase: baseForP2 });
    seedTopic(db, 'tP2');

    // Spawn an instance and reassign to p2 — this seeds the join lookup.
    const id = await spawnAndWaitRunning(driver, db, 'tP2', '{}');
    db.rawDb.prepare('UPDATE agent_instances SET proxy_id = ?, state = ? WHERE id = ?')
      .run('p2', 'completed', id);

    mkdirSync(join(baseForP2, 'wt-multi-host-orphan'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      // No explicit resolver — use default (C5 join).
      mtimeGraceMs: 0,
    });
    const beforeLen = recorded.length;
    await sweep.sweep();
    const tail = recorded.slice(beforeLen);

    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 1, 'one removal exec dispatched');
    assert.equal(execs[0]!.proxyId, 'p2', 'routed via p2 (the proxy that serviced this base)');
  });

  it('multi-host: no proxy has ever serviced cwd_base → orphan skipped (C5 fallback)', async () => {
    // C5: when no proxy has any agent_instances row pointing at this
    // cwd_base, default resolver returns null and the orphan is left.
    const { db, dispatch, recorded } = makeEnv(tmpDir);

    const orphanBase = mkdtempSync(join(tmpDir, 'wt-unowned-'));
    seedTemplate(db, 'tUnowned', { cwdBase: orphanBase });
    seedTopic(db, 'tUnowned');
    mkdirSync(join(orphanBase, 'wt-no-host'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      mtimeGraceMs: 0,
    });
    const beforeLen = recorded.length;
    const result = await sweep.sweep();
    const tail = recorded.slice(beforeLen);

    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 0, 'no exec dispatched — no proxy known to own this base');
    assert.equal(result.removed, 0);
    assert.ok(result.skipped >= 1, 'orphan skipped (multi-host safe default)');
  });

  it('command uses git -C <repo_root> when known, else falls back to rm -rf (H5)', async () => {
    // H5: `git worktree remove` must run from the source repo. When the
    // template carries a repo_root distinct from cwd_base, the command must
    // use `git -C <repo_root>`. When repo_root is null, fall back to rm -rf.
    const { db, dispatch, recorded } = makeEnv(tmpDir);

    const base = mkdtempSync(join(tmpDir, 'wt-repo-'));
    const repo = mkdtempSync(join(tmpDir, 'repo-'));
    seedTemplate(db, 'tRepo', { cwdBase: base, repoRoot: repo });
    seedTopic(db, 'tRepo');
    mkdirSync(join(base, 'wt-with-repo'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
    const beforeLen = recorded.length;
    await sweep.sweep();
    const tail = recorded.slice(beforeLen);
    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 1);
    const cmd = (execs[0]!.command as Extract<ProxyCommand, { action: 'exec' }>).command;
    assert.ok(cmd.includes(`git -C '${repo}'`), `command uses git -C <repo_root>; got: ${cmd}`);
  });

  it('fallback: no repo_root → command is plain rm -rf (H5)', async () => {
    const { db, dispatch, recorded } = makeEnv(tmpDir);

    const base = mkdtempSync(join(tmpDir, 'wt-norepo-'));
    seedTemplate(db, 'tNoRepo', { cwdBase: base, repoRoot: null });
    seedTopic(db, 'tNoRepo');
    mkdirSync(join(base, 'wt-no-repo'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
    const beforeLen = recorded.length;
    await sweep.sweep();
    const tail = recorded.slice(beforeLen);
    const execs = tail.filter((r) => r.command.action === 'exec');
    assert.equal(execs.length, 1);
    const cmd = (execs[0]!.command as Extract<ProxyCommand, { action: 'exec' }>).command;
    assert.ok(cmd.includes('rm -rf'), `command falls back to rm -rf; got: ${cmd}`);
    assert.ok(!cmd.includes('git -C'), `no git invocation without repo_root; got: ${cmd}`);
    // MEDIUM-2: removal is wrapped so a missing path reports ABSENT instead
    // of rm -rf silently exiting 0.
    assert.ok(cmd.includes('test -d'), `command guards on existence; got: ${cmd}`);
    assert.ok(cmd.includes('__ORPHAN_ABSENT__'), `command reports absence; got: ${cmd}`);
  });

  it('custom prefix is anchored: "wt-" does not match "old-wt-backup" (LOW)', async () => {
    const { db, dispatch, recorded } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-anchor-'));
    seedTemplate(db, 'tAnchor', { cwdBase: base });
    seedTopic(db, 'tAnchor');
    mkdirSync(join(base, 'old-wt-backup'), { recursive: true });
    mkdirSync(join(base, 'wt-real-candidate'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
      prefix: 'wt-', // unanchored user input — must be anchored internally
    });
    const beforeLen = recorded.length;
    await sweep.sweep();
    const tail = recorded.slice(beforeLen);
    const execs = tail.filter((r) => r.command.action === 'exec');

    assert.equal(execs.length, 1, 'only the genuinely prefixed dir targeted');
    const cmd = (execs[0]!.command as Extract<ProxyCommand, { action: 'exec' }>).command;
    assert.ok(cmd.includes('wt-real-candidate'), 'prefixed candidate targeted');
    assert.ok(!cmd.includes('old-wt-backup'), 'mid-name match NOT swept');
  });

  it('removal exec reporting ABSENT is counted as skipped, not removed (MEDIUM-2)', async () => {
    // `rm -rf` of a missing path exits 0 — previously logged + counted as
    // 'removed', masking wrong-host dispatch as success.
    const { db, recorded } = makeEnv(tmpDir);
    const base = mkdtempSync(join(tmpDir, 'wt-absent-'));
    seedTemplate(db, 'tAbsent', { cwdBase: base });
    seedTopic(db, 'tAbsent');
    mkdirSync(join(base, 'wt-on-other-host'), { recursive: true });

    const absentDispatch = async (pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      recorded.push({ proxyId: pid, command: cmd });
      // The executing host has no such path — removal command echoes ABSENT.
      return { ok: true, data: '__ORPHAN_ABSENT__' };
    };

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: absentDispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });
    const result = await sweep.sweep();

    assert.equal(result.removed, 0, 'ABSENT response NOT counted as removed');
    assert.ok(result.skipped >= 1, 'ABSENT response counted as skipped');
  });

  it('"no proxy has serviced this base" warning fires once, not per tick (MEDIUM-2)', async () => {
    const { db, dispatch } = makeEnv(tmpDir);
    db.removeProxy('p1');
    const base = mkdtempSync(join(tmpDir, 'wt-warn-'));
    seedTemplate(db, 'tWarn', { cwdBase: base });
    seedTopic(db, 'tWarn');
    mkdirSync(join(base, 'wt-unrouteable'), { recursive: true });

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      mtimeGraceMs: 0,
      // Default resolver — no proxy has serviced this base.
    });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await sweep.sweep();
      await sweep.sweep();
      await sweep.sweep();
    } finally {
      console.warn = origWarn;
    }

    const noProxyWarnings = warnings.filter((w) => w.includes('no proxy has ever serviced'));
    assert.equal(noProxyWarnings.length, 1, 'warning deduped across ticks');
  });

  it('invisible cwd_base warns loudly once and counts skipped (CRITICAL-2)', async () => {
    // Docker shape: the base exists on the host but is not bind-mounted into
    // the orchestrator container — local isDirectory says false.
    const { db, dispatch } = makeEnv(tmpDir);
    seedTemplate(db, 'tInvisible', { cwdBase: '/host-only/worktree-base' });
    seedTopic(db, 'tInvisible');

    const sweep = new OrphanedWorktreeSweep({
      db, proxyDispatch: dispatch,
      proxyResolver: () => 'p1',
      mtimeGraceMs: 0,
    });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let first: { removed: number; skipped: number };
    try {
      first = await sweep.sweep();
      await sweep.sweep();
    } finally {
      console.warn = origWarn;
    }

    assert.equal(first.removed, 0, 'nothing "removed" from an invisible base');
    assert.ok(first.skipped >= 1, 'invisible base counted as skipped, not silently succeeding');
    const visibilityWarnings = warnings.filter((w) => w.includes('not visible from the'));
    assert.equal(visibilityWarnings.length, 1, 'prominent warning fired exactly once across ticks');
  });
});
