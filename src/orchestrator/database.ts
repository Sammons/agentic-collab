/**
 * SQLite persistence layer using node:sqlite (DatabaseSync).
 * WAL mode, strict schemas, optimistic concurrency via version column.
 */

import { DatabaseSync } from 'node:sqlite';
import type {
  AgentRecord,
  AgentState,
  DashboardMessage,
  EngineType,
  EventRecord,
  MessageDirection,
  PendingMessage,
  PendingMessageStatus,
  ProxyRegistration,
} from '../shared/types.ts';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS agents (
    name               TEXT PRIMARY KEY,
    engine             TEXT NOT NULL,
    model              TEXT,
    thinking           TEXT,
    cwd                TEXT NOT NULL,
    persona            TEXT,
    permissions        TEXT,
    proxy_host         TEXT,
    state              TEXT NOT NULL DEFAULT 'void',
    state_before_shutdown TEXT,
    current_session_id TEXT,
    tmux_session       TEXT,
    proxy_id           TEXT,
    last_activity      TEXT,
    last_context_pct   INTEGER,
    reload_queued      INTEGER NOT NULL DEFAULT 0,
    reload_task        TEXT,
    failed_at          TEXT,
    failure_reason     TEXT,
    version            INTEGER NOT NULL DEFAULT 0,
    spawn_count        INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    event      TEXT NOT NULL,
    message_id TEXT,
    meta       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_name, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id) WHERE message_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS dashboard_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent      TEXT NOT NULL,
    direction  TEXT NOT NULL,
    topic      TEXT,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_dm_agent ON dashboard_messages(agent);

  CREATE TABLE IF NOT EXISTS proxies (
    proxy_id      TEXT PRIMARY KEY,
    token         TEXT NOT NULL,
    host          TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    registered_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS pending_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_agent    TEXT,
    target_agent    TEXT NOT NULL,
    envelope        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    retry_count     INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    delivered_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pm_agent_status ON pending_messages(target_agent, status);
`;

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    // Add queue_id to dashboard_messages if not present
    const dmColumns = this.db.prepare('PRAGMA table_info(dashboard_messages)').all() as Array<Record<string, unknown>>;
    if (!dmColumns.some((c) => c['name'] === 'queue_id')) {
      this.db.exec('ALTER TABLE dashboard_messages ADD COLUMN queue_id INTEGER REFERENCES pending_messages(id)');
    }

    // Add permissions and proxy_host to agents if not present
    const agentColumns = this.db.prepare('PRAGMA table_info(agents)').all() as Array<Record<string, unknown>>;
    const agentColNames = new Set(agentColumns.map(c => c['name'] as string));
    if (!agentColNames.has('permissions')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN permissions TEXT');
    }
    if (!agentColNames.has('proxy_host')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN proxy_host TEXT');
    }
  }

  /** Expose raw handle for LockManager (shares same DB connection). */
  get rawDb(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ── Agents ──

  createAgent(opts: {
    name: string;
    engine: EngineType;
    model?: string;
    thinking?: string;
    cwd: string;
    persona?: string;
    permissions?: string;
    proxyHost?: string;
    proxyId?: string;
  }): AgentRecord {
    this.db.prepare(`
      INSERT INTO agents (name, engine, model, thinking, cwd, persona, permissions, proxy_host, proxy_id, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'void')
    `).run(
      opts.name,
      opts.engine,
      opts.model ?? null,
      opts.thinking ?? null,
      opts.cwd,
      opts.persona ?? null,
      opts.permissions ?? null,
      opts.proxyHost ?? null,
      opts.proxyId ?? null,
    );
    return this.getAgent(opts.name)!;
  }

  /**
   * Upsert agent from persona frontmatter. Creates if missing, updates config fields
   * if existing. Preserves runtime state (active/idle/suspended, session, proxy, etc.).
   */
  upsertAgentFromPersona(opts: {
    name: string;
    engine: EngineType;
    model?: string;
    thinking?: string;
    cwd: string;
    persona?: string;
    permissions?: string;
    proxyHost?: string;
  }): AgentRecord {
    const existing = this.getAgent(opts.name);
    if (!existing) {
      return this.createAgent(opts);
    }
    // Update config fields only — preserve runtime state
    this.db.prepare(`
      UPDATE agents SET engine = ?, model = ?, thinking = ?, cwd = ?,
        persona = ?, permissions = ?, proxy_host = ?
      WHERE name = ?
    `).run(
      opts.engine,
      opts.model ?? null,
      opts.thinking ?? null,
      opts.cwd,
      opts.persona ?? null,
      opts.permissions ?? null,
      opts.proxyHost ?? null,
      opts.name,
    );
    return this.getAgent(opts.name)!;
  }

  getAgent(name: string): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapAgentRow(row);
  }

  listAgents(): AgentRecord[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(mapAgentRow);
  }

  updateAgentState(name: string, state: AgentState, expectedVersion: number, extra?: Partial<{
    currentSessionId: string | null;
    tmuxSession: string | null;
    proxyId: string | null;
    lastActivity: string | null;
    lastContextPct: number | null;
    reloadQueued: number;
    reloadTask: string | null;
    failedAt: string | null;
    failureReason: string | null;
    stateBeforeShutdown: string | null;
    spawnCount: number;
  }>): AgentRecord {
    const agent = this.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (agent.version !== expectedVersion) {
      throw new Error(`Version conflict: expected ${expectedVersion}, got ${agent.version}`);
    }

    const sets: string[] = ['state = ?', 'version = version + 1'];
    const params: unknown[] = [state];

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) {
          sets.push(`${toColumnName(key)} = ?`);
          params.push(value);
        }
      }
    }

    params.push(name, expectedVersion);

    const result = this.db.prepare(`
      UPDATE agents SET ${sets.join(', ')}
      WHERE name = ? AND version = ?
    `).run(...params);

    if (result.changes === 0) {
      throw new Error(`Version conflict on update for agent "${name}"`);
    }

    return this.getAgent(name)!;
  }

  deleteAgent(name: string): boolean {
    const result = this.db.prepare('DELETE FROM agents WHERE name = ?').run(name);
    return result.changes > 0;
  }

  // ── Events ──

  logEvent(agentName: string, event: string, messageId?: string, meta?: Record<string, unknown>): EventRecord {
    const metaStr = meta ? JSON.stringify(meta) : null;
    this.db.prepare(`
      INSERT INTO events (agent_name, event, message_id, meta)
      VALUES (?, ?, ?, ?)
    `).run(agentName, event, messageId ?? null, metaStr);

    const row = this.db.prepare('SELECT * FROM events WHERE id = last_insert_rowid()').get() as Record<string, unknown>;
    return mapEventRow(row);
  }

  getEvents(agentName: string, limit = 50): EventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentName, limit) as Array<Record<string, unknown>>;
    return rows.map(mapEventRow);
  }

  // ── Dashboard Messages ──

  addDashboardMessage(agent: string, direction: MessageDirection, message: string, topic?: string): DashboardMessage {
    this.db.prepare(`
      INSERT INTO dashboard_messages (agent, direction, topic, message)
      VALUES (?, ?, ?, ?)
    `).run(agent, direction, topic ?? null, message);

    const row = this.db.prepare(
      'SELECT * FROM dashboard_messages WHERE id = last_insert_rowid()'
    ).get() as Record<string, unknown>;
    return mapDashboardMessageRow(row);
  }

  getDashboardThreads(agentName?: string): Record<string, DashboardMessage[]> {
    const query = `
      SELECT dm.*, pm.status AS delivery_status
      FROM dashboard_messages dm
      LEFT JOIN pending_messages pm ON dm.queue_id = pm.id
      ${agentName ? 'WHERE dm.agent = ?' : ''}
      ORDER BY dm.created_at ASC
    `;
    const rows = agentName
      ? this.db.prepare(query).all(agentName) as Array<Record<string, unknown>>
      : this.db.prepare(query).all() as Array<Record<string, unknown>>;

    const threads: Record<string, DashboardMessage[]> = {};
    for (const row of rows) {
      const msg = mapDashboardMessageRow(row);
      if (!threads[msg.agent]) threads[msg.agent] = [];
      threads[msg.agent]!.push(msg);
    }
    return threads;
  }

  // ── Proxies ──

  registerProxy(proxyId: string, token: string, host: string): ProxyRegistration {
    const existing = this.getProxy(proxyId);
    if (existing) {
      // Update existing registration — preserves registered_at
      this.db.prepare(`
        UPDATE proxies SET token = ?, host = ?, last_heartbeat = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE proxy_id = ?
      `).run(token, host, proxyId);
    } else {
      // New registration
      this.db.prepare(`
        INSERT INTO proxies (proxy_id, token, host, last_heartbeat, registered_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      `).run(proxyId, token, host);
    }
    return this.getProxy(proxyId)!;
  }

  getProxy(proxyId: string): ProxyRegistration | undefined {
    const row = this.db.prepare('SELECT * FROM proxies WHERE proxy_id = ?').get(proxyId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapProxyRow(row);
  }

  listProxies(): ProxyRegistration[] {
    const rows = this.db.prepare('SELECT * FROM proxies ORDER BY proxy_id').all() as Array<Record<string, unknown>>;
    return rows.map(mapProxyRow);
  }

  updateProxyHeartbeat(proxyId: string): boolean {
    const result = this.db.prepare(`
      UPDATE proxies SET last_heartbeat = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE proxy_id = ?
    `).run(proxyId);
    return result.changes > 0;
  }

  removeProxy(proxyId: string): boolean {
    const result = this.db.prepare('DELETE FROM proxies WHERE proxy_id = ?').run(proxyId);
    return result.changes > 0;
  }

  static readonly MAX_DELIVERY_RETRIES = 5;

  // ── Message Queue ──

  enqueueMessage(opts: { sourceAgent?: string | null; targetAgent: string; envelope: string }): PendingMessage {
    this.db.prepare(`
      INSERT INTO pending_messages (source_agent, target_agent, envelope)
      VALUES (?, ?, ?)
    `).run(opts.sourceAgent ?? null, opts.targetAgent, opts.envelope);
    const row = this.db.prepare('SELECT * FROM pending_messages WHERE id = last_insert_rowid()').get() as Record<string, unknown>;
    return mapPendingMessageRow(row);
  }

  getDeliverableMessages(agentName: string): PendingMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE target_agent = ? AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ORDER BY id ASC
    `).all(agentName) as Array<Record<string, unknown>>;
    return rows.map(mapPendingMessageRow);
  }

  markAttemptStarted(id: number): void {
    this.db.prepare(`
      UPDATE pending_messages SET last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(id);
  }

  markMessageDelivered(id: number): void {
    this.db.prepare(`
      UPDATE pending_messages SET status = 'delivered', delivered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(id);
  }

  markAttemptFailed(id: number, error: string, maxRetries = Database.MAX_DELIVERY_RETRIES): void {
    const row = this.db.prepare('SELECT * FROM pending_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return;
    const retryCount = (row['retry_count'] as number) + 1;
    if (retryCount >= maxRetries) {
      this.db.prepare(`
        UPDATE pending_messages SET status = 'failed', retry_count = ?, error = ? WHERE id = ?
      `).run(retryCount, error, id);
    } else {
      // Exponential backoff: 30s, 60s, 120s, 240s, 480s
      const backoffSeconds = 30 * Math.pow(2, retryCount - 1);
      this.db.prepare(`
        UPDATE pending_messages
        SET retry_count = ?, error = ?,
            next_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(retryCount, error, backoffSeconds, id);
    }
  }

  resetStaleAttempts(timeoutSeconds = 60): number {
    const result = this.db.prepare(`
      UPDATE pending_messages
      SET retry_count = retry_count + 1,
          error = 'Delivery attempt timed out',
          next_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+30 seconds')
      WHERE status = 'pending'
        AND last_attempt_at IS NOT NULL
        AND delivered_at IS NULL
        AND julianday('now') - julianday(last_attempt_at) > ? / 86400.0
    `).run(timeoutSeconds);
    return result.changes;
  }

  linkDashboardMessageToQueue(dashboardMsgId: number, queueId: number): void {
    this.db.prepare('UPDATE dashboard_messages SET queue_id = ? WHERE id = ?').run(queueId, dashboardMsgId);
  }

  getPendingMessageById(id: number): PendingMessage | undefined {
    const row = this.db.prepare('SELECT * FROM pending_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapPendingMessageRow(row);
  }

  listPendingMessages(agent?: string, status?: string): PendingMessage[] {
    let sql = 'SELECT * FROM pending_messages WHERE 1=1';
    const params: unknown[] = [];
    if (agent) {
      sql += ' AND target_agent = ?';
      params.push(agent);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id DESC LIMIT 100';
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapPendingMessageRow);
  }

  listStaleProxies(thresholdSeconds: number): ProxyRegistration[] {
    const rows = this.db.prepare(`
      SELECT * FROM proxies
      WHERE julianday('now') - julianday(last_heartbeat) > ? / 86400.0
      ORDER BY proxy_id
    `).all(thresholdSeconds) as Array<Record<string, unknown>>;
    return rows.map(mapProxyRow);
  }
}

// ── Row Mappers ──

function mapAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    name: row['name'] as string,
    engine: row['engine'] as EngineType,
    model: row['model'] as string | null,
    thinking: row['thinking'] as string | null,
    cwd: row['cwd'] as string,
    persona: row['persona'] as string | null,
    permissions: row['permissions'] as string | null,
    proxyHost: row['proxy_host'] as string | null,
    state: row['state'] as AgentState,
    stateBeforeShutdown: row['state_before_shutdown'] as string | null,
    currentSessionId: row['current_session_id'] as string | null,
    tmuxSession: row['tmux_session'] as string | null,
    proxyId: row['proxy_id'] as string | null,
    lastActivity: row['last_activity'] as string | null,
    lastContextPct: row['last_context_pct'] as number | null,
    reloadQueued: row['reload_queued'] as number,
    reloadTask: row['reload_task'] as string | null,
    failedAt: row['failed_at'] as string | null,
    failureReason: row['failure_reason'] as string | null,
    version: row['version'] as number,
    spawnCount: row['spawn_count'] as number,
    createdAt: row['created_at'] as string,
  };
}

function mapEventRow(row: Record<string, unknown>): EventRecord {
  return {
    id: row['id'] as number,
    agentName: row['agent_name'] as string,
    event: row['event'] as string,
    messageId: row['message_id'] as string | null,
    meta: row['meta'] as string | null,
    createdAt: row['created_at'] as string,
  };
}

function mapDashboardMessageRow(row: Record<string, unknown>): DashboardMessage {
  return {
    id: row['id'] as number,
    agent: row['agent'] as string,
    direction: row['direction'] as MessageDirection,
    topic: row['topic'] as string | null,
    message: row['message'] as string,
    queueId: (row['queue_id'] as number | null) ?? null,
    deliveryStatus: (row['delivery_status'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
  };
}

function mapPendingMessageRow(row: Record<string, unknown>): PendingMessage {
  return {
    id: row['id'] as number,
    sourceAgent: row['source_agent'] as string | null,
    targetAgent: row['target_agent'] as string,
    envelope: row['envelope'] as string,
    status: row['status'] as PendingMessageStatus,
    retryCount: row['retry_count'] as number,
    error: row['error'] as string | null,
    lastAttemptAt: row['last_attempt_at'] as string | null,
    nextAttemptAt: row['next_attempt_at'] as string | null,
    createdAt: row['created_at'] as string,
    deliveredAt: row['delivered_at'] as string | null,
  };
}

function mapProxyRow(row: Record<string, unknown>): ProxyRegistration {
  return {
    proxyId: row['proxy_id'] as string,
    token: row['token'] as string,
    host: row['host'] as string,
    lastHeartbeat: row['last_heartbeat'] as string,
    registeredAt: row['registered_at'] as string,
  };
}

const COLUMN_MAP: Record<string, string> = {
  currentSessionId: 'current_session_id',
  tmuxSession: 'tmux_session',
  proxyId: 'proxy_id',
  lastActivity: 'last_activity',
  lastContextPct: 'last_context_pct',
  reloadQueued: 'reload_queued',
  reloadTask: 'reload_task',
  failedAt: 'failed_at',
  failureReason: 'failure_reason',
  stateBeforeShutdown: 'state_before_shutdown',
  spawnCount: 'spawn_count',
};

function toColumnName(key: string): string {
  const col = COLUMN_MAP[key];
  if (!col) throw new Error(`Unknown agent column: "${key}"`);
  return col;
}
