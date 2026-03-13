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
  LaunchEnv,
  MessageDirection,
  PendingMessage,
  PendingMessageStatus,
  ProxyRegistration,
  Reminder,
  ReminderStatus,
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

  CREATE TABLE IF NOT EXISTS dashboard_read_cursors (
    agent           TEXT PRIMARY KEY,
    last_read_msg_id INTEGER NOT NULL DEFAULT 0
  );
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
    if (!agentColNames.has('agent_group')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN agent_group TEXT');
    }
    if (!agentColNames.has('launch_env')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN launch_env TEXT');
    }
    if (!agentColNames.has('sort_order')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    }
    if (!agentColNames.has('hook_spawn')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_spawn TEXT');
    }
    // Rename hook_spawn → hook_start (migrate data, keep old column for safety)
    if (!agentColNames.has('hook_start')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_start TEXT');
      this.db.exec('UPDATE agents SET hook_start = hook_spawn WHERE hook_spawn IS NOT NULL');
    }
    if (!agentColNames.has('hook_resume')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_resume TEXT');
    }
    if (!agentColNames.has('hook_compact')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_compact TEXT');
    }
    if (!agentColNames.has('hook_exit')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_exit TEXT');
    }
    if (!agentColNames.has('hook_interrupt')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_interrupt TEXT');
    }
    if (!agentColNames.has('hook_submit')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_submit TEXT');
    }
    if (!agentColNames.has('hook_detect_session')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_detect_session TEXT');
    }
    if (!agentColNames.has('detect_session_regex')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN detect_session_regex TEXT');
    }

    // Add withdrawn column to dashboard_messages
    if (!dmColumns.some((c) => c['name'] === 'withdrawn')) {
      this.db.exec('ALTER TABLE dashboard_messages ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0');
    }

    // Add archived_at column to dashboard_messages
    const dmColsRefresh = this.db.prepare('PRAGMA table_info(dashboard_messages)').all() as Array<Record<string, unknown>>;
    if (!dmColsRefresh.some((c) => c['name'] === 'archived_at')) {
      this.db.exec('ALTER TABLE dashboard_messages ADD COLUMN archived_at TEXT');
    }

    // Add source_agent and target_agent to dashboard_messages
    const dmColsForAgents = this.db.prepare('PRAGMA table_info(dashboard_messages)').all() as Array<Record<string, unknown>>;
    const dmColNamesForAgents = new Set(dmColsForAgents.map(c => c['name'] as string));
    if (!dmColNamesForAgents.has('source_agent')) {
      this.db.exec('ALTER TABLE dashboard_messages ADD COLUMN source_agent TEXT');
    }
    if (!dmColNamesForAgents.has('target_agent')) {
      this.db.exec('ALTER TABLE dashboard_messages ADD COLUMN target_agent TEXT');
    }

    // Add version column to proxies
    const proxyColumns = this.db.prepare('PRAGMA table_info(proxies)').all() as Array<Record<string, unknown>>;
    if (!proxyColumns.some((c) => c['name'] === 'version')) {
      this.db.exec('ALTER TABLE proxies ADD COLUMN version TEXT');
    }

    // Create reminders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        created_by TEXT,
        prompt TEXT NOT NULL,
        cadence_minutes INTEGER NOT NULL DEFAULT 10,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_delivered_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `);
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
    agentGroup?: string;
    launchEnv?: LaunchEnv | null;
    hookStart?: string;
    hookResume?: string;
    hookCompact?: string;
    hookExit?: string;
    hookInterrupt?: string;
    hookSubmit?: string;
    hookDetectSession?: string;
    detectSessionRegex?: string;
  }): AgentRecord {
    this.db.prepare(`
      INSERT INTO agents (name, engine, model, thinking, cwd, persona, permissions, proxy_host, proxy_id, agent_group, launch_env, hook_start, hook_resume, hook_compact, hook_exit, hook_interrupt, hook_submit, hook_detect_session, detect_session_regex, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'void')
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
      opts.agentGroup ?? null,
      serializeLaunchEnv(opts.launchEnv),
      opts.hookStart ?? null,
      opts.hookResume ?? null,
      opts.hookCompact ?? null,
      opts.hookExit ?? null,
      opts.hookInterrupt ?? null,
      opts.hookSubmit ?? null,
      opts.hookDetectSession ?? null,
      opts.detectSessionRegex ?? null,
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
    agentGroup?: string;
    launchEnv?: LaunchEnv | null;
    hookStart?: string;
    hookResume?: string;
    hookCompact?: string;
    hookExit?: string;
    hookInterrupt?: string;
    hookSubmit?: string;
    hookDetectSession?: string;
    detectSessionRegex?: string;
  }): AgentRecord {
    const existing = this.getAgent(opts.name);
    if (!existing) {
      return this.createAgent(opts);
    }
    // Update config fields only — preserve runtime state
    this.db.prepare(`
      UPDATE agents SET engine = ?, model = ?, thinking = ?, cwd = ?,
        persona = ?, permissions = ?, proxy_host = ?, agent_group = ?, launch_env = ?,
        hook_start = ?, hook_resume = ?, hook_compact = ?,
        hook_exit = ?, hook_interrupt = ?, hook_submit = ?,
        hook_detect_session = ?, detect_session_regex = ?
      WHERE name = ?
    `).run(
      opts.engine,
      opts.model ?? null,
      opts.thinking ?? null,
      opts.cwd,
      opts.persona ?? null,
      opts.permissions ?? null,
      opts.proxyHost ?? null,
      opts.agentGroup ?? null,
      serializeLaunchEnv(opts.launchEnv),
      opts.hookStart ?? null,
      opts.hookResume ?? null,
      opts.hookCompact ?? null,
      opts.hookExit ?? null,
      opts.hookInterrupt ?? null,
      opts.hookSubmit ?? null,
      opts.hookDetectSession ?? null,
      opts.detectSessionRegex ?? null,
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
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY sort_order ASC, name ASC').all() as Array<Record<string, unknown>>;
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
    agentGroup: string | null;
    launchEnv: LaunchEnv | null;
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

  updateAgentSortOrder(name: string, sortOrder: number): void {
    this.db.prepare('UPDATE agents SET sort_order = ? WHERE name = ?').run(sortOrder, name);
  }

  batchUpdateSortOrder(orders: Array<{ name: string; sortOrder: number }>): void {
    const stmt = this.db.prepare('UPDATE agents SET sort_order = ? WHERE name = ?');
    for (const { name, sortOrder } of orders) {
      stmt.run(sortOrder, name);
    }
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

  addDashboardMessage(agent: string, direction: MessageDirection, message: string, opts?: { topic?: string; sourceAgent?: string; targetAgent?: string }): DashboardMessage {
    this.db.prepare(`
      INSERT INTO dashboard_messages (agent, direction, topic, message, source_agent, target_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agent, direction, opts?.topic ?? null, message, opts?.sourceAgent ?? null, opts?.targetAgent ?? null);

    const row = this.db.prepare(
      'SELECT * FROM dashboard_messages WHERE id = last_insert_rowid()'
    ).get() as Record<string, unknown>;
    return mapDashboardMessageRow(row);
  }

  getDashboardThreads(agentName?: string, opts?: { archived?: boolean }): Record<string, DashboardMessage[]> {
    const showArchived = opts?.archived ?? false;
    const archiveFilter = showArchived ? 'dm.archived_at IS NOT NULL' : 'dm.archived_at IS NULL';
    const query = `
      SELECT dm.*, pm.status AS delivery_status
      FROM dashboard_messages dm
      LEFT JOIN pending_messages pm ON dm.queue_id = pm.id
      WHERE ${archiveFilter}${agentName ? ' AND dm.agent = ?' : ''}
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

  registerProxy(proxyId: string, token: string, host: string, version?: string): ProxyRegistration {
    const existing = this.getProxy(proxyId);
    if (existing) {
      // Update existing registration — preserves registered_at
      this.db.prepare(`
        UPDATE proxies SET token = ?, host = ?, version = ?, last_heartbeat = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE proxy_id = ?
      `).run(token, host, version ?? null, proxyId);
    } else {
      // New registration
      this.db.prepare(`
        INSERT INTO proxies (proxy_id, token, host, version, last_heartbeat, registered_at)
        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      `).run(proxyId, token, host, version ?? null);
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

  /**
   * Reset last_heartbeat to now for all registered proxies.
   * Called on orchestrator startup so the stale-proxy timer doesn't
   * nuke proxies that were alive before the restart.
   */
  touchAllProxyHeartbeats(): number {
    const result = this.db.prepare(`
      UPDATE proxies SET last_heartbeat = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run();
    return result.changes;
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

  agentsWithPendingMessages(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT target_agent FROM pending_messages WHERE status = 'pending'
    `).all() as Array<Record<string, unknown>>;
    return rows.map(r => r['target_agent'] as string);
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

  getDashboardMessageById(id: number): DashboardMessage | undefined {
    const row = this.db.prepare(`
      SELECT dm.*, pm.status AS delivery_status
      FROM dashboard_messages dm
      LEFT JOIN pending_messages pm ON dm.queue_id = pm.id
      WHERE dm.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapDashboardMessageRow(row);
  }

  withdrawMessage(id: number): void {
    this.db.prepare('UPDATE dashboard_messages SET withdrawn = 1 WHERE id = ?').run(id);
  }

  cancelPendingMessage(id: number): void {
    this.db.prepare("UPDATE pending_messages SET status = 'failed', error = 'Withdrawn by sender' WHERE id = ? AND status = 'pending'").run(id);
  }

  clearDashboardMessages(agentName: string): void {
    this.db.prepare("UPDATE dashboard_messages SET archived_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE agent = ? AND archived_at IS NULL").run(agentName);
  }

  // ── Dashboard Read Cursors ──

  updateReadCursor(agent: string): void {
    // Set cursor to the max message ID for this agent (marks all current messages as read)
    this.db.prepare(`
      INSERT INTO dashboard_read_cursors (agent, last_read_msg_id)
      VALUES (?, COALESCE((SELECT MAX(id) FROM dashboard_messages WHERE agent = ?), 0))
      ON CONFLICT(agent) DO UPDATE SET last_read_msg_id = excluded.last_read_msg_id
    `).run(agent, agent);
  }

  getUnreadCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT dm.agent, COUNT(*) AS cnt
      FROM dashboard_messages dm
      LEFT JOIN dashboard_read_cursors rc ON dm.agent = rc.agent
      WHERE dm.archived_at IS NULL
        AND dm.id > COALESCE(rc.last_read_msg_id, 0)
      GROUP BY dm.agent
    `).all() as Array<Record<string, unknown>>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row['agent'] as string] = row['cnt'] as number;
    }
    return counts;
  }

  unarchiveDashboardMessages(agentName: string): void {
    this.db.prepare('UPDATE dashboard_messages SET archived_at = NULL WHERE agent = ? AND archived_at IS NOT NULL').run(agentName);
  }

  clearPendingMessages(agentName: string): void {
    this.db.prepare("DELETE FROM pending_messages WHERE target_agent = ? AND source_agent IS NULL AND status = 'pending'").run(agentName);
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

  // ── Reminders ──

  createReminder(opts: { agentName: string; createdBy?: string; prompt: string; cadenceMinutes: number }): Reminder {
    if (opts.cadenceMinutes < 5) {
      throw new Error('cadenceMinutes must be >= 5');
    }
    // Auto-assign sort_order as max(sort_order) + 1 for that agent's pending reminders
    const maxRow = this.db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM reminders WHERE agent_name = ? AND status = 'pending'"
    ).get(opts.agentName) as Record<string, unknown>;
    const nextOrder = ((maxRow['max_order'] as number) ?? -1) + 1;

    this.db.prepare(`
      INSERT INTO reminders (agent_name, created_by, prompt, cadence_minutes, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(opts.agentName, opts.createdBy ?? null, opts.prompt, opts.cadenceMinutes, nextOrder);

    const row = this.db.prepare('SELECT * FROM reminders WHERE id = last_insert_rowid()').get() as Record<string, unknown>;
    return mapReminderRow(row);
  }

  listReminders(agentName?: string): Reminder[] {
    if (agentName) {
      const rows = this.db.prepare(
        'SELECT * FROM reminders WHERE agent_name = ? ORDER BY agent_name ASC, sort_order ASC'
      ).all(agentName) as Array<Record<string, unknown>>;
      return rows.map(mapReminderRow);
    }
    const rows = this.db.prepare(
      'SELECT * FROM reminders ORDER BY agent_name ASC, sort_order ASC'
    ).all() as Array<Record<string, unknown>>;
    return rows.map(mapReminderRow);
  }

  getReminder(id: number): Reminder | undefined {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapReminderRow(row);
  }

  completeReminder(id: number): Reminder | undefined {
    this.db.prepare(
      "UPDATE reminders SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    ).run(id);
    return this.getReminder(id);
  }

  deleteReminder(id: number): boolean {
    const result = this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    return result.changes > 0;
  }

  swapReminderOrder(id1: number, id2: number): boolean {
    const r1 = this.getReminder(id1);
    const r2 = this.getReminder(id2);
    if (!r1 || !r2) return false;
    if (r1.agentName !== r2.agentName) return false;

    this.db.prepare('UPDATE reminders SET sort_order = ? WHERE id = ?').run(r2.sortOrder, id1);
    this.db.prepare('UPDATE reminders SET sort_order = ? WHERE id = ?').run(r1.sortOrder, id2);
    return true;
  }

  getTopReminder(agentName: string): Reminder | undefined {
    const row = this.db.prepare(
      "SELECT * FROM reminders WHERE agent_name = ? AND status = 'pending' ORDER BY sort_order ASC LIMIT 1"
    ).get(agentName) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapReminderRow(row);
  }

  updateReminderDelivery(id: number): void {
    this.db.prepare(
      "UPDATE reminders SET last_delivered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    ).run(id);
  }

  listDueReminders(): Reminder[] {
    // For each agent, find their top pending reminder where cadence has elapsed
    const rows = this.db.prepare(`
      SELECT r.* FROM reminders r
      INNER JOIN (
        SELECT agent_name, MIN(sort_order) AS min_order
        FROM reminders
        WHERE status = 'pending'
        GROUP BY agent_name
      ) top ON r.agent_name = top.agent_name AND r.sort_order = top.min_order
      WHERE r.status = 'pending'
        AND (r.last_delivered_at IS NULL
             OR (julianday('now') - julianday(r.last_delivered_at)) * 86400.0 >= r.cadence_minutes * 60)
    `).all() as Array<Record<string, unknown>>;
    return rows.map(mapReminderRow);
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
    agentGroup: row['agent_group'] as string | null,
    launchEnv: deserializeLaunchEnv(row['launch_env']),
    sortOrder: (row['sort_order'] as number) ?? 0,
    hookStart: row['hook_start'] as string | null,
    hookResume: row['hook_resume'] as string | null,
    hookCompact: row['hook_compact'] as string | null,
    hookExit: row['hook_exit'] as string | null,
    hookInterrupt: row['hook_interrupt'] as string | null,
    hookSubmit: row['hook_submit'] as string | null,
    hookDetectSession: row['hook_detect_session'] as string | null,
    detectSessionRegex: row['detect_session_regex'] as string | null,
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
    sourceAgent: (row['source_agent'] as string | null) ?? null,
    targetAgent: (row['target_agent'] as string | null) ?? null,
    topic: row['topic'] as string | null,
    message: row['message'] as string,
    queueId: (row['queue_id'] as number | null) ?? null,
    deliveryStatus: (row['delivery_status'] as string | null) ?? null,
    withdrawn: (row['withdrawn'] as number) === 1,
    createdAt: row['created_at'] as string,
    archivedAt: (row['archived_at'] as string | null) ?? null,
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

function mapReminderRow(row: Record<string, unknown>): Reminder {
  return {
    id: row['id'] as number,
    agentName: row['agent_name'] as string,
    createdBy: row['created_by'] as string | null,
    prompt: row['prompt'] as string,
    cadenceMinutes: row['cadence_minutes'] as number,
    sortOrder: row['sort_order'] as number,
    status: row['status'] as ReminderStatus,
    lastDeliveredAt: row['last_delivered_at'] as string | null,
    completedAt: row['completed_at'] as string | null,
    createdAt: row['created_at'] as string,
  };
}

function mapProxyRow(row: Record<string, unknown>): ProxyRegistration {
  return {
    proxyId: row['proxy_id'] as string,
    token: row['token'] as string,
    host: row['host'] as string,
    version: (row['version'] as string | null) ?? null,
    versionMatch: true, // computed by caller when orchestrator version is known
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
  agentGroup: 'agent_group',
  launchEnv: 'launch_env',
  hookStart: 'hook_start',
  hookResume: 'hook_resume',
  hookCompact: 'hook_compact',
  hookExit: 'hook_exit',
  hookInterrupt: 'hook_interrupt',
  hookSubmit: 'hook_submit',
  hookDetectSession: 'hook_detect_session',
  detectSessionRegex: 'detect_session_regex',
};

function toColumnName(key: string): string {
  const col = COLUMN_MAP[key];
  if (!col) throw new Error(`Unknown agent column: "${key}"`);
  return col;
}

function serializeLaunchEnv(value?: LaunchEnv | null): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function deserializeLaunchEnv(value: unknown): LaunchEnv | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw !== 'string') return null;
      env[key] = raw;
    }
    return env;
  } catch {
    return null;
  }
}
