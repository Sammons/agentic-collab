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
  | { kind: 'persona'; name: string }
  | { kind: 'search' };

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type DashboardState = {
  /** All agents known to the orchestrator. */
  agents: AgentRecord[];
  /** Teams as UI-only grouping. Empty array until init arrives. */
  teams: Team[];
  /** Threads keyed by agent name. v3 merges these for the chat view. */
  threads: Record<string, DashboardMessage[]>;
  /** O(1) lookup for message dedup — avoids O(n) scans on every WS message. */
  seenMessageIds: Set<number>;
  /** Which agent names are currently "on" in the sidebar filter. */
  selectedAgents: Set<string>;
  /** WebSocket connection health. */
  connected: ConnectionStatus;
  /** Current route. */
  route: Route;
  /** Auth token for /api/* requests. */
  token: string | null;
  /** Pending composer text to inject on next chat mount (cross-route injection). */
  pendingComposerText: string | null;
  /** Unsent composer text, preserved across navigation so chat drafts survive
   *  leaving and returning to the dashboard. Cleared implicitly after send
   *  (the post-send input value re-saves it as the channel prefix). */
  composerDraft: string | null;
};

export const state: DashboardState = {
  agents: [],
  teams: [],
  threads: {},
  seenMessageIds: new Set<number>(),
  selectedAgents: new Set<string>(),
  connected: 'connecting',
  route: { kind: 'dashboard' },
  token: null,
  pendingComposerText: null,
  composerDraft: null,
};

/** O(1) agent lookup by name. Rebuilt on init/agents_update/agent_destroyed. */
export const agentsByName = new Map<string, AgentRecord>();

/** O(1) team membership lookup. Maps agent name → array of teams containing that agent. */
export const teamsByAgent = new Map<string, Team[]>();

/** Rebuild the agentsByName index from the current agents array. */
export function rebuildAgentIndex(): void {
  agentsByName.clear();
  for (const a of state.agents) {
    agentsByName.set(a.name, a);
  }
}

/** Rebuild the teamsByAgent index from the current teams array. */
export function rebuildTeamIndex(): void {
  teamsByAgent.clear();
  for (const team of state.teams) {
    for (const member of team.members) {
      const existing = teamsByAgent.get(member);
      if (existing) existing.push(team);
      else teamsByAgent.set(member, [team]);
    }
  }
}

/* ── threads cache (ETag-style delta init) ─────────────────────────── */

const THREADS_CACHE_KEY = 'orchestrator_threads_v3';
const THREADS_WATERMARK_KEY = 'orchestrator_threads_max_id_v3';
const CACHE_PER_AGENT_CAP = 200;

/**
 * Best-effort restore of cached threads + max-seen message id from
 * localStorage so the chat can render immediately on cold reload and the
 * server can return just the deltas since `sinceMessageId`. On any
 * read/parse error we silently fall back to an empty cache.
 */
export function loadCachedThreads(): { threads: Record<string, DashboardMessage[]>; sinceMessageId: number } {
  try {
    const raw = localStorage.getItem(THREADS_CACHE_KEY);
    const wm = parseInt(localStorage.getItem(THREADS_WATERMARK_KEY) ?? '0', 10) || 0;
    if (!raw) return { threads: {}, sinceMessageId: 0 };
    const parsed = JSON.parse(raw) as Record<string, DashboardMessage[]>;
    return { threads: parsed, sinceMessageId: wm };
  } catch {
    return { threads: {}, sinceMessageId: 0 };
  }
}

/**
 * Persist threads + watermark to localStorage. We cap each agent's thread
 * to the most recent CACHE_PER_AGENT_CAP entries so the serialized blob
 * stays under the ~5 MB localStorage quota even with many agents. On
 * QuotaExceededError we drop the cache rather than throw.
 */
