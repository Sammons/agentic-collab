/**
 * Approvals — v3 Q5.
 *
 * Approvals are first-class CRUD resources categorised by `channel`
 * (`approval:<channel>`). They are *not* a message-routing surface — the
 * channel is a label, not a queue that spawns workers (that's the topic
 * primitive). On state change the orchestrator:
 *
 *   1. Records the transition in `approval_events` (durable audit trail).
 *   2. Broadcasts a `approval_changed` WS event (Q4-typed; subscribers in Q9).
 *   3. Auto-notifies the requesting agent's address with a one-line message
 *      that points the agent at `collab approval get <id>` for details.
 *
 * Auto-notification rides the existing message dispatcher:
 *   - bare-agent / `agent:` addresses → persistent enqueueMessage + tryDeliver
 *   - `agent:<template>/<instance-id>` → deliverToInstance (sync-or-drop)
 *   - anything else (topic:/approval:/malformed) → log and skip
 *
 * Polling `await(id)` is plain polling per the spec ("not long-poll"); the
 * caller decides the interval.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { ApprovalRow, ApprovalState, DashboardMessage, WsApprovalChangedEvent } from '../shared/types.ts';
import { parseAddress, NAME_RE } from '../shared/address.ts';

export type ApprovalServiceOptions = {
  db: Database;
  messageDispatcher: MessageDispatcher;
  /** WS sink — receives `WsApprovalChangedEvent` shapes for broadcast. */
  onEvent?: (event: WsApprovalChangedEvent) => void;
  /**
   * Optional WS sink for the dashboard-visible side of auto-notify. The
   * service writes a `dashboard_messages` row in the requester agent's
   * thread (so the chat surface shows the state change) and calls this
   * once with the created row. Wire to `wss.broadcast({ type: 'message',
   * msg })` in production.
   */
  onMessage?: (msg: DashboardMessage) => void;
};

/** Concise outcome surfaces so routes/CLI can map cleanly to HTTP codes. */
export type CreateOutcome =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; reason: 'invalid-channel' | 'invalid-requester' | 'invalid-payload' };

export type SetStateOutcome =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; reason: 'not-found' | 'already-terminal' | 'invalid-state' };

export type WithdrawOutcome =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; reason: 'not-found' | 'not-pending' | 'not-creator' };

/**
 * Public API surface for routes, CLI, and tests. Stateless apart from the
 * injected dependencies — the DB owns the actual rows.
 */
export class ApprovalService {
  private readonly db: Database;
  private readonly messageDispatcher: MessageDispatcher;
  private readonly onEvent: (event: WsApprovalChangedEvent) => void;
  private readonly onMessage: (msg: DashboardMessage) => void;

  constructor(opts: ApprovalServiceOptions) {
    this.db = opts.db;
    this.messageDispatcher = opts.messageDispatcher;
    this.onEvent = opts.onEvent ?? (() => {});
    this.onMessage = opts.onMessage ?? (() => {});
  }

  /**
   * Create a new pending approval. `requesterAddr` is validated through the
   * address parser to ensure the auto-notify path has a routable target.
   * Channel must match `CHANNEL_NAME_RE` so dashboards can rely on a stable
   * shape and we avoid collisions with topic / agent names.
   */
  create(opts: {
    requesterAddr: string;
    channel: string;
    payload: string;
  }): CreateOutcome {
    if (typeof opts.channel !== 'string' || !NAME_RE.test(opts.channel)) {
      return { ok: false, reason: 'invalid-channel' };
    }
    if (typeof opts.requesterAddr !== 'string' || opts.requesterAddr.length === 0) {
      return { ok: false, reason: 'invalid-requester' };
    }
    const parsed = parseAddress(opts.requesterAddr);
    if (parsed.class === 'malformed') {
      return { ok: false, reason: 'invalid-requester' };
    }
    if (typeof opts.payload !== 'string') {
      return { ok: false, reason: 'invalid-payload' };
    }

    const id = randomUUID();
    const row = this.db.createApproval({
      id,
      requesterAddr: opts.requesterAddr,
      channel: opts.channel,
      payload: opts.payload,
    });
    this.db.recordApprovalEvent(id, 'created', opts.payload);
    this.emit(row);
    return { ok: true, approval: row };
  }

  /**
   * Transition a pending approval to a terminal non-withdrawn state.
   * Auto-notifies the requester after the state change commits.
   */
  async setState(
    id: string,
    state: 'approved' | 'rejected' | 'amended',
    opts: { decidedBy?: string | null; payload?: string | null } = {},
  ): Promise<SetStateOutcome> {
    if (state !== 'approved' && state !== 'rejected' && state !== 'amended') {
      return { ok: false, reason: 'invalid-state' };
    }
    const existing = this.db.getApproval(id);
    if (!existing) return { ok: false, reason: 'not-found' };
    if (existing.state !== 'pending') return { ok: false, reason: 'already-terminal' };

    // The audit event is written INSIDE the same DB transaction as the row
    // update — see `setApprovalState` in database.ts. This guarantees state
    // and audit-trail stay consistent even if the event insert throws.
    // We must encode the event payload ahead of time because the txn does
    // not have access to the updated row yet.
    const eventPayload = JSON.stringify({
      state,
      decidedBy: opts.decidedBy ?? null,
    });
    const updated = this.db.setApprovalState(id, state, {
      decidedBy: opts.decidedBy ?? null,
      payload: opts.payload ?? null,
      event: { eventType: 'state-changed', payload: eventPayload },
    });
    if (!updated) {
      // The atomic DB layer races against a concurrent setState; treat as terminal.
      return { ok: false, reason: 'already-terminal' };
    }
    this.emit(updated);
    // Fire-and-forget — auto-notify must not block the HTTP response.
    void this.notifyRequester(updated);
    return { ok: true, approval: updated };
  }

