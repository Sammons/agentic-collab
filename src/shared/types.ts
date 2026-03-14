/**
 * Shared types for orchestrator and proxy communication.
 */

// ── Agent ──

export type AgentState = 'void' | 'spawning' | 'resuming' | 'suspending' | 'active' | 'idle' | 'suspended' | 'failed';

export type EngineType = 'claude' | 'codex' | 'opencode';

/** Launch-time environment variables injected into the agent process. */
export type LaunchEnv = Record<string, string>;

// ── Hook Schema ──

/** A single action in a send sequence. Exactly one of keystroke/text/paste must be set. */
export type SendAction =
  | { keystroke: string; post_wait_ms?: number }
  | { text: string; post_wait_ms?: number }
  | { paste: string; post_wait_ms?: number };

/** Preset hook: use engine adapter default with optional overrides. */
export type PresetHook = {
  preset: string;
  options?: {
    model?: string;
    thinking?: string;
    permissions?: string;
  };
};

/** Shell hook: paste a command, auto-prefixed with env vars. */
export type ShellHook = {
  shell: string;
  env?: LaunchEnv;
};

/** Send hook: ordered sequence of tmux send-keys/paste actions. */
export type SendHook = {
  send: SendAction[];
};

/** Keystrokes hook: ordered sequence of tmux send-keys/paste actions (preferred name for SendHook). */
export type KeystrokesHook = {
  keystrokes: SendAction[];
};

/** Structured hook value — discriminated by which key is present. */
export type StructuredHook = PresetHook | ShellHook | SendHook | KeystrokesHook;

/** A hook field value: flat string (legacy) or structured object. */
export type HookValue = string | StructuredHook | null;

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
  launchEnv: LaunchEnv | null; // launch-time env injected on spawn/resume/reload
  sortOrder: number; // manual ordering within group
  /** Hook value for starting the agent (preset/file/inline). */
  hookStart: string | null;
  /** Hook value for resuming the agent. */
  hookResume: string | null;
  /** Hook value for compacting the agent. */
  hookCompact: string | null;
  /** Hook value for exiting the agent. */
  hookExit: string | null;
  /** Hook value for interrupting the agent. */
  hookInterrupt: string | null;
  /** Hook value for submitting messages to the agent. */
  hookSubmit: string | null;
  /** Hook value for detecting the agent's session ID after spawn/resume. */
  hookDetectSession: string | null;
  /** Regex to extract session ID from pane output on exit. First capture group = session ID. */
  detectSessionRegex: string | null;
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
  sourceAgent: string | null;
  targetAgent: string | null;
  topic: string | null;
  message: string;
  queueId: number | null;
  deliveryStatus: string | null;
  withdrawn: boolean;
  createdAt: string;
  archivedAt: string | null;
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

// ── Reminders ──

export type ReminderStatus = 'pending' | 'completed';

export type Reminder = {
  id: number;
  agentName: string;
  createdBy: string | null;
  prompt: string;
  cadenceMinutes: number;
  sortOrder: number;
  status: ReminderStatus;
  lastDeliveredAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

// ── Proxy Registration ──

export type ProxyRegistration = {
  proxyId: string;
  token: string;
  host: string; // hostname:port of the proxy
  version: string | null;
  versionMatch: boolean; // true if proxy version matches orchestrator
  lastHeartbeat: string;
  registeredAt: string;
};

// ── WebSocket Events (Orchestrator → Dashboard) ──

export type WsInitEvent = {
  type: 'init';
  agents: AgentRecord[];
  threads: Record<string, DashboardMessage[]>;
  proxies: ProxyRegistration[];
  unreadCounts: Record<string, number>;
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
  | { action: 'send_keys'; sessionName: string; keys: string }
  | { action: 'send_keys_raw'; sessionName: string; keys: string[] }
  | { action: 'display_message'; sessionName: string; format: string }
  | { action: 'write_codex_profile'; profileName: string; developerInstructions: string }
  | { action: 'remove_codex_profile'; profileName: string }
  | { action: 'exec'; command: string; cwd?: string; timeoutMs?: number }
  | { action: 'resize_pane'; sessionName: string; width: number; height: number };

export type ProxyResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};
