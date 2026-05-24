/**
 * Tests for TopicDelivery — covers invariants #1, #2, #3, #4, #7, #8, #9
 * from docs/v3-upgrade-prompt.md §Q3 (others live in instance-reaper.test.ts).
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { TopicDelivery } from './topic-delivery.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentTemplateRow, TopicRow } from '../shared/types.ts';

function seedTemplate(db: Database, id: string, opts?: Partial<AgentTemplateRow>): void {
  const row: AgentTemplateRow = {
    id,
    personaPath: null,
    engine: 'claude',
    model: null,
    persistent: false,
    cwdBase: '/tmp',
    cwdTemplate: null,
    repoRoot: '/tmp',
    hookStart: 'echo started',
    hookExit: null,
    hookPrepare: 'echo preparing',
    hookCleanup: 'echo cleaning',
    createdAt: '',
    updatedAt: '',
    ...opts,
  };
  db.upsertAgentTemplate(row);
}

function seedTopic(db: Database, templateId: string, opts?: Partial<TopicRow>): void {
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
    ...opts,
  };
  db.replaceTopicsForTemplate(templateId, [row]);
}

describe('TopicDelivery — Q3 invariants', () => {
  let db: Database;
  let tmpDir: string;
  let ipcRoot: string;
  let commands: ProxyCommand[];
  let dispatch: (id: string, cmd: ProxyCommand) => Promise<ProxyResponse>;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'topic-delivery-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db = new Database(join(tmpDir, `td-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    ipcRoot = mkdtempSync(join(tmpDir, 'ipc-'));
    commands = [];
    dispatch = async (_pid, cmd) => {
      commands.push(cmd);
      if (cmd.action === 'exec') return { ok: true, data: '' };
      if (cmd.action === 'create_session') return { ok: true };
      if (cmd.action === 'paste') return { ok: true };
      if (cmd.action === 'send_keys') return { ok: true };
      if (cmd.action === 'kill_session') return { ok: true };
      return { ok: true };
    };
  });

  it('invariant #1: concurrent claim attempts on concurrency:1 → exactly one row in agent_instances', async () => {
    seedTemplate(db, 'tA');
    seedTopic(db, 'tA', { concurrency: 1 });

    // Directly enqueue TWO topic_queue rows (publish would also work, but we
    // want to race claimAndCreateInstance specifically — that's where the
    // BLOCKER 3 fix lives). Then race two claim attempts in `Promise.all`.
    db.enqueueTopicMessage({ agentTemplate: 'tA', topicName: 'echo', payload: '{"n":1}' });
    db.enqueueTopicMessage({ agentTemplate: 'tA', topicName: 'echo', payload: '{"n":2}' });

    // Build claim option templates so the two calls race over the same cap.
    const claimOpts = (s: string) => ({
      agentTemplate: 'tA',
      topicName: 'echo',
      instanceId: `race-${s}`,
      instanceAddr: `agent:tA/race-${s}`,
      tmuxSession: `inst-tA-race-${s}`,
      proxyId: 'p1',
      messageId: `race-${s}`,
      messagePath: `/tmp/m-${s}`,
      replyPath: `/tmp/r-${s}`,
      statusPath: `/tmp/s-${s}`,
      worktreePath: null,
      suffix: s.slice(0, 6).padEnd(6, '0'),
      concurrency: 1,
    });

    // BEGIN IMMEDIATE serializes; the second TX blocks on the first, then
    // re-reads the live count. With the fix, exactly one claim survives.
    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => db.claimAndCreateInstance(claimOpts('A'))),
      Promise.resolve().then(() => db.claimAndCreateInstance(claimOpts('B'))),
    ]);

    const survivors = [r1, r2].filter((r) => r != null);
    assert.equal(survivors.length, 1, 'exactly one claim survives concurrency:1 cap');

    // Direct DB observation: only one agent_instances row for the topic.
    const liveRow = db.rawDb.prepare(
      `SELECT COUNT(*) AS n FROM agent_instances WHERE agent_template = 'tA' AND spawned_from_topic = 'echo'`,
    ).get() as { n: number };
    assert.equal(liveRow.n, 1, 'exactly one agent_instances row for (tA, echo)');

    // And the queue: one row was claimed, the other still queued.
    const queuedRows = db.rawDb.prepare(
      `SELECT status FROM topic_queue WHERE agent_template = 'tA' AND topic_name = 'echo'`,
    ).all() as Array<{ status: string }>;
    const claimed = queuedRows.filter((r) => r.status === 'claimed').length;
    const queued = queuedRows.filter((r) => r.status === 'queued').length;
    assert.equal(claimed, 1, 'one queue row claimed');
    assert.equal(queued, 1, 'one queue row still queued (waiting for first to finish)');
  });

  it('invariant #1 (driver-level): two concurrent publishes still yield exactly one live instance', async () => {
    seedTemplate(db, 'tA2');
    seedTopic(db, 'tA2', { concurrency: 1 });
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    const [r1, r2] = await Promise.all([
      driver.publish({ agentTemplate: 'tA2', topicName: 'echo', payload: '{"n":1}' }),
      driver.publish({ agentTemplate: 'tA2', topicName: 'echo', payload: '{"n":2}' }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    await new Promise(r => setTimeout(r, 100));

    const live = db.listLiveAgentInstances();
    const forTopic = live.filter((r) => r.agentTemplate === 'tA2' && r.spawnedFromTopic === 'echo');
    assert.equal(forTopic.length, 1, 'exactly one instance live for concurrency:1 topic');
  });

  it('invariant #2: agent_instances INSERT in same TX as claim → address resolvable immediately', async () => {
    seedTemplate(db, 'tB');
    seedTopic(db, 'tB');
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    const r = await driver.publish({ agentTemplate: 'tB', topicName: 'echo', payload: '{}' });
    assert.equal(r.ok, true);
    // Even before the proxy commands settle (dispatch is fire-and-forget),
    // an instance row must exist as soon as publish resolved on the queue
    // side. We wait a microtask to let claim+insert complete.
    await new Promise(r => setTimeout(r, 50));

    const live = db.listLiveAgentInstances();
    assert.ok(live.length >= 1, 'instance row inserted');
    const inst = live[0]!;
    const resolved = db.getAgentInstanceByAddr(inst.instanceAddr);
    assert.ok(resolved, 'instance address resolves to live row');
    assert.equal(resolved!.id, inst.id);
  });

  it('invariant #3: proxy command sequence is prepare → create_session → set-env × N → paste', async () => {
    seedTemplate(db, 'tC', { hookPrepare: 'echo prep', hookStart: 'echo start' });
    seedTopic(db, 'tC');
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    await driver.publish({ agentTemplate: 'tC', topicName: 'echo', payload: '{}' });
    await new Promise(r => setTimeout(r, 250));

    // Build the canonical ordering from observed commands.
    const seq = commands.map(c => c.action);
    const idxPrepare = seq.findIndex((a, i) => a === 'exec' && (commands[i] as any).command?.includes('echo prep'));
    const idxCreate = seq.indexOf('create_session');
    const idxFirstSetEnv = seq.findIndex((a, i) => a === 'exec' && (commands[i] as any).command?.startsWith('tmux set-environment'));
    const idxFirstPaste = seq.indexOf('paste');

    assert.ok(idxPrepare >= 0, 'prepare exec dispatched');
    assert.ok(idxCreate > idxPrepare, 'create_session after prepare');
    assert.ok(idxFirstSetEnv > idxCreate, 'set-env after create_session');
    assert.ok(idxFirstPaste > idxFirstSetEnv, 'paste after set-env');

    // Prepare timeout must be >= 60s (Q3 hazard).
    const prepareCmd = commands[idxPrepare] as Extract<ProxyCommand, { action: 'exec' }>;
    assert.equal(prepareCmd.timeoutMs, 60_000);
  });

  it('invariant #4: every tmux set-environment exec runs before the first paste AND uses the tmux-safe env subset', async () => {
    seedTemplate(db, 'tD');
    seedTopic(db, 'tD');
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    // Payload contains a newline so we can prove MESSAGE_CONTENT never
    // reaches `tmux set-environment` (BLOCKER 7 — payloads with newlines
    // would corrupt tmux env state).
    const payload = 'line1\nline2\nline3';
    await driver.publish({ agentTemplate: 'tD', topicName: 'echo', payload });
    await new Promise(r => setTimeout(r, 250));

    const firstPasteIdx = commands.findIndex(c => c.action === 'paste');
    assert.ok(firstPasteIdx >= 0, 'paste exists');
    // Collect all set-env exec indexes.
    const setEnvCommands = commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.action === 'exec' && (c as Extract<ProxyCommand, { action: 'exec' }>).command.startsWith('tmux set-environment'));

    assert.ok(setEnvCommands.length > 0, 'at least one set-env dispatched');
    for (const { i: idx } of setEnvCommands) {
      assert.ok(idx < firstPasteIdx, `set-env at ${idx} precedes first paste at ${firstPasteIdx}`);
    }

    // BLOCKER 7: assert the set-environment loop runs exactly
    // `len(tmuxSessionEnv)` times — i.e. once per tmux-safe key, NOT once
    // per host-shell key.
    const { TMUX_SAFE_ENV_KEYS } = await import('./instance-env.ts');
    assert.equal(
      setEnvCommands.length,
      TMUX_SAFE_ENV_KEYS.length,
      `set-env dispatched exactly ${TMUX_SAFE_ENV_KEYS.length} times (one per tmux-safe key)`,
    );

    // BLOCKER 7: MESSAGE_CONTENT must NEVER appear in any tmux set-environment.
    for (const { c } of setEnvCommands) {
      const cmd = (c as Extract<ProxyCommand, { action: 'exec' }>).command;
      assert.ok(!cmd.includes('MESSAGE_CONTENT'), `tmux set-environment must not carry MESSAGE_CONTENT (cmd: ${cmd})`);
      // And the keys must be from the safe list.
      const m = cmd.match(/tmux set-environment -t \S+ (?:'([^']+)'|"([^"]+)"|(\S+))/);
      const key = m ? (m[1] ?? m[2] ?? m[3]) : '';
      assert.ok(
        (TMUX_SAFE_ENV_KEYS as readonly string[]).includes(key!),
        `tmux set-env key "${key}" is in TMUX_SAFE_ENV_KEYS`,
      );
    }
  });

  it('invariant #7: publish writes the payload to MESSAGE_PATH for the agent to read', async () => {
    seedTemplate(db, 'tE');
    seedTopic(db, 'tE');
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    await driver.publish({ agentTemplate: 'tE', topicName: 'echo', payload: '{"hello":"world"}' });
    await new Promise(r => setTimeout(r, 150));

    const live = db.listLiveAgentInstances();
    assert.ok(live[0]);
    const content = readFileSync(live[0]!.messagePath, 'utf8');
    assert.equal(content, '{"hello":"world"}');
    assert.ok(existsSync(live[0]!.replyPath));
    assert.ok(existsSync(live[0]!.statusPath));
  });

  it('invariant #8: db.listAgents() excludes agent_instances rows (tables are disjoint)', () => {
    seedTemplate(db, 'tF');
    seedTopic(db, 'tF');
    // Enqueue + claim → ephemeral `agent_instances` row exists.
    db.enqueueTopicMessage({ agentTemplate: 'tF', topicName: 'echo', payload: '{}' });
    const claim = db.claimAndCreateInstance({
      agentTemplate: 'tF',
      topicName: 'echo',
      instanceId: 'forced-id-2',
      instanceAddr: 'agent:tF/forced-id-2',
      tmuxSession: 'inst-tF-forced-id-2',
      proxyId: 'p1',
      messageId: 'forced-id-2',
      messagePath: '/tmp/msg',
      replyPath: '/tmp/reply',
      statusPath: '/tmp/status',
      worktreePath: null,
      suffix: 'test02',
    });
    assert.ok(claim, 'claim succeeds');

    // Direct evidence the ephemeral row exists in `agent_instances` …
    const instanceRow = db.getAgentInstance('forced-id-2');
    assert.ok(instanceRow, 'agent_instances row written');
    assert.equal(instanceRow!.instanceAddr, 'agent:tF/forced-id-2');

    // … but db.listAgents() (which reads the `agents` table) returns nothing
    // matching the instance addr OR the instance id. listAgents must not
    // union the two tables.
    const agents = db.listAgents();
    for (const a of agents) {
      assert.notEqual(a.name, 'forced-id-2', 'agent_instances id does not surface as agent name');
      assert.notEqual(a.name, 'agent:tF/forced-id-2', 'instance addr does not surface as agent name');
      assert.notEqual(a.tmuxSession, 'inst-tF-forced-id-2', 'instance tmux session not in agents table');
    }
    // And the listAgents result is genuinely empty because no row was ever
    // inserted into `agents` for this test — proves listAgents excludes
    // agent_instances by querying the right table, not by lucky filter order.
    assert.equal(agents.length, 0, 'no agents table rows — only agent_instances rows exist');
  });

  it('invariant #11: proxy/main.ts injects bin/collab onto PATH for spawned tmux sessions', () => {
    // Read the proxy's main file and assert the PATH-inheritance prelude
    // is intact. The actual end-to-end check ("`which collab` in a tmux
    // pane returns a path") is part of tests/v3-smoke.sh; this is the
    // structural guarantee that the orchestrator can rely on.
    const proxyMainPath = join(import.meta.dirname!, '..', 'proxy', 'main.ts');
    const src = readFileSync(proxyMainPath, 'utf8');
    assert.match(src, /collabBinDir = join\(import\.meta\.dirname,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'bin'\)/, 'proxy points to ../../bin');
    assert.match(src, /process\.env\['PATH'\]\s*=\s*`\$\{collabBinDir\}/, 'proxy prepends bin/ to PATH');
  });

  // ── Q4: typed WS event emissions ────────────────────────────────────
  //
  // The driver receives a recording `onEvent` callback shaped identically to
  // `wss.broadcastEvent` (typed `WsEvent`). These tests freeze the contract
  // for `instance_spawned` and `topic_queue_changed` so consumer-side Q9 work
  // can rely on stable payload shapes.

  it('Q4: emits instance_spawned event after claim+insert succeeds', async () => {
    seedTemplate(db, 'tQ4a');
    seedTopic(db, 'tQ4a');
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    await driver.publish({ agentTemplate: 'tQ4a', topicName: 'echo', payload: '{}' });
    // Let the fire-and-forget spawn complete (start hook pasted, state=running).
    await new Promise((r) => setTimeout(r, 250));

    const spawned = events.filter((e) => e.type === 'instance_spawned');
    assert.equal(spawned.length, 1, 'exactly one instance_spawned event');
    const inst = (spawned[0] as { instance: { id: string; state: string; agentTemplate: string } }).instance;
    assert.ok(inst, 'event carries an instance row');
    assert.equal(inst.agentTemplate, 'tQ4a');
    assert.equal(inst.state, 'running', 'instance state is post-update (running)');
  });

  it('Q4: emits topic_queue_changed when a queue row is claimed', async () => {
    seedTemplate(db, 'tQ4b');
    seedTopic(db, 'tQ4b');
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    await driver.publish({ agentTemplate: 'tQ4b', topicName: 'echo', payload: '{}' });
    await new Promise((r) => setTimeout(r, 250));

    const depthEvents = events.filter((e) => e.type === 'topic_queue_changed');
    // We expect at least 2: one after enqueue (depth=1), one after claim (depth=0).
    assert.ok(depthEvents.length >= 2, `at least two topic_queue_changed events (got ${depthEvents.length})`);
    for (const ev of depthEvents) {
      assert.equal((ev as { agentTemplate: string }).agentTemplate, 'tQ4b');
      assert.equal((ev as { topic: string }).topic, 'echo');
      assert.equal(typeof (ev as { depth: unknown }).depth, 'number');
    }
    // After claim resolves the queue row, depth must drop to zero.
    const finalDepth = depthEvents[depthEvents.length - 1] as { depth: number };
    assert.equal(finalDepth.depth, 0, 'depth=0 after claim drained the queued row');
  });

  it('invariant #9: pending_messages.target_agent never contains a prefix colon for topic publish', async () => {
    seedTemplate(db, 'tG');
    seedTopic(db, 'tG');
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    await driver.publish({
      agentTemplate: 'tG',
      topicName: 'echo',
      payload: '{}',
      replyToAddr: 'someone',
    });
    await new Promise(r => setTimeout(r, 150));

    // Topic publish never writes a pending_messages row — the queue lives in
    // `topic_queue`. Even after publish, the table stays empty of prefixed
    // target_agent values.
    const offending = db.rawDb.prepare(
      `SELECT COUNT(*) AS n FROM pending_messages WHERE target_agent LIKE '%:%'`,
    ).get() as { n: number };
    assert.equal(offending.n, 0);
  });

  // ── Q6: monitor sidecar pairing ──────────────────────────────────────

  it('Q6: spawning a worker with topic.monitor_template also spawns the monitor with $TARGET_TMUX_SESSION set', async () => {
    seedTemplate(db, 'worker-q6');
    seedTemplate(db, 'mon-q6', { hookStart: 'echo monitor-started', hookPrepare: null, hookCleanup: 'echo monitor-cleanup' });
    seedTopic(db, 'worker-q6', { monitorTemplate: 'mon-q6' });
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    await driver.publish({ agentTemplate: 'worker-q6', topicName: 'echo', payload: '{}' });
    await new Promise((r) => setTimeout(r, 300));

    // Two create_session calls: one for the worker, one for the monitor.
    const createSessions = commands.filter((c) => c.action === 'create_session') as Array<Extract<ProxyCommand, { action: 'create_session' }>>;
    assert.equal(createSessions.length, 2, 'two create_session dispatches (worker + monitor)');
    const sessionNames = createSessions.map((c) => c.sessionName);
    const workerSession = sessionNames.find((n) => n.startsWith('inst-worker-q6-'));
    const monitorSession = sessionNames.find((n) => n.startsWith('inst-mon-q6-'));
    assert.ok(workerSession, 'worker create_session dispatched');
    assert.ok(monitorSession, 'monitor create_session dispatched');

    // The worker's create_session must come BEFORE the monitor's.
    const workerCreateIdx = commands.findIndex(
      (c) => c.action === 'create_session' && (c as Extract<ProxyCommand, { action: 'create_session' }>).sessionName === workerSession,
    );
    const monitorCreateIdx = commands.findIndex(
      (c) => c.action === 'create_session' && (c as Extract<ProxyCommand, { action: 'create_session' }>).sessionName === monitorSession,
    );
    assert.ok(workerCreateIdx < monitorCreateIdx, 'monitor create_session follows worker create_session');

    // Among the set-env execs dispatched AFTER the monitor's create_session,
    // one must set TARGET_TMUX_SESSION to the worker's tmux session.
    const targetEnvCmd = commands
      .slice(monitorCreateIdx)
      .find((c) => c.action === 'exec' && (c as Extract<ProxyCommand, { action: 'exec' }>).command.includes('TARGET_TMUX_SESSION')) as
      | Extract<ProxyCommand, { action: 'exec' }>
      | undefined;
    assert.ok(targetEnvCmd, 'a tmux set-environment exec for TARGET_TMUX_SESSION exists after monitor create_session');
    assert.ok(targetEnvCmd!.command.includes(`'${workerSession}'`) || targetEnvCmd!.command.includes(`"${workerSession}"`),
      `TARGET_TMUX_SESSION value is the worker tmux session (cmd: ${targetEnvCmd!.command})`);
  });

  it('Q6: monitor instance has monitor_of_instance set to the worker id', async () => {
    seedTemplate(db, 'worker-q6b');
    seedTemplate(db, 'mon-q6b', { hookStart: 'echo m', hookPrepare: null, hookCleanup: null });
    seedTopic(db, 'worker-q6b', { monitorTemplate: 'mon-q6b' });
    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    await driver.publish({ agentTemplate: 'worker-q6b', topicName: 'echo', payload: '{}' });
    await new Promise((r) => setTimeout(r, 300));

    const live = db.listLiveAgentInstances();
    const worker = live.find((r) => r.agentTemplate === 'worker-q6b');
    const monitor = live.find((r) => r.agentTemplate === 'mon-q6b');
    assert.ok(worker, 'worker row exists');
    assert.ok(monitor, 'monitor row exists');
    assert.equal(monitor!.monitorOfInstance, worker!.id, 'monitor.monitor_of_instance = worker.id');
    assert.equal(monitor!.spawnedFromTopic, null, 'monitor not spawned from a topic_queue');
    assert.equal(monitor!.queueId, null, 'monitor has no queue row');

    // findMonitorForWorker returns the monitor row.
    const found = db.findMonitorForWorker(worker!.id);
    assert.ok(found, 'findMonitorForWorker returns a row');
    assert.equal(found!.id, monitor!.id);
  });

  it('Q6: monitor template that itself declares monitor_template does NOT recurse', async () => {
    // Chain: worker.monitor_template = 'mon' AND mon.monitor_template = 'mon2'.
    // Cycle protection in claimAndSpawn must short-circuit the monitor's own
    // monitor declaration so we end up with EXACTLY ONE monitor row.
    seedTemplate(db, 'worker-q6c');
    seedTemplate(db, 'mon-q6c', { hookStart: 'echo m', hookPrepare: null, hookCleanup: null });
    seedTemplate(db, 'mon2-q6c', { hookStart: 'echo m2', hookPrepare: null, hookCleanup: null });
    seedTopic(db, 'worker-q6c', { monitorTemplate: 'mon-q6c' });
    // Give `mon-q6c` its own topics with a monitor_template pointing to mon2.
    // Topics on the monitor template are necessary so the spawn check can see
    // them — but since cycle protection happens at the WORKER spawn step
    // (only `monitorOfInstance === null` workers spawn monitors), this should
    // simply never read those topics during the monitor's own spawn.
    db.replaceTopicsForTemplate('mon-q6c', [{
      agentTemplate: 'mon-q6c',
      name: 'inner',
      hookPrepareOverride: null,
      hookStartOverride: null,
      hookCleanupOverride: null,
      monitorTemplate: 'mon2-q6c',
      concurrency: 1,
      schemaPath: null,
      replySchemaPath: null,
    }]);

    const driver = new TopicDelivery({
      db, proxyDispatch: dispatch, orchestratorHost: 'x', ipcRoot, locks: new LockManager(db.rawDb),
    });

    await driver.publish({ agentTemplate: 'worker-q6c', topicName: 'echo', payload: '{}' });
    await new Promise((r) => setTimeout(r, 300));

    // Exactly ONE monitor row — mon-q6c. NO mon2-q6c rows. Cycle protection
    // means a monitor never gets its own monitor sidecar spawned.
    const live = db.listLiveAgentInstances();
    const monitors = live.filter((r) => r.monitorOfInstance !== null);
    assert.equal(monitors.length, 1, `exactly one monitor row (got ${monitors.length}: ${monitors.map((m) => m.agentTemplate).join(',')})`);
    assert.equal(monitors[0]!.agentTemplate, 'mon-q6c');
    const mon2Rows = live.filter((r) => r.agentTemplate === 'mon2-q6c');
    assert.equal(mon2Rows.length, 0, 'no mon2-q6c rows created (cycle protection holds)');
  });
});
