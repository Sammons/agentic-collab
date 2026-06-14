/**
 * Shared types for orchestrator and proxy communication.
 */

// ── Agent ──

export type { Address } from './address.ts';

export type AgentState = 'void' | 'spawning' | 'resuming' | 'suspending' | 'active' | 'idle' | 'suspended' | 'failed';

export type EngineType = 'claude' | 'codex' | 'opencode';

/** Launch-time environment variables injected into the agent process. */
export type LaunchEnv = Record<string, string>;

/**
 * Per-agent Telegram binding config (RFC-008), declared in persona frontmatter
 * under `telegram:`. Carries ONLY non-secret binding/routing config — the bot
 * token is NEVER stored here; it lives AES-256-GCM-encrypted in SQLite, set via
 * a write-only API and decrypted at reconcile time (RFC-008 §2).
 */
export type AgentTelegramConfig = {
  /** Default outbound chat id (not secret). */
  chatId: string;
  /** When false, the bot is outbound-only. Defaults to true. */
  inbound?: boolean;
  /** Inbound routing mode. self (default) = bot↔agent 1:1. */
  routing?: 'self' | 'prefix' | 'passthrough';
};

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

// ── Pipeline Steps ──

/** A single step in a composable hook pipeline. */
export type PipelineStep =
  | { type: 'keystrokes'; actions: SendAction[] }
  | { type: 'keystroke'; key: string }
  | { type: 'shell'; command: string; env?: LaunchEnv }
  | { type: 'capture'; lines: number; regex: string; var: string }
  | { type: 'wait'; ms: number };

/** A hook field value: flat string (legacy), structured object, or pipeline (array of steps). */
export type HookValue = string | StructuredHook | PipelineStep[] | null;

// ── Indicators ──

export type IndicatorAction = PipelineStep[];

export type IndicatorDefinition = {
  id: string;
  regex: string;
  badge: string;
  style: 'warning' | 'danger' | 'info';
  actions?: Record<string, IndicatorAction>;
};

export type ActiveIndicator = {
  id: string;
  badge: string;
  style: string;
  actions?: Record<string, IndicatorAction>;
};

// ── Detection ──

export type DetectionPattern = string | { pattern: string; lines?: number };

export type DetectionConfig = {
  idlePatterns?: DetectionPattern[];
  activePatterns?: DetectionPattern[];
  contextPattern?: string;
  idleThreshold?: number;
  activeGraceMs?: number;
  snapshotLines?: number;
  /** When true, automatically recover failed agents by starting a fresh session
   *  with a reconstruction prompt instead of leaving them in 'failed' state. */
  autoRecover?: boolean;
};

// ── Files (orchestrator-native file registry) ──

export type FileRecord = {
  id: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  createdAt: string;
  expiresAt: string | null;
};

// ── Pages ──

export type PageRecord = {
  slug: string;
  title: string | null;
  agent: string | null;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
};

// ── Destinations ──

