/**
 * RFC-006 Q1: session-safe stale-root reconciliation.
 *
 * A `persistent: false` persona becomes an `agent_templates` row (a stateless
 * "root"). But if the same name previously existed as a persistent agent, a
 * leftover `agents` row of that name shadows the template — the dashboard init
 * merge filters the template out (`main.ts`: `templateAgents.filter(t =>
 * !persistentNames.has(t.name))`), so the root mis-renders as a suspended agent.
 *
 * This reconciler removes that stale `agents` row for every ephemeral template,
 * SESSION-SAFELY: a `suspended` agent can still own a LIVE tmux session (suspend
 * preserves it for the Watch tab, `lifecycle.ts:818-828`), so we kill any live
 * session FIRST — never orphaning a pane — then delete the row and broadcast the
 * destroy so the dashboard drops the stale entry.
 *
 * It mirrors `destroyAgent` (`lifecycle.ts:856-892`) for the kill + delete +
 * `destroyed` event, but deliberately does NOT delete the persona file (the file
 * IS the template source — RFC-004) and does NOT run codex-profile cleanup.
 *
 * Idempotent: a no-op when no stale row exists, and safe to call repeatedly
 * (persona-watch is mtime-gated so this won't thrash). The `agent_destroyed`
 * broadcast is gated on `deleteAgent` actually removing a row, so a re-run for an
 * already-absent name never re-broadcasts a destroy.
 */

import type { Database } from './database.ts';
import type { AgentState, ProxyCommand, ProxyResponse } from '../shared/types.ts';

/**
 * Dormant states a stale row may be reconciled from. Fail-safe ALLOWLIST: if an
 * agent is in any live/transitional state (spawning/resuming/suspending/active/
 * idle) we never kill+delete it from a background poll — a persona flipped to
 * `persistent: false` while its agent is still running must be suspended/exited
 * by the operator first. A forgotten state here lingers harmlessly; it can never
 * destroy a live agent.
 */
const RECONCILABLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['void', 'suspended', 'failed']);

export type ReconcileRootsDeps = {
  db: Database;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  /** Broadcast the `agent_destroyed` event for `name` (gated on an actual delete). */
  broadcast: (name: string) => void;
};

/** Names of templates whose stale `agents` row was reconciled (deleted). */
export async function reconcileEphemeralRoots(deps: ReconcileRootsDeps): Promise<string[]> {
  const { db, proxyDispatch, broadcast } = deps;
  const reconciled: string[] = [];

  // `listTemplatesAsAgentRecords()` already returns ONLY persistent=false
  // templates, mapped to AgentRecord with isTemplate:true. `.name` is the
  // template id.
  for (const template of db.listTemplatesAsAgentRecords()) {
    const name = template.name;
    const agent = db.getAgent(name);
    if (!agent) continue; // no shadowing row — nothing to reconcile.

    // Lifecycle safety: only reconcile a DORMANT stale row. If the persona was
    // flipped to ephemeral while its agent is still live/transitional, do NOT
    // kill its session + delete it from a background poll — leave it for the
    // operator to suspend/exit first.
    if (!RECONCILABLE_STATES.has(agent.state)) {
      console.warn(`[reconcile-roots] persona "${name}" is ephemeral but its agent is "${agent.state}" (live) — not reconciling; suspend/exit it first.`);
      continue;
    }

    // BEST-EFFORT kill any live tmux session FIRST so we never orphan a pane.
    // A suspended agent can still own a live session (suspend preserves it).
    if (agent.proxyId && agent.tmuxSession) {
      await proxyDispatch(agent.proxyId, {
        action: 'kill_session',
        sessionName: agent.tmuxSession,
      }).catch((err) => {
        console.warn(`[reconcile-roots] kill_session for ${name} failed: ${(err as Error).message}`);
      });
    }

    const deleted = db.deleteAgent(name);
    // GATE the destroy event on an actual delete — otherwise every persona-watch
    // poll would re-broadcast a destroy for an already-absent name.
    if (deleted) {
      db.logEvent(name, 'destroyed');
      broadcast(name);
      reconciled.push(name);
      console.log(`[reconcile-roots] Removed stale agents row shadowing ephemeral template "${name}"`);
    }
  }

  return reconciled;
}
