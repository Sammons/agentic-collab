/**
 * Shared types for orchestrator and proxy communication.
 */

// ── Agent ──

export type AgentState = 'void' | 'spawning' | 'resuming' | 'suspending' | 'active' | 'idle' | 'suspended' | 'failed';

export type EngineType = 'claude' | 'codex' | 'opencode';

export type AgentRecord = {
  name: string;
  engine: EngineType;
  model: string | null;
  thinking: string | null; // 'low' | 'medium' | 'high' | null
  cwd: string;
  persona: string | null;
  permissions: string | null; // 'skip' | null
  proxyHost: string | null; // hostname for proxy pinning
  agentGroup: string | null; // grouping label from persona frontmatter
  sortOrder: number; // manual ordering within group
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
  queueId: number | null;
  deliveryStatus: string | null;
  withdrawn: boolean;
  createdAt: string;
};

// ── Message Queue ──

export type PendingMessageStatus = 'pending' | 'delivered' | 'failed';

export type PendingMessage = {
  id: number;
  sourceAgent: string | null; // who sent it (null = dashboard)
  targetAgent: string;
  envelope: string;
  status: PendingMessageStatus;
  retryCount: number;
  error: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
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

export type WsQueueUpdateEvent = {
  type: 'queue_update';
  message: PendingMessage;
};

export type WsEvent = WsInitEvent | WsAgentUpdateEvent | WsMessageEvent | WsProxyEvent | WsQueueUpdateEvent;

// ── Proxy API ──

export type ProxyCommand =
  | { action: 'create_session'; sessionName: string; cwd: string }
  | { action: 'paste'; sessionName: string; text: string; pressEnter: boolean }
  | { action: 'capture'; sessionName: string; lines: number }
  | { action: 'kill_session'; sessionName: string }
  | { action: 'list_sessions' }
  | { action: 'has_session'; sessionName: string }
  | { action: 'pane_activity'; sessionName: string }
  | { action: 'send_keys'; sessionName: string; keys: string };

export type ProxyResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

