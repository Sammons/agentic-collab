/**
 * v3 WebSocket connection.
 *
 * Connects to the orchestrator WS, applies incoming events to `state`, and
 * emits high-level events for the surfaces to subscribe to. Reconnects on
 * drop with exponential backoff (1s → 30s cap).
 *
 * Event types are shared with the v2 dashboard server. See
 * src/orchestrator/main.ts (init payload) and src/orchestrator/routes.ts
 * (per-event broadcasts).
 */
import type { AgentRecord, DashboardMessage, Team } from '../shared/types.ts';
import { state, emit, restoreSelectionOnInit, saveToken, loadCachedThreads, persistCachedThreads, agentsByName, rebuildAgentIndex, rebuildTeamIndex } from './state.ts';

type WsEvent =
  | { type: 'init'; agents: AgentRecord[]; threads: Record<string, DashboardMessage[]>; teams?: Team[] }
  | { type: 'agents_update'; agents: AgentRecord[] }
  | { type: 'agent_update'; agent: AgentRecord }
  | { type: 'agent_destroyed'; name: string }
  | { type: 'message'; msg: DashboardMessage }
  | { type: 'teams_update'; teams: Team[] }
  | { type: 'message_withdrawn'; msg: DashboardMessage }
  | { type: string; [k: string]: unknown };

let socket: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let didOpenOnce = false;
let connectionAttempts = 0;

// Persisting threads to localStorage on every WS message would thrash on
// busy streams. Coalesce writes to one per 500ms.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistCachedThreads();
  }, 500);
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params: string[] = [];
  if (state.token) params.push(`token=${encodeURIComponent(state.token)}`);
  // Tell the server the highest dashboard_messages.id we already have in
  // cache so it can return just the deltas. Cold load (no cache) sends 0
  // and the server falls back to the standard 200-per-agent window.
  const { sinceMessageId } = loadCachedThreads();
  if (sinceMessageId > 0) params.push(`sinceMessageId=${sinceMessageId}`);
  const qs = params.length ? `?${params.join('&')}` : '';
  return `${proto}//${window.location.host}/ws${qs}`;
}

export function connect(): void {
  state.connected = 'connecting';
  emit('connection-changed');
  connectionAttempts++;

  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    console.error('[v3] WebSocket construction failed:', err);
    scheduleReconnect();
    return;
  }

  let openedThisAttempt = false;

  socket.addEventListener('open', () => {
    openedThisAttempt = true;
    didOpenOnce = true;
    state.connected = 'connected';
    reconnectDelay = 1000;
    connectionAttempts = 0;
    emit('connection-changed');
    console.log('[v3] WebSocket connected');
  });

  socket.addEventListener('message', (event) => {
    let msg: WsEvent;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    handle(msg);
  });

  socket.addEventListener('close', () => {
    state.connected = 'disconnected';
    emit('connection-changed');
    // Auth detection: WS closes before opening + we never had a working
    // session = the server probably 401'd us. Prompt for a token.
    if (!openedThisAttempt && !didOpenOnce && connectionAttempts >= 1) {
      void promptForToken();
      return;
    }
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' will follow; reconnect is handled there.
  });
}

async function promptForToken(message?: string): Promise<void> {
  // If the orchestrator isn't reachable at all, fall through to reconnect —
  // don't blame the token.
  try {
    const res = await fetch('/api/orchestrator/status');
    if (!res.ok && res.status !== 401) {
      scheduleReconnect();
      return;
    }
  } catch {
    scheduleReconnect();
    return;
  }

  // Remove any existing overlay first.
  document.querySelector('.auth-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-box">
      <div class="eyebrow">agentic-collab</div>
      <h2>Sign in</h2>
      <p class="lede">${escapeAuth(message || "Enter your orchestrator token to connect. It's saved on this device only — find it at <code>~/.config/agentic-collab/secret</code> or <code>$ORCHESTRATOR_SECRET</code>.")}</p>
      <input type="password" class="auth-input" placeholder="Orchestrator token" autocomplete="off" spellcheck="false">
      <div class="auth-actions">
        <button class="btn ghost" data-skip>Dev mode (no auth)</button>
        <button class="btn primary" data-submit>Connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>('.auth-input')!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>('[data-submit]')!;
  const skipBtn = overlay.querySelector<HTMLButtonElement>('[data-skip]')!;
  if (state.token) input.value = state.token;

  setTimeout(() => input.focus(), 30);

  const submit = (tok: string) => {
    saveToken(tok || null);
    overlay.remove();
    connectionAttempts = 0;
    reconnectDelay = 1000;
    if (socket) {
      // Drop the old handlers so the auto-reconnect doesn't fire twice.
      socket.onclose = null;
      try { socket.close(); } catch {}
      socket = null;
    }
    connect();
  };

  submitBtn.addEventListener('click', () => {
    const val = input.value.trim();
    if (!val) { input.style.borderColor = 'var(--brick)'; return; }
    submit(val);
  });
  skipBtn.addEventListener('click', () => submit(''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitBtn.click();
    }
  });
}

function escapeAuth(s: string): string {
  // Trust HTML inside the message (lets us bold things, render <code>).
  return s;
}

