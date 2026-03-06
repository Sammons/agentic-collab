/**
 * Shared types for orchestrator and proxy communication.
 */

// ── Agent ──

export type AgentState = 'void' | 'spawning' | 'active' | 'idle' | 'suspended' | 'failed';

export type EngineType = 'claude' | 'codex' | 'opencode';

export type AgentRecord = {
  name: string;
  engine: EngineType;
  model: string | null;
  thinking: string | null; // 'low' | 'medium' | 'high' | null
  cwd: string;
  persona: string | null;
  state: AgentState;
  stateBeforeShutdown: string | null;
  currentSessionId: string | null;
  tmuxSession: string | null;
  proxyId: string | null; // which proxy owns this agent
  lastActivity: string | null;
  lastContextPct: number | null;
  reloadQueued: number;
  reloadTask: string | null;
  failedAt: string | null;
  failureReason: string | null;
  version: number;
  spawnCount: number;
  createdAt: string;
};

// ── Workstream ──

export type WorkstreamRecord = {
  name: string;
  goal: string;
  plan: string | null;
  status: string;
  createdAt: string;
};

// ── Events ──

export type EventRecord = {
  id: number;
  agentName: string;
  event: string;
  messageId: string | null;
  meta: string | null;
  createdAt: string;
};

// ── Dashboard Messages ──

export type MessageDirection = 'to_agent' | 'from_agent';

export type DashboardMessage = {
  id: number;
  agent: string;
  direction: MessageDirection;
  topic: string | null;
  message: string;
  createdAt: string;
};

// ── Proxy Registration ──

export type ProxyRegistration = {
  proxyId: string;
  token: string;
  host: string; // hostname:port of the proxy
  lastHeartbeat: string;
  registeredAt: string;
};

// ── WebSocket Events (Orchestrator → Dashboard) ──

export type WsInitEvent = {
  type: 'init';
  agents: AgentRecord[];
  threads: Record<string, DashboardMessage[]>;
  proxies: ProxyRegistration[];
};

export type WsAgentUpdateEvent = {
  type: 'agent_update';
  agent: AgentRecord;
};

export type WsMessageEvent = {
  type: 'message';
  msg: DashboardMessage;
};

export type WsProxyEvent = {
  type: 'proxy_update';
  proxies: ProxyRegistration[];
};

export type WsEvent = WsInitEvent | WsAgentUpdateEvent | WsMessageEvent | WsProxyEvent;

// ── Proxy API ──

export type ProxyCommand =
  | { action: 'create_session'; sessionName: string; cwd: string }
  | { action: 'paste'; sessionName: string; text: string; pressEnter: boolean }
  | { action: 'capture'; sessionName: string; lines: number }
  | { action: 'kill_session'; sessionName: string }
  | { action: 'list_sessions' }
  | { action: 'has_session'; sessionName: string }
  | { action: 'send_keys'; sessionName: string; keys: string };

export type ProxyResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

