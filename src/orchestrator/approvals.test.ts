import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { ApprovalService } from './approvals.ts';
import type { ProxyCommand, ProxyResponse, WsApprovalChangedEvent, AgentState } from '../shared/types.ts';

/**
 * Q5 — approvals CRUD + auto-notify.
 *
 * Covers the matrix from the spec:
 *   - CRUD round-trip (create → get → set → withdraw blocked on terminal)
 *   - Withdraw allowed only by the original creator while pending
 *   - State change emits `approval_changed` WS event AND auto-notifies the
 *     requester via the message dispatcher (we capture both)
 *   - `await(id)` returns at terminal state, including pending timeout
 *   - Channel name must match NAME_RE
 *   - Auto-notify routes by address class (agent / others)
 */
describe('ApprovalService (Q5)', () => {
  let db: Database;
  let tmpDir: string;
  let events: WsApprovalChangedEvent[];
  let proxyCommands: ProxyCommand[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'approvals-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    events = [];
    proxyCommands = [];
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

  function makeService(): { svc: ApprovalService; dispatcher: MessageDispatcher } {
    const dispatcher = new MessageDispatcher({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_id, command) => {
        proxyCommands.push(command);
        return { ok: true, data: '' } as ProxyResponse;
      },
      orchestratorHost: 'http://localhost:3000',
    });
    const svc = new ApprovalService({
      db,
      messageDispatcher: dispatcher,
      onEvent: (e) => events.push(e),
    });
    return { svc, dispatcher };
  }

  it('CRUD round-trip: create → get → set → get reflects new state → withdraw fails (already terminal)', async () => {
    const { svc } = makeService();
    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'aws-account-provision',
      payload: '{"account":"123"}',
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('unreachable');
    const id = created.approval.id;
    assert.equal(created.approval.state, 'pending');

    const fetched = db.getApproval(id)!;
    assert.equal(fetched.payload, '{"account":"123"}');
    assert.equal(fetched.requesterAddr, 'agent:foo');

    const updated = await svc.setState(id, 'approved', { decidedBy: 'human' });
    assert.equal(updated.ok, true);
    if (!updated.ok) throw new Error('unreachable');
    assert.equal(updated.approval.state, 'approved');
    assert.equal(updated.approval.decidedBy, 'human');
    assert.ok(updated.approval.decidedAt);

    const after = db.getApproval(id)!;
    assert.equal(after.state, 'approved');

    // Withdraw on a terminal row → not-pending.
    const wd = await svc.withdraw(id, 'agent:foo');
    assert.equal(wd.ok, false);
    if (wd.ok) throw new Error('unreachable');
    assert.equal(wd.reason, 'not-pending');
  });

  it('Withdraw allowed only by the creator while pending', async () => {
    const { svc } = makeService();
    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'test-channel',
      payload: '{}',
    });
    if (!created.ok) throw new Error('expected create ok');
    const id = created.approval.id;

    // Non-creator → 403-equivalent.
    const denied = await svc.withdraw(id, 'agent:bar');
    assert.equal(denied.ok, false);
    if (denied.ok) throw new Error('unreachable');
    assert.equal(denied.reason, 'not-creator');

    // Original creator → success.
    const ok = await svc.withdraw(id, 'agent:foo');
    assert.equal(ok.ok, true);
    if (!ok.ok) throw new Error('unreachable');
    assert.equal(ok.approval.state, 'withdrawn');
  });

  it('State change emits `approval_changed` WS event AND auto-notifies the requester (persistent agent)', async () => {
    // We need to spy on tryDeliver to assert it was called with the BARE
    // agent name ('foo'), NOT the prefixed form ('agent:foo'). Build the
    // dispatcher manually so we can wrap the method.
    const dispatcher = new MessageDispatcher({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_id, command) => {
        proxyCommands.push(command);
        return { ok: true, data: '' } as ProxyResponse;
      },
      orchestratorHost: 'http://localhost:3000',
    });
    const tryDeliverCalls: string[] = [];
    const originalTryDeliver = dispatcher.tryDeliver.bind(dispatcher);
    dispatcher.tryDeliver = async (agentName: string) => {
      tryDeliverCalls.push(agentName);
      return originalTryDeliver(agentName);
    };
    const svc = new ApprovalService({
      db,
      messageDispatcher: dispatcher,
      onEvent: (e) => events.push(e),
    });

    // Persistent agent target so notify takes the enqueueMessage path.
    db.createAgent({ name: 'foo', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('foo', 'active');

    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'reviews',
      payload: '{"diff":"..."}',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.approval.id;
    // Event #1 — created.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'approval_changed');
    assert.equal(events[0]!.approvalId, id);
    assert.equal(events[0]!.state, 'pending');

    // Snapshot the pending_messages queue BEFORE the dispatcher drains it,
    // so we can assert the row landed there with the bare target_agent
    // ('foo') and not the prefixed form ('agent:foo'). The notify path
    // enqueues synchronously inside setState; the paste itself fires async.
    const updated = await svc.setState(id, 'rejected', { decidedBy: 'human' });
    assert.equal(updated.ok, true);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.state, 'rejected');

    // The dispatcher may have started draining; wait for it to finish so we
    // observe both invariants stably.
    await new Promise((r) => setTimeout(r, 100));

    // Invariant 1 — tryDeliver was called with the BARE name. This is the
    // contract pending_messages.target_agent is stored against.
    assert.ok(
      tryDeliverCalls.includes('foo'),
      `expected tryDeliver('foo'); calls=${JSON.stringify(tryDeliverCalls)}`,
    );
    assert.ok(
      !tryDeliverCalls.includes('agent:foo'),
      `tryDeliver must receive bare names; calls=${JSON.stringify(tryDeliverCalls)}`,
    );

    // Invariant 2 — at least one paste reached the right tmux session,
    // proving the dispatcher resolved the bare name and pasted the body.
    const pastes = proxyCommands.filter(c => c.action === 'paste') as Array<{ action: 'paste'; sessionName: string; text: string }>;
    const matching = pastes.find(p => p.text.includes(`Approval ${id} REJECTED (terminal`));
    assert.ok(matching, `expected a paste containing the notice for ${id}; pastes=${JSON.stringify(pastes)}`);
    assert.equal(matching!.sessionName, 'agent-foo');
  });

  it('Auto-notify enqueues into pending_messages with the BARE target_agent (no `agent:` prefix)', () => {
    // Direct DB-level invariant — separate from the delivery test so a
    // dispatcher-side regression can't mask a storage-side regression.
    const svc = new ApprovalService({
      db,
      messageDispatcher: new MessageDispatcher({
        db,
        locks: new LockManager(db.rawDb),
        // Drop pastes so the row stays in pending_messages for inspection.
        proxyDispatch: async () => ({ ok: false, error: 'paste-disabled' } as ProxyResponse),
        orchestratorHost: 'http://localhost:3000',
      }),
      onEvent: (e) => events.push(e),
    });
    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'queue-target',
      payload: '{}',
    });
    if (!created.ok) throw new Error('create failed');
    // Setting state enqueues the notice synchronously (the paste is async).
    void svc.setState(created.approval.id, 'approved');
    const queue = db.getDeliverableMessages('foo');
    assert.ok(queue.length >= 1, `expected an enqueued row for 'foo'; queue=${JSON.stringify(queue)}`);
    assert.equal(queue[0]!.targetAgent, 'foo');
    assert.notEqual(queue[0]!.targetAgent, 'agent:foo');
    // No bleed-through into the prefixed bucket.
    assert.equal(db.getDeliverableMessages('agent:foo').length, 0);
  });

  it('setState enqueues exactly ONE auto-notify queue row for the requester (dedup regression)', async () => {
    // Live incident 2026-06-12 (queue ids 315-318): the requester received
    // the decision 2-3 times. The server-side invariant is one queue row per
    // state change — counted on the raw table so retry/backoff bookkeeping
    // cannot hide a duplicate from us.
    const { svc, dispatcher } = makeService();
    // No 'foo' agent row exists, so the dispatcher cannot deliver — the row
    // stays queued for counting.
    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'dedup-single',
      payload: '{}',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.approval.id;

    const updated = await svc.setState(id, 'approved', { decidedBy: 'human' });
    assert.equal(updated.ok, true);
    // Let the fire-and-forget tryDeliver settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const countQueueRows = () => {
      const row = db.rawDb
        .prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE target_agent = 'foo'")
        .get() as { count: number };
      return row.count;
    };
    const countThreadRows = () => {
      const row = db.rawDb
        .prepare("SELECT COUNT(*) AS count FROM dashboard_messages WHERE agent = 'foo'")
        .get() as { count: number };
      return row.count;
    };
    assert.equal(countQueueRows(), 1);
    assert.equal(countThreadRows(), 1);

    // A repeat decision on the same id is rejected and must not enqueue.
    const repeat = await svc.setState(id, 'rejected');
    assert.equal(repeat.ok, false);
    if (repeat.ok) throw new Error('unreachable');
    assert.equal(repeat.reason, 'already-terminal');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(countQueueRows(), 1);
    assert.equal(countThreadRows(), 1);
    dispatcher.stop();
  });

  it('amend then terminal: exactly one auto-notify per state change (amended IS terminal)', async () => {
    const { svc, dispatcher } = makeService();
    const queueRows = () => db.rawDb
      .prepare("SELECT envelope FROM pending_messages WHERE target_agent = 'foo' ORDER BY id ASC")
      .all() as Array<{ envelope: string }>;

    // First approval amended → one row, worded as the terminal amend notice.
    const amendable = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'dedup-amend',
      payload: '{"v":1}',
    });
    if (!amendable.ok) throw new Error('create failed');
    const amended = await svc.setState(amendable.approval.id, 'amended', { payload: '{"v":2}' });
    assert.equal(amended.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(queueRows().length, 1);
    assert.ok(queueRows()[0]!.envelope.includes('APPROVED WITH AMENDMENTS'));

    // amended is terminal — a follow-up approve is rejected and enqueues nothing.
    const followUp = await svc.setState(amendable.approval.id, 'approved');
    assert.equal(followUp.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(queueRows().length, 1);

    // An independent approval approved → exactly one more row.
    const second = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'dedup-amend',
      payload: '{}',
    });
    if (!second.ok) throw new Error('create failed');
    const approvedSecond = await svc.setState(second.approval.id, 'approved');
    assert.equal(approvedSecond.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = queueRows();
    assert.equal(rows.length, 2);
    assert.ok(rows[1]!.envelope.includes(`Approval ${second.approval.id} APPROVED (terminal`));
    dispatcher.stop();
  });

  it('await() returns at terminal state', async () => {
    const { svc } = makeService();
    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'fast',
      payload: '{}',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.approval.id;

    // Flip to terminal after 100ms; await should resolve once it sees it.
    setTimeout(() => {
      svc.setState(id, 'approved').catch(() => {});
    }, 100);
    const row = await svc.await(id, { pollIntervalMs: 25, timeoutMs: 2000 });
    assert.ok(row);
    assert.equal(row!.state, 'approved');
  });

  it('await() returns the pending row if the timeout elapses without termination', async () => {
    const { svc } = makeService();
    const created = svc.create({
      requesterAddr: 'agent:foo',
      channel: 'slow',
      payload: '{}',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.approval.id;

    const row = await svc.await(id, { pollIntervalMs: 25, timeoutMs: 100 });
    assert.ok(row);
    assert.equal(row!.state, 'pending');
  });

  it('Channel name must match NAME_RE — invalid channels rejected at create', () => {
    const { svc } = makeService();
    const cases = [
      '', 'has space', 'has/slash', '_leading-underscore', '-leading-dash',
      'too-long-' + 'x'.repeat(100),
    ];
    for (const channel of cases) {
      const out = svc.create({ requesterAddr: 'agent:foo', channel, payload: '{}' });
      assert.equal(out.ok, false, `expected channel ${JSON.stringify(channel)} to be rejected`);
      if (out.ok) throw new Error('unreachable');
      assert.equal(out.reason, 'invalid-channel');
    }

    // Valid: alnum start, hyphens, underscores, ≤63.
    const ok = svc.create({ requesterAddr: 'agent:foo', channel: 'aws-account-provision_v2', payload: '{}' });
    assert.equal(ok.ok, true);
  });

  it('Requester address must parse — malformed rejected at create with reason `invalid-requester`', () => {
    const { svc } = makeService();
    const cases = ['has space', 'unknown:foo', 'agent:'];
    for (const addr of cases) {
      const out = svc.create({ requesterAddr: addr, channel: 'c', payload: '{}' });
      assert.equal(out.ok, false, `expected requesterAddr ${JSON.stringify(addr)} to be rejected`);
      if (out.ok) throw new Error('unreachable');
      // Strong: pin the reason so a resolver regression that returned
      // `invalid-channel` here would be caught immediately.
      assert.strictEqual(out.reason, 'invalid-requester', `addr=${JSON.stringify(addr)} reason=${out.reason}`);
    }
  });

  it('setState on unknown id returns not-found', async () => {
    const { svc } = makeService();
    const out = await svc.setState('nope-no-such-id', 'approved');
    assert.equal(out.ok, false);
    if (out.ok) throw new Error('unreachable');
    assert.equal(out.reason, 'not-found');
  });

  it('amended state pushes prior payload into amendments_json', async () => {
    const { svc } = makeService();
    const created = svc.create({
      requesterAddr: 'agent:foo', channel: 'reviews', payload: '{"v":1}',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.approval.id;
    const updated = await svc.setState(id, 'amended', { payload: '{"v":2}' });
    assert.equal(updated.ok, true);
    if (!updated.ok) throw new Error('unreachable');
    assert.equal(updated.approval.payload, '{"v":2}');
    const amendments = JSON.parse(updated.approval.amendmentsJson!);
    assert.ok(Array.isArray(amendments));
    assert.equal(amendments.length, 1);
    assert.equal(amendments[0].payload, '{"v":1}');
  });

  it('recordApprovalEvent is invoked on create/state-change/withdraw (audit trail)', async () => {
    const { svc } = makeService();
    const created = svc.create({
      requesterAddr: 'agent:foo', channel: 'audit', payload: '{}',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.approval.id;
    await svc.setState(id, 'approved');

    const events = db.listApprovalEvents(id);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.eventType, 'created');
    assert.equal(events[1]!.eventType, 'state-changed');

    // Withdraw on a now-terminal row does not record (it returns not-pending).
    const wd = await svc.withdraw(id, 'agent:foo');
    assert.equal(wd.ok, false);
    const eventsAfter = db.listApprovalEvents(id);
    assert.equal(eventsAfter.length, 2);

    // Now do a fresh approval and exercise the withdraw audit row.
    const c2 = svc.create({ requesterAddr: 'agent:foo', channel: 'audit', payload: '{}' });
    if (!c2.ok) throw new Error('create failed');
    await svc.withdraw(c2.approval.id, 'agent:foo');
    const evts2 = db.listApprovalEvents(c2.approval.id);
    assert.equal(evts2.length, 2);
    assert.equal(evts2[1]!.eventType, 'withdrawn');
  });
});