function scheduleReconnect(): void {
  setTimeout(() => {
    if (state.connected !== 'connected') connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function handle(msg: WsEvent): void {
  switch (msg.type) {
    case 'init': {
      const initMsg = msg as Extract<WsEvent, { type: 'init' }> & {
        threadsAreDelta?: boolean;
        maxMessageId?: number;
      };
      state.agents = initMsg.agents ?? [];
      state.teams = initMsg.teams ?? [];
      // Delta init: server only sent rows newer than our cached watermark.
      // Merge them into the cached threads we restored at boot. Cold init
      // (threadsAreDelta=false): replace wholesale.
      const incoming = initMsg.threads ?? {};
      if (initMsg.threadsAreDelta) {
        for (const [agent, msgs] of Object.entries(incoming)) {
          const existing = state.threads[agent] ?? [];
          const seen = new Set(existing.filter((m) => m.id > 0).map((m) => m.id));
          for (const m of msgs) {
            if (!seen.has(m.id)) existing.push(m);
          }
          // Defensive sort: deltas arrive ASC by id, but the cached suffix
          // may have re-ordered timestamps from clock skew or backfills.
          existing.sort((a, b) =>
            a.createdAt === b.createdAt ? a.id - b.id : (a.createdAt < b.createdAt ? -1 : 1));
          state.threads[agent] = existing;
        }
      } else {
        state.threads = incoming;
      }
      // Rebuild seenMessageIds for O(1) dedup on incoming messages
      state.seenMessageIds.clear();
      for (const msgs of Object.values(state.threads)) {
        for (const m of msgs) {
          if (m.id > 0) state.seenMessageIds.add(m.id);
        }
      }
      persistCachedThreads();
      rebuildAgentIndex();
      rebuildTeamIndex();
      // Emit 'init' BEFORE restoring selection so chat.ts clears feedState
      // before selection-changed triggers loadInitialFeed(). Otherwise the
      // init handler clears the feed after it's already being populated.
      emit('init');
      restoreSelectionOnInit();
      emit('agents-changed');
      emit('teams-changed');
      break;
    }
    case 'agents_update': {
      const u = msg as Extract<WsEvent, { type: 'agents_update' }>;
      state.agents = u.agents ?? [];
      rebuildAgentIndex();
      emit('agents-changed');
      break;
    }
    case 'agent_update': {
      const u = msg as Extract<WsEvent, { type: 'agent_update' }>;
      // O(1) lookup via Map instead of O(n) findIndex
      const existing = agentsByName.get(u.agent.name);
      if (existing) {
        const idx = state.agents.indexOf(existing);
        if (idx >= 0) state.agents[idx] = u.agent;
      } else {
        state.agents.push(u.agent);
      }
      agentsByName.set(u.agent.name, u.agent);
      emit('agents-changed');
      break;
    }
    case 'agent_destroyed': {
      const u = msg as Extract<WsEvent, { type: 'agent_destroyed' }>;
      agentsByName.delete(u.name);
      state.agents = state.agents.filter((a) => a.name !== u.name);
      state.selectedAgents.delete(u.name);
      delete state.threads[u.name];
      emit('agents-changed');
      break;
    }
    case 'teams_update': {
      const u = msg as Extract<WsEvent, { type: 'teams_update' }>;
      state.teams = u.teams ?? [];
      rebuildTeamIndex();
      emit('teams-changed');
      break;
    }
    case 'message': {
      const u = msg as Extract<WsEvent, { type: 'message' }>;
      const msgId = u.msg.id;
      // O(1) idempotent check — skip if we've already seen this id
      if (msgId > 0 && state.seenMessageIds.has(msgId)) {
        break;
      }
      const agentName = u.msg.agent;
      const list = state.threads[agentName] ?? [];
      // Dedupe optimistic→real: when an outbound message we sent comes back
      // from the server, replace the negative-id optimistic row in place.
      // Optimistic messages have negative IDs so they're few — linear scan is fine.
      let replaced = false;
      if (msgId > 0) {
        for (let i = list.length - 1; i >= 0 && i >= list.length - 10; i--) {
          const m = list[i];
          if (m.id < 0 && m.agent === u.msg.agent && m.message === u.msg.message && m.direction === u.msg.direction) {
            list[i] = u.msg;
            replaced = true;
            break;
          }
        }
      }
      if (!replaced) {
        list.push(u.msg);
      }
      if (msgId > 0) state.seenMessageIds.add(msgId);
      state.threads[agentName] = list;
      schedulePersist();
      emit('message', u.msg);
      break;
    }
    case 'message_withdrawn': {
      const u = msg as Extract<WsEvent, { type: 'message_withdrawn' }>;
      const list = state.threads[u.msg.agent];
      if (list) {
        const i = list.findIndex((m) => m.id === u.msg.id);
        if (i >= 0) list[i] = u.msg;
      }
      emit('message-withdrawn', u.msg);
      break;
    }
    default:
      // Other event types (queue_update, indicator_update, etc.) — passed
      // through for surface-specific handlers in later PRs.
      emit(`ws:${msg.type}`, msg);
      break;
  }
}