export type DestinationRecord = {
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── Data Stores ──

export type DataStoreRecord = {
  name: string;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EngineConfigRecord = {
  name: string;
  engine: string;
  model: string | null;
  thinking: string | null;
  permissions: string | null;
  hookStart: string | null;
  hookResume: string | null;
  hookCompact: string | null;
  hookExit: string | null;
  hookInterrupt: string | null;
  hookReload: string | null;
  hookSubmit: string | null;
  indicators: string | null;
  detection: string | null;
  customButtons: string | null;
  launchEnv: Record<string, string> | null;
  createdAt: string;
};

export type AgentRecord = {
  name: string;
  engine: EngineType;
  model: string | null;
  thinking: string | null; // 'low' | 'medium' | 'high' | null
  cwd: string;
  persona: string | null;
  permissions: string | null; // 'skip' | null
  agentGroup: string | null; // grouping label from persona frontmatter
  launchEnv: LaunchEnv | null; // launch-time env injected on spawn/resume/reload
  account: string | null; // named credential account for HOME isolation
  proxyPin: string | null; // persona-declared proxy (frontmatter `proxy:`); authoritative over proxyId
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
  /** Hook value for reloading the agent (exit + fresh start). */
  hookReload: string | null;
  /** Hook value for submitting messages to the agent. */
  hookSubmit: string | null;
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
  capturedVars: Record<string, string> | null;
  customButtons: string | null;
  indicators: string | null;
  icon: string | null;
  /** Per-agent Telegram binding config (RFC-008). Non-secret; token stored encrypted separately. */
  agentTelegram: AgentTelegramConfig | null;
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
  fileIds: string[] | null;
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
  skipIfActive: boolean;
  sortOrder: number;
  status: ReminderStatus;
  lastDeliveredAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

// ── Teams (v3 UI grouping) ──

/**
 * A team is a UI-only grouping of agents used as a filter source in the v3
 * dashboard sidebar. Teams have no behavioral effect on the kernel — they
 * only shape what the operator sees in chat, reminders, and search. An
 * agent can belong to multiple teams (many-to-many).
 *
 * Schema lives in two tables:
 *   teams(id, name UNIQUE, created_at)
 *   team_members(team_id, agent_name, added_at, PK(team_id, agent_name))
 * Deleting a team cascades to its membership rows.
 */
export type Team = {
  id: number;
  name: string;
  members: string[]; // agent names (sorted)
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

// ── Approvals (v3 Q5) ──

/**
 * State machine for an approval row:
 *   pending  → approved | rejected | amended | withdrawn (terminal)
 *
 * Terminal states are immutable; `setState` rejects callers that try to
 * mutate a terminal row. `withdrawn` is creator-only while pending.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'amended' | 'withdrawn';

/**
 * Row in the `approvals` table. Approvals are first-class CRUD records
 * categorised by `channel` (`approval:<channel>`); they are *not* a
 * message-routing surface — auto-notification on state change routes
 * through the existing message dispatcher to the requester's address.
 */
export type ApprovalRow = {
  id: string;
  requesterAddr: string;
  channel: string;
  payload: string;
  state: ApprovalState;
  amendmentsJson: string | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

/** Row in the `approval_events` audit table — one per state transition / lifecycle event. */
export type ApprovalEventRow = {
  id: number;
  approvalId: string;
  eventType: string;
  payload: string | null;
  createdAt: string;
};

// ── WebSocket Events (Orchestrator → Dashboard) ──

export type WsInitEvent = {
  type: 'init';
  agents: AgentRecord[];
  engineConfigs: EngineConfigRecord[];
  threads: Record<string, DashboardMessage[]>;
  proxies: ProxyRegistration[];
  unreadCounts: Record<string, number>;
  indicators?: Record<string, ActiveIndicator[]>;
  stores?: DataStoreRecord[];
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

export type WsIndicatorUpdateEvent = {
  type: 'indicator_update';
  agentName: string;
  indicators: ActiveIndicator[];
};

export type WsStoresUpdateEvent = {
  type: 'stores_update';
  stores: DataStoreRecord[];
};

export type WsDestinationsUpdateEvent = {
  type: 'destinations_update';
  destinations: DestinationRecord[];
};

export type WsNotificationEvent = {
  type: 'notification';
  agent: string | null;
  message: string;
  priority: string;
};

// ── v3 events: approvals ──
//
// Snake-case `type` values follow the existing WS convention. Dashboard
// consumers currently ignore unknown event types (see
// `src/dashboard/connection.ts`'s default-less switch) so adding these
// is non-breaking.

/**
 * Emitted by the approvals service when an approval row's `state` column
 * changes. Subscribed dashboard clients narrow on `type` to react.
 */
export type WsApprovalChangedEvent = {
  type: 'approval_changed';
  approvalId: string;
  state: string;
  channel: string;
};

export type WsEvent =
  | WsInitEvent
  | WsAgentUpdateEvent
  | WsMessageEvent
  | WsProxyEvent
  | WsQueueUpdateEvent
  | WsIndicatorUpdateEvent
  | WsStoresUpdateEvent
  | WsDestinationsUpdateEvent
  | WsNotificationEvent
  | WsApprovalChangedEvent;

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
  /**
   * Persist the composed system prompt for an OpenCode agent to
   * ~/.config/opencode/collab/<agentName>.md on the proxy host. The spawn
   * command then points OPENCODE_CONFIG_CONTENT at that file via the
   * `instructions` config field, which OpenCode APPENDS to the system prompt.
   * Mirrors write_codex_profile / remove_codex_profile.
   */
  | { action: 'write_opencode_instructions'; agentName: string; content: string }
  | { action: 'remove_opencode_instructions'; agentName: string }
  | { action: 'exec'; command: string; cwd?: string; timeoutMs?: number }
  | { action: 'resize_pane'; sessionName: string; width: number; height: number }
  | { action: 'clear_history'; sessionName: string }
  /**
   * List a directory on the proxy host. `path` is the absolute path to read;
   * if empty, the proxy interprets it as $HOME. `showHidden` includes entries
   * starting with `.` (default false). Returns:
   *   { path: <resolved absolute>, entries: [{ name, kind: 'dir'|'file'|'link' }] }
   * Used by the v3 dashboard's CWD picker so agents can be created against
   * paths that exist on the host (orchestrator is in Docker, can't read host fs).
   */
  | { action: 'list_dir'; path: string; showHidden?: boolean };

export type ProxyResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};
