/**
 * Pending-count badges for the sidebar nav (Approvals + Reminders).
 *
 * Counts are sourced from data the client already receives — no WS schema
 * change:
 *   - Baseline on every WS `init` (connect + reconnect) via REST, which also
 *     heals any drift from events missed while disconnected.
 *   - `ws:reminder_update` carries the full reminders list, so the reminders
 *     count is derived straight from the event payload (no refetch).
 *   - `ws:approval_changed` carries a single-approval delta only (it fires on
 *     create and on every state change), so we refetch
 *     /api/approvals?state=pending — the same refetch-on-event pattern
 *     approvals.ts uses for its master list.
 *
 * Emits `pending-counts-changed` (only when a count actually moves) so the
 * sidebar re-renders its badges.
 */
import type { Reminder } from '../shared/types.ts';
import { emit, on, authHeaders } from './state.ts';

/** Live pending counts the sidebar badges render from. */
export const pendingCounts = {
  approvals: 0,
  reminders: 0,
};

/** A reminder counts as pending ("firing") until it's marked done. */
export function countPendingReminders(rows: Reminder[]): number {
  return rows.filter((r) => r.status === 'pending').length;
}

/**
 * Extract the reminders list from a `ws:reminder_update` payload. The event
 * arrives as `unknown` through connection.ts's pass-through bus; returns
 * null when the shape is unexpected so the caller can fall back to a REST
 * refetch.
 */
export function remindersFromEvent(detail: unknown): Reminder[] | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const reminders = (detail as { reminders?: unknown }).reminders;
  if (!Array.isArray(reminders)) return null;
  // Shape is server-owned (broadcastReminderUpdate sends db.listReminders());
  // countPendingReminders's status filter tolerates any stray junk rows.
  return reminders as Reminder[];
}

function setCounts(approvals: number | null, reminders: number | null): void {
  let changed = false;
  if (approvals !== null && approvals !== pendingCounts.approvals) {
    pendingCounts.approvals = approvals;
    changed = true;
  }
  if (reminders !== null && reminders !== pendingCounts.reminders) {
    pendingCounts.reminders = reminders;
    changed = true;
  }
  if (changed) emit('pending-counts-changed');
}

async function refreshApprovals(): Promise<void> {
  try {
    const res = await fetch('/api/approvals?state=pending', { headers: authHeaders() });
    if (!res.ok) return; // 503 (approvals not configured) / auth hiccup — keep last-known count
    const rows = await res.json() as unknown[];
    if (!Array.isArray(rows)) return;
    setCounts(rows.length, null);
  } catch {
    // Network blip — keep the last-known count; the next init/event re-syncs.
  }
}

async function refreshReminders(): Promise<void> {
  try {
    const res = await fetch('/api/reminders', { headers: authHeaders() });
    if (!res.ok) return;
    const rows = await res.json() as Reminder[];
    if (!Array.isArray(rows)) return;
    setCounts(null, countPendingReminders(rows));
  } catch {
    // Network blip — keep the last-known count; the next init/event re-syncs.
  }
}

export function setupPendingCounts(): void {
  on('init', () => {
    void refreshApprovals();
    void refreshReminders();
  });
  on('ws:approval_changed', () => void refreshApprovals());
  on('ws:reminder_update', (detail) => {
    const rows = remindersFromEvent(detail);
    if (rows) setCounts(null, countPendingReminders(rows));
    else void refreshReminders();
  });
}
