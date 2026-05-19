/**
 * Tests for InstanceReaper — covers invariants #5, #6, #7 from
 * docs/v3-upgrade-prompt.md §Q3 (and a single-flight regression).
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { TopicDelivery } from './topic-delivery.ts';
import { InstanceReaper } from './instance-reaper.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import type { ProxyCommand, ProxyResponse, AgentTemplateRow, TopicRow } from '../shared/types.ts';

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

async function spawnAndWaitRunning(driver: TopicDelivery, db: Database, template: string, payload: string): Promise<string> {
  await driver.publish({ agentTemplate: template, topicName: 'echo', payload });
  // Wait for spawn loop to settle and set state=running.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const live = db.listLiveAgentInstances();
    const running = live.find((r) => r.state === 'running');
    if (running) return running.id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('instance never reached running state');
}

describe('InstanceReaper — Q3 invariants', () => {
  let tmpDir: string;
  let ipcRoot: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'instance-reaper-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    ipcRoot = mkdtempSync(join(tmpDir, 'ipc-'));
  });

  /**
   * Make a fresh in-memory-ish env: DB, dispatch, driver, reaper. Returns the
   * recorded command list so tests can assert ordering. The dispatch is
   * synthesised per-test so each test gets an isolated command log.
   */
  function makeEnv() {
    const db = new Database(join(tmpDir, `r-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    const commands: ProxyCommand[] = [];
    const dispatch = async (_pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      commands.push(cmd);
      return { ok: true, data: '' };
    };
    const locks = new LockManager(db.rawDb);
    const messageDispatcher = new MessageDispatcher({ db, locks, proxyDispatch: dispatch, orchestratorHost: 'http://localhost:3000' });
    const driver = new TopicDelivery({ db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks });
    const reaper = new InstanceReaper({ db, proxyDispatch: dispatch, messageDispatcher, topicDelivery: driver, sweepIntervalMs: 50 });
    return { db, dispatch, commands, driver, reaper, messageDispatcher };
  }

  it('invariant #5: reaper reads $STATUS_PATH + $REPLY_PATH BEFORE kill_session', async () => {
    const { db, driver } = makeEnv();
    seedTemplate(db, 'tH');
    seedTopic(db, 'tH');
    const id = await spawnAndWaitRunning(driver, db, 'tH', '{"echo":"hi"}');
    const inst = db.getAgentInstance(id)!;

    // Agent signals completion BEFORE we wire up the observable reaper.
    writeFileSync(inst.replyPath, JSON.stringify({ echoed: { echo: 'hi' } }));
    writeFileSync(inst.statusPath, 'ok\n');

    // Shared timeline records every fs read and every proxyDispatch call in
    // the exact order they occur. Invariant #5 says: every read against the
    // instance's STATUS_PATH or REPLY_PATH must appear in the timeline
    // BEFORE any `kill_session` dispatch for that instance.
    type Event =
      | { kind: 'read'; path: string }
      | { kind: 'stat'; path: string }
      | { kind: 'dispatch'; action: string; sessionName?: string };
    const timeline: Event[] = [];

    const realFs = await import('node:fs');
    const fsAdapter = {
      statSync: (p: string) => {
        timeline.push({ kind: 'stat', path: p });
        return realFs.statSync(p);
      },
      readFileSync: (p: string, e: BufferEncoding) => {
        timeline.push({ kind: 'read', path: p });
        return realFs.readFileSync(p, e) as string;
      },
    };

    const observableDispatch = async (_pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      const ev: { kind: 'dispatch'; action: string; sessionName?: string } = { kind: 'dispatch', action: cmd.action };
      if ('sessionName' in cmd && typeof cmd.sessionName === 'string') ev.sessionName = cmd.sessionName;
      timeline.push(ev);
      return { ok: true, data: '' };
    };

    const reaperLocks = new LockManager(db.rawDb);
    const reaperUnderTest = new InstanceReaper({
      db,
      proxyDispatch: observableDispatch,
      messageDispatcher: new MessageDispatcher({ db, locks: reaperLocks, proxyDispatch: observableDispatch, orchestratorHost: 'x' }),
      topicDelivery: driver,
      sweepIntervalMs: 50,
      fsAdapter,
    });

    // Trip tryFinalize once.
    await reaperUnderTest.wake(inst.id);

    // Find the read indexes for STATUS_PATH and REPLY_PATH.
    const statusReadIdx = timeline.findIndex((e) => e.kind === 'read' && e.path === inst.statusPath);
    const replyReadIdx = timeline.findIndex((e) => e.kind === 'read' && e.path === inst.replyPath);
    const killIdx = timeline.findIndex(
      (e) => e.kind === 'dispatch' && e.action === 'kill_session' && (!('sessionName' in e) || e.sessionName === inst.tmuxSession),
    );

    assert.ok(statusReadIdx >= 0, `STATUS_PATH read observed in timeline (${JSON.stringify(timeline.map(e => e.kind === 'dispatch' ? e.action : e.kind))})`);
    assert.ok(replyReadIdx >= 0, 'REPLY_PATH read observed in timeline');
    assert.ok(killIdx >= 0, 'kill_session dispatched');
    assert.ok(statusReadIdx < killIdx, `STATUS_PATH read(${statusReadIdx}) BEFORE kill_session(${killIdx})`);
    assert.ok(replyReadIdx < killIdx, `REPLY_PATH read(${replyReadIdx}) BEFORE kill_session(${killIdx})`);
  });

  it('invariant #6: kill_session precedes cleanup', async () => {
    const { db, commands, driver, reaper } = makeEnv();
    seedTemplate(db, 'tI', { hookCleanup: 'echo my-cleanup-marker' });
    seedTopic(db, 'tI');
    const id = await spawnAndWaitRunning(driver, db, 'tI', '{}');
    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, '{}');
    writeFileSync(inst.statusPath, 'ok\n');

    const lenBefore = commands.length;
    await reaper.wake(inst.id);
    const tail = commands.slice(lenBefore);

    const killIdx = tail.findIndex(c => c.action === 'kill_session');
    const cleanupIdx = tail.findIndex(c => c.action === 'exec' && (c as Extract<ProxyCommand, { action: 'exec' }>).command.includes('my-cleanup-marker'));
    assert.ok(killIdx >= 0, 'kill_session dispatched');
    assert.ok(cleanupIdx >= 0, 'cleanup exec dispatched');
    assert.ok(killIdx < cleanupIdx, `kill_session(${killIdx}) precedes cleanup(${cleanupIdx})`);
  });

  it('invariant #7: collab complete is idempotent (second wake leaves only one reply row)', async () => {
    const { db, driver, reaper } = makeEnv();
    seedTemplate(db, 'tJ');
    seedTopic(db, 'tJ');
    const id = await spawnAndWaitRunning(driver, db, 'tJ', '{}');
    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, '{"r":1}');
    writeFileSync(inst.statusPath, 'ok\n');

    // Set replyToAddr so a pending_messages row is actually written.
    db.rawDb.prepare(`UPDATE agent_instances SET reply_to_addr = 'somebody' WHERE id = ?`).run(inst.id);

    await reaper.wake(inst.id);
    await reaper.wake(inst.id); // second wake — must be a no-op.

    const replies = db.rawDb.prepare(
      `SELECT COUNT(*) AS n FROM pending_messages WHERE target_agent = 'somebody'`,
    ).get() as { n: number };
    assert.equal(replies.n, 1, 'only one reply row even after second wake');
  });

  it('invariant #9: reply targets BARE name (no `agent:` prefix in target_agent)', async () => {
    const { db, driver, reaper } = makeEnv();
    seedTemplate(db, 'tK');
    seedTopic(db, 'tK');
    const id = await spawnAndWaitRunning(driver, db, 'tK', '{}');
    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, 'reply');
    writeFileSync(inst.statusPath, 'ok\n');
    // Even if the publisher gave a prefixed address, the reaper must
    // normalize to the bare name before persisting.
    db.rawDb.prepare(`UPDATE agent_instances SET reply_to_addr = 'agent:publisher' WHERE id = ?`).run(inst.id);

    await reaper.wake(inst.id);

    const row = db.rawDb.prepare(
      `SELECT target_agent FROM pending_messages ORDER BY id DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    assert.ok(row, 'pending_messages row exists after wake (regression sentinel — invariant #9 only meaningful if a row was actually enqueued)');
    const target = String(row['target_agent']);
    assert.equal(target, 'publisher', 'bare name, no prefix');
    assert.ok(!target.includes(':'), 'target_agent has no colon');
  });

  // ── Q4: typed WS event emissions on completion path ─────────────────
  //
  // Reaper's `onEvent` callback mirrors the topic-delivery surface — it must
  // emit `instance_completed` on ok status, `instance_failed` on error
  // status, and a `topic_queue_changed` recompute after the queue row flips
  // terminal. The shapes match `WsEvent` exactly so main.ts can pass it
  // straight to `wss.broadcastEvent`.

  it('Q4: emits instance_completed on successful finalization', async () => {
    const db = new Database(join(tmpDir, `r-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    const commands: ProxyCommand[] = [];
    const dispatch = async (_pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      commands.push(cmd);
      return { ok: true, data: '' };
    };
    const locks = new LockManager(db.rawDb);
    const messageDispatcher = new MessageDispatcher({ db, locks, proxyDispatch: dispatch, orchestratorHost: 'http://localhost:3000' });
    const driver = new TopicDelivery({ db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const reaper = new InstanceReaper({
      db, proxyDispatch: dispatch, messageDispatcher, topicDelivery: driver, sweepIntervalMs: 50,
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    seedTemplate(db, 'tQ4ok');
    seedTopic(db, 'tQ4ok');
    const id = await spawnAndWaitRunning(driver, db, 'tQ4ok', '{}');
    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, '{"r":1}');
    writeFileSync(inst.statusPath, 'ok\n');

    await reaper.wake(inst.id);

    const completed = events.filter((e) => e.type === 'instance_completed');
    assert.equal(completed.length, 1, 'one instance_completed event');
    const ev = completed[0] as { instance: { id: string; state: string } };
    assert.equal(ev.instance.id, inst.id);
    assert.equal(ev.instance.state, 'completed', 'event payload is the post-update row');

    // And a queue-depth recompute follows the queue-row flip.
    const queueDepth = events.filter((e) => e.type === 'topic_queue_changed');
    assert.ok(queueDepth.length >= 1, 'at least one topic_queue_changed after completion');
    assert.equal((queueDepth[queueDepth.length - 1] as { topic: string }).topic, 'echo');
  });

  it('Q4: emits instance_failed when status is `error`', async () => {
    const db = new Database(join(tmpDir, `r-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    const commands: ProxyCommand[] = [];
    const dispatch = async (_pid: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      commands.push(cmd);
      return { ok: true, data: '' };
    };
    const locks = new LockManager(db.rawDb);
    const messageDispatcher = new MessageDispatcher({ db, locks, proxyDispatch: dispatch, orchestratorHost: 'http://localhost:3000' });
    const driver = new TopicDelivery({ db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const reaper = new InstanceReaper({
      db, proxyDispatch: dispatch, messageDispatcher, topicDelivery: driver, sweepIntervalMs: 50,
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    seedTemplate(db, 'tQ4err');
    seedTopic(db, 'tQ4err');
    const id = await spawnAndWaitRunning(driver, db, 'tQ4err', '{}');
    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, 'unused');
    // Status `error\n<details>` → reaper records failure_reason and emits failed.
    writeFileSync(inst.statusPath, 'error\nthe agent ran out of context');

    await reaper.wake(inst.id);

    const failed = events.filter((e) => e.type === 'instance_failed');
    assert.equal(failed.length, 1, 'one instance_failed event');
    const ev = failed[0] as { instance: { id: string; state: string; failureReason: string | null }; reason: string | null };
    assert.equal(ev.instance.id, inst.id);
    assert.equal(ev.instance.state, 'failed');
    assert.equal(ev.reason, ev.instance.failureReason, 'event.reason mirrors instance.failureReason');
    assert.ok(ev.reason && ev.reason.includes('ran out of context'), 'reason carries the agent-supplied detail');
  });

  it('invariant #7 (secondary): empty status file = in-progress; no finalization', async () => {
    const { db, driver, reaper, commands } = makeEnv();
    seedTemplate(db, 'tL');
    seedTopic(db, 'tL');
    const id = await spawnAndWaitRunning(driver, db, 'tL', '{}');
    const inst = db.getAgentInstance(id)!;
    // status file exists but empty — reaper must treat as in-progress.
    const lenBefore = commands.length;
    await reaper.wake(inst.id);
    const tail = commands.slice(lenBefore);
    assert.equal(tail.filter(c => c.action === 'kill_session').length, 0, 'no kill_session for in-progress');
    const fresh = db.getAgentInstance(inst.id)!;
    assert.equal(fresh.state, 'running', 'state unchanged');
  });

  // ── Q6: monitor sidecar teardown ────────────────────────────────────

  it('Q6: worker completion tears down paired monitor (kill_session + cleanup)', async () => {
    const { db, commands, driver, reaper } = makeEnv();
    seedTemplate(db, 'worker-r6');
    seedTemplate(db, 'mon-r6', { hookStart: 'echo m-start', hookPrepare: null, hookCleanup: 'echo monitor-cleanup-marker' });
    seedTopic(db, 'worker-r6', { monitorTemplate: 'mon-r6' });

    const id = await spawnAndWaitRunning(driver, db, 'worker-r6', '{}');
    // Wait for the monitor to spawn too.
    const deadline = Date.now() + 2000;
    let monitor: ReturnType<typeof db.findMonitorForWorker> = null;
    while (Date.now() < deadline) {
      monitor = db.findMonitorForWorker(id);
      if (monitor && monitor.state === 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(monitor, 'monitor row exists');
    assert.equal(monitor!.state, 'running');

    const inst = db.getAgentInstance(id)!;
    writeFileSync(inst.replyPath, '{}');
    writeFileSync(inst.statusPath, 'ok\n');

    const lenBefore = commands.length;
    await reaper.wake(inst.id);
    const tail = commands.slice(lenBefore);

    // kill_session for the MONITOR specifically.
    const monitorKill = tail.find(
      (c) => c.action === 'kill_session' && (c as Extract<ProxyCommand, { action: 'kill_session' }>).sessionName === monitor!.tmuxSession,
    );
    assert.ok(monitorKill, 'kill_session dispatched for monitor session');

    // cleanup exec for the monitor (carrying the cleanup marker), cwd=cwdBase.
    const monitorCleanup = tail.find(
      (c) => c.action === 'exec'
        && (c as Extract<ProxyCommand, { action: 'exec' }>).command.includes('monitor-cleanup-marker'),
    ) as Extract<ProxyCommand, { action: 'exec' }> | undefined;
    assert.ok(monitorCleanup, 'monitor cleanup exec dispatched');
    assert.equal(monitorCleanup!.cwd, '/tmp', 'cleanup runs in cwd_base');

    // kill_session precedes cleanup (mirrors invariant #6 for the monitor).
    const monKillIdx = tail.indexOf(monitorKill!);
    const monCleanupIdx = tail.indexOf(monitorCleanup!);
    assert.ok(monKillIdx < monCleanupIdx, `monitor kill_session(${monKillIdx}) precedes monitor cleanup(${monCleanupIdx})`);

    // Monitor row reaches `completed`.
    const finalMonitor = db.getAgentInstance(monitor!.id);
    assert.ok(finalMonitor, 'monitor row still exists');
    assert.equal(finalMonitor!.state, 'completed', 'monitor reaches completed');
    assert.ok(finalMonitor!.completedAt, 'monitor.completedAt set');
  });

  it('Q6: monitor that calls collab complete first is finalised independently and worker is untouched', async () => {
    const { db, driver, reaper } = makeEnv();
    seedTemplate(db, 'worker-r6b');
    seedTemplate(db, 'mon-r6b', { hookStart: 'echo m-start', hookPrepare: null, hookCleanup: 'echo m-cleanup' });
    seedTopic(db, 'worker-r6b', { monitorTemplate: 'mon-r6b' });

    const workerId = await spawnAndWaitRunning(driver, db, 'worker-r6b', '{}');
    const deadline = Date.now() + 2000;
    let monitor = null as ReturnType<typeof db.findMonitorForWorker>;
    while (Date.now() < deadline) {
      monitor = db.findMonitorForWorker(workerId);
      if (monitor && monitor.state === 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(monitor, 'monitor row exists');

    // Monitor finalises FIRST — write status to its own status path. Then
    // tryFinalize on the monitor row directly. Worker stays running.
    writeFileSync(monitor!.replyPath, '{}');
    writeFileSync(monitor!.statusPath, 'ok\n');

    await reaper.wake(monitor!.id);

    const monitorAfter = db.getAgentInstance(monitor!.id)!;
    assert.equal(monitorAfter.state, 'completed', 'monitor reaches terminal state independently');

    // Worker still running, untouched.
    const workerAfter = db.getAgentInstance(workerId)!;
    assert.equal(workerAfter.state, 'running', 'worker still running');
    assert.equal(workerAfter.completedAt, null, 'worker not yet completed');

    // findMonitorForWorker now returns null — the monitor is terminal.
    const stillLive = db.findMonitorForWorker(workerId);
    assert.equal(stillLive, null, 'no live monitor remains for the worker');
  });
});