  /**
   * Withdraw a pending approval — creator-only. Maps DB outcome to a
   * route-friendly result so 403 vs 409 vs 404 can be distinguished.
   */
  async withdraw(id: string, requesterAddr: string): Promise<WithdrawOutcome> {
    const outcome = this.db.withdrawApproval(id, requesterAddr);
    if (outcome === 'not-found') return { ok: false, reason: 'not-found' };
    if (outcome === 'not-pending') return { ok: false, reason: 'not-pending' };
    if (outcome === 'not-creator') return { ok: false, reason: 'not-creator' };
    const updated = this.db.getApproval(id);
    if (!updated) return { ok: false, reason: 'not-found' };
    this.db.recordApprovalEvent(id, 'withdrawn', null);
    this.emit(updated);
    void this.notifyRequester(updated);
    return { ok: true, approval: updated };
  }

  /**
   * Poll the row until it leaves `pending`, then return. Returns the latest
   * row read once `pendingDeadlineMs` elapses without termination — the
   * caller (long-poll route) decides whether to re-poll or surface as-is.
   *
   * Plain polling per the spec: no long-poll, no websockets in this path.
   */
  async await(id: string, opts: { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<ApprovalRow | null> {
    const interval = opts.pollIntervalMs ?? 500;
    const timeout = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const row = this.db.getApproval(id);
      if (!row) return null;
      if (row.state !== 'pending') return row;
      if (Date.now() >= deadline) return row;
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    }
  }

  private emit(row: ApprovalRow): void {
    const event: WsApprovalChangedEvent = {
      type: 'approval_changed',
      approvalId: row.id,
      state: row.state,
      channel: row.channel,
    };
    try {
      this.onEvent(event);
    } catch (err) {
      console.warn(`[approvals] WS emit failed for ${row.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-notify the requester. Routes by address class:
   *   - agent (bare or `agent:<name>`) → persistent enqueue + tryDeliver
   *   - agent-instance → deliverToInstance (sync-or-drop, never persisted)
   *   - topic / approval / malformed → log + skip
   */
  private async notifyRequester(row: ApprovalRow): Promise<void> {
    const addr = parseAddress(row.requesterAddr);
    const envelope = approvalEnvelope(row);
    if (addr.class === 'agent') {
      try {
        this.db.enqueueMessage({
          sourceAgent: null,
          targetAgent: addr.name,
          envelope,
        });
        // Fire-and-forget — the dispatcher manages retries on its own.
        this.messageDispatcher.tryDeliver(addr.name).catch(() => { /* swallowed */ });
        // Also surface the notification in the dashboard chat thread so
        // the operator sees it live, regardless of whether the agent is
        // currently running. The enqueue path above paste-delivers to
        // tmux; this writes the same envelope to dashboard_messages.
        // No dupe — the dispatcher's success path doesn't add dashboard
        // rows (only its failure auto-reply does).
        try {
          const msg = this.db.addDashboardMessage(addr.name, 'from_agent', envelope, {
            topic: 'approval',
            sourceAgent: 'system',
            targetAgent: addr.name,
          });
          this.onMessage(msg);
        } catch (err) {
          console.warn(`[approvals] dashboard-message failed for ${row.id}: ${(err as Error).message}`);
        }
      } catch (err) {
        console.warn(`[approvals] notify enqueue failed for ${row.id}: ${(err as Error).message}`);
      }
      return;
    }
    if (addr.class === 'agent-instance') {
      try {
        const result = await this.messageDispatcher.deliverToInstance(addr.instanceId, envelope);
        if (!result.ok) {
          console.warn(`[approvals] notify deliverToInstance dropped (${result.reason}) for ${row.id}`);
        }
      } catch (err) {
        console.warn(`[approvals] notify deliverToInstance threw for ${row.id}: ${(err as Error).message}`);
      }
      return;
    }
    // topic / approval / malformed — not a deliverable target.
    console.warn(`[approvals] notify skipped for ${row.id}: requester "${row.requesterAddr}" is not a deliverable address class (${addr.class})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the auto-notify envelope. Each terminal state has explicit
 * "(terminal)" wording so agents don't misread `amended` as still-pending
 * waiting for an approve/reject decision — amended IS the decision (approved
 * with payload changes). Withdrawn is the requester's own cancellation.
 */
function approvalEnvelope(row: ApprovalRow): string {
  const base = `Approval ${row.id}`;
  const cli = `Run \`collab approval get ${row.id}\` for details.`;
  switch (row.state) {
    case 'pending':
      return `${base} created (awaiting decision). ${cli}`;
    case 'approved':
      return `${base} APPROVED (terminal — no further state changes). ${cli}`;
    case 'rejected':
      return `${base} REJECTED (terminal — no further state changes). ${cli}`;
    case 'amended':
      return `${base} APPROVED WITH AMENDMENTS (terminal — payload was modified by the reviewer; use the new payload, do not wait for a separate approval). ${cli}`;
    case 'withdrawn':
      return `${base} WITHDRAWN by requester (terminal — no action needed). ${cli}`;
    default:
      return `${base} state changed to ${row.state}. ${cli}`;
  }
}
