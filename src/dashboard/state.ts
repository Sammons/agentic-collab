/**
 * v3 dashboard — single source of truth.
 *
 * Owns the data the surfaces render from: agents, teams, threads, messages,
 * sidebar selection set (which agents are "on" in the filter), connection
 * health, and the active route. Components subscribe to events via `on()`
 * and re-render when relevant state changes.
 *
 * This is intentionally a plain JS object with a pub/sub event bus — no
 * framework, no observable wrapper. Mirror the v2 `src/dashboard/state.ts`
 * pattern; we'll grow it as PR 2+ surfaces need more.
 */
import type {
  AgentRecord,
  DashboardMessage,
  Team,
} from '../shared/types.ts';

/** Where the user is in the app. */
export type Route =
  | { kind: 'dashboard' }
  | { kind: 'agents' }
  | { kind: 'watch'; agentName: string }
  | { kind: 'approvals' }
  | { kind: 'reminders' }
  | { kind: 'settings' }
  | { kind: 'edit-engine'; name: string }
  | { kind: 'search' };

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type DashboardState = {
  /** All agents known to the orchestrator. */
  agents: AgentRecord[];
  /** Teams as UI-only grouping. Empty array until init arrives. */
  teams: Team[];
  /** Threads keyed by agent name. v3 merges these for the chat view. */
  threads: Record<string, DashboardMessage[]>;
  /** Which agent names are currently "on" in the sidebar filter. */
  selectedAgents: Set<string>;
  /** WebSocket connection health. */
  connected: ConnectionStatus;
  /** Current route. */
  route: Route;
  /** Auth token for /api/* requests. */
  token: string | null;
};

export const state: DashboardState = {
  agents: [],
  teams: [],
  threads: {},
  selectedAgents: new Set<string>(),
  connected: 'connecting',
  route: { kind: 'dashboard' },
  token: null,
};

/* ── pub/sub event bus ─────────────────────────────────────────────── */

type Listener = (detail?: unknown) => void;
const listeners: Map<string, Set<Listener>> = new Map();

/** Subscribe to a state-change event. Returns an unsubscribe function. */
export function on(event: string, fn: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

/** Emit a state-change event. */
export function emit(event: string, detail?: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(detail); }
    catch (err) { console.error(`[state] listener for ${event} threw:`, err); }
  }
}

/* ── selection helpers ─────────────────────────────────────────────── */

const SELECTION_KEY = 'orchestrator_selection_v3';

/** Persist the current selection so reloads land on the same view. */
function persistSelection(): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...state.selectedAgents]));
  } catch {}
}

/** Toggle a single agent in the sidebar selection. */
export function toggleAgentSelected(name: string): void {
  if (state.selectedAgents.has(name)) state.selectedAgents.delete(name);
  else state.selectedAgents.add(name);
  persistSelection();
  emit('selection-changed');
}

/** Toggle every member of a team on/off based on the team's current state. */
export function toggleTeam(team: Team): void {
  const allSelected = team.members.every((m) => state.selectedAgents.has(m));
  if (allSelected) {
    for (const m of team.members) state.selectedAgents.delete(m);
  } else {
    for (const m of team.members) state.selectedAgents.add(m);
  }
  persistSelection();
  emit('selection-changed');
}

/** Master toggle: select all agents, or clear if any are selected. */
export function toggleAllAgents(): void {
  if (state.selectedAgents.size > 0) {
    state.selectedAgents.clear();
  } else {
    for (const a of state.agents) state.selectedAgents.add(a.name);
  }
  persistSelection();
  emit('selection-changed');
}

/**
 * Restore the user's last selection from localStorage (intersected with the
 * currently-known agents so we drop names that no longer exist). If nothing
 * was previously persisted we leave the selection empty — the user picks an
 * agent or team to view, mirroring v2's "one-selected-thread" feel and
 * keeping the merged-feed DOM tractable even with many agents.
 */
export function restoreSelectionOnInit(): void {
  let stored: string[] = [];
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw) stored = JSON.parse(raw) as string[];
  } catch {}
  const known = new Set(state.agents.map((a) => a.name));
  state.selectedAgents = new Set(stored.filter((n) => known.has(n)));
  emit('selection-changed');
}

/* ── token ─────────────────────────────────────────────────────────── */

const TOKEN_KEY = 'orchestrator_token_v3';

export function loadToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    state.token = t;
    return t;
  } catch {
    return null;
  }
}

export function saveToken(t: string | null): void {
  state.token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/** Headers for authenticated fetches. */
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (state.token) h['authorization'] = `Bearer ${state.token}`;
  return h;
}
