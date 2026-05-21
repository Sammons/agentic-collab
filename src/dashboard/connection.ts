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

async function promptForToken(): Promise<void> {
  // Verify whether auth is actually required by hitting a known endpoint.
  // If the orchestrator is running with no secret, auth is open and the WS
  // close was due to something else — just reconnect.
  try {
    const res = await fetch('/api/orchestrator/status');
    if (res.ok) {
      // Server is up and reachable — but our WS closed. Try once more with
      // a token from the user.
    }
  } catch {
    // Network/down. Fall through to reconnect.
    scheduleReconnect();
    return;
  }

  const existing = state.token ?? '';
  const provided = window.prompt(
    'Orchestrator token (from ~/.config/agentic-collab/secret or env ORCHESTRATOR_SECRET):',
    existing,
  );
  if (provided === null) {
    // User cancelled — give up and try in a while.
    scheduleReconnect();
    return;
  }
  const trimmed = provided.trim();
  if (!trimmed) {
    scheduleReconnect();
    return;
  }
  saveToken(trimmed);
  connectionAttempts = 0;
  reconnectDelay = 1000;
  connect();
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
