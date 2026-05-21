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
import { state, emit, selectAllAgentsInitial, saveToken } from './state.ts';

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

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tok = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  return `${proto}//${window.location.host}/ws${tok}`;
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
      const initMsg = msg as Extract<WsEvent, { type: 'init' }>;
      state.agents = initMsg.agents ?? [];
      state.threads = initMsg.threads ?? {};
      state.teams = initMsg.teams ?? [];
      selectAllAgentsInitial();
      emit('init');
      emit('agents-changed');
      emit('teams-changed');
      break;
    }
    case 'agents_update': {
      const u = msg as Extract<WsEvent, { type: 'agents_update' }>;
      state.agents = u.agents ?? [];
      emit('agents-changed');
      break;
    }
    case 'agent_update': {
      const u = msg as Extract<WsEvent, { type: 'agent_update' }>;
      const idx = state.agents.findIndex((a) => a.name === u.agent.name);
      if (idx >= 0) state.agents[idx] = u.agent;
      else state.agents.push(u.agent);
      emit('agents-changed');
      break;
    }
    case 'agent_destroyed': {
      const u = msg as Extract<WsEvent, { type: 'agent_destroyed' }>;
      state.agents = state.agents.filter((a) => a.name !== u.name);
      state.selectedAgents.delete(u.name);
      delete state.threads[u.name];
      emit('agents-changed');
      break;
    }
    case 'teams_update': {
      const u = msg as Extract<WsEvent, { type: 'teams_update' }>;
      state.teams = u.teams ?? [];
      emit('teams-changed');
      break;
    }
    case 'message': {
      const u = msg as Extract<WsEvent, { type: 'message' }>;
      const agentName = u.msg.agent;
      const list = state.threads[agentName] ?? [];
      list.push(u.msg);
      state.threads[agentName] = list;
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
