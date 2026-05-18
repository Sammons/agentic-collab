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
    const claimOpts = (suffix: string) => ({
      agentTemplate: 'tA',
      topicName: 'echo',
      instanceId: `race-${suffix}`,
      instanceAddr: `agent:tA/race-${suffix}`,
      tmuxSession: `inst-tA-race-${suffix}`,
      proxyId: 'p1',
      messageId: `race-${suffix}`,
      messagePath: `/tmp/m-${suffix}`,
      replyPath: `/tmp/r-${suffix}`,
      statusPath: `/tmp/s-${suffix}`,
      worktreePath: null,
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
});