export function persistCachedThreads(): void {
  try {
    const capped: Record<string, DashboardMessage[]> = {};
    let maxId = 0;
    for (const [agent, msgs] of Object.entries(state.threads)) {
      const positive = msgs.filter((m) => m.id > 0);
      capped[agent] = positive.slice(-CACHE_PER_AGENT_CAP);
      for (const m of capped[agent]!) if (m.id > maxId) maxId = m.id;
    }
    localStorage.setItem(THREADS_CACHE_KEY, JSON.stringify(capped));
    localStorage.setItem(THREADS_WATERMARK_KEY, String(maxId));
  } catch {
    // Quota exceeded or storage unavailable — clear so we don't carry a
    // partially-written blob.
    try {
      localStorage.removeItem(THREADS_CACHE_KEY);
      localStorage.removeItem(THREADS_WATERMARK_KEY);
    } catch {}
  }
}

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

/* ── Focus mode ────────────────────────────────────────────────────── */

/** Stores the selection before focus mode was entered, so we can revert. */
let preFocusSelection: Set<string> | null = null;

/** Returns true if focus mode is currently active. */
export function isFocusMode(): boolean {
  return preFocusSelection !== null;
}

/** Enter focus mode: save current selection, then switch to only the given agents. */
export function enterFocusMode(agents: string[]): void {
  if (preFocusSelection !== null) return; // already focused
  preFocusSelection = new Set(state.selectedAgents);
  state.selectedAgents = new Set(agents);
  emit('selection-changed');
}

/** Exit focus mode: restore the pre-focus selection. */
export function exitFocusMode(): void {
  if (preFocusSelection === null) return; // not focused
  state.selectedAgents = preFocusSelection;
  preFocusSelection = null;
  persistSelection();
  emit('selection-changed');
}

/** Toggle focus mode for the given agents. */
export function toggleFocusMode(agents: string[]): void {
  if (preFocusSelection !== null) {
    exitFocusMode();
  } else {
    enterFocusMode(agents);
  }
}

/** Update focus targets while staying in focus mode. */
export function updateFocusTargets(agents: string[]): void {
  if (preFocusSelection === null) return; // not in focus mode
  // Only emit if the set actually changed — avoids re-render spam on every keystroke
  const newSet = new Set(agents);
  if (newSet.size === state.selectedAgents.size &&
      agents.every(a => state.selectedAgents.has(a))) {
    return; // no change
  }
  state.selectedAgents = newSet;
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
  let raw: string | null = null;
  try { raw = localStorage.getItem(SELECTION_KEY); } catch {}
  const known = state.agents.map((a) => a.name);
  if (raw === null) {
    // Cold load — nothing was ever persisted. Default to ALL agents so the feed
    // shows everything instead of the empty "check an agent" state. An EXPLICIT
    // empty selection persists as "[]" (not null) and is respected by the else.
    state.selectedAgents = new Set(known);
  } else {
    let stored: unknown;
    try { stored = JSON.parse(raw); } catch {}
    const list = Array.isArray(stored) ? (stored as string[]) : [];
    const knownSet = new Set(known);
    state.selectedAgents = new Set(list.filter((n) => knownSet.has(n)));
  }
  emit('selection-changed');
}

/**
 * Boot-time selection restore, BEFORE the WS connects. The chat feed fetches
 * messages filtered by `selectedAgents`; if selection were only restored on the
 * WS `init` (restoreSelectionOnInit), a slow/failed socket leaves the feed blank
 * on reload. Restoring at boot lets the initial feed load over REST immediately,
 * independent of the socket. We can't intersect with known agents yet
 * (`state.agents` is empty until init), so we restore the raw stored names — the
 * feed fetch tolerates unknown names and restoreSelectionOnInit re-filters once
 * the agent list arrives. No `selection-changed` emit: the initial render reads
 * `selectedAgents` directly.
 *
 * Cold load (nothing persisted): default to the cached thread agents as the
 * boot-time "all" proxy, so a returning all-agents user doesn't flash the empty
 * feed; restoreSelectionOnInit then re-defaults to the authoritative full agent
 * list once the WS init arrives. An EXPLICIT empty selection ("[]") is respected.
 */
export function restoreSelectionAtBoot(): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(SELECTION_KEY); } catch {}
  if (raw === null) {
    state.selectedAgents = new Set(Object.keys(state.threads));
  } else {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) state.selectedAgents = new Set(v as string[]);
    } catch {}
  }
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
