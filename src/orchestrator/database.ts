/**
 * SQLite persistence layer using node:sqlite (DatabaseSync).
 * WAL mode, strict schemas, optimistic concurrency via version column.
 */

import { DatabaseSync } from 'node:sqlite';
import type {
  AgentRecord,
  AgentState,
  DashboardMessage,
  EngineConfigRecord,
  EngineType,
  EventRecord,
  LaunchEnv,
  MessageDirection,
  PendingMessage,
  PendingMessageStatus,
  ProxyRegistration,
  Reminder,
  ReminderStatus,
  PageRecord,
  DataStoreRecord,
  DestinationRecord,
} from '../shared/types.ts';
import {
  configColumnMap,
  mapConfigFromRow,
  configInsertColumns,
  serializeConfigParams,
  configUpsertColumns,
  configUpdateSetClause,
  serializeUpsertParams,
  buildMigrationStatements,
} from './field-registry.ts';

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
    proxy_host         TEXT, -- Deprecated: no longer read/written (proxy_host, hook_detect_session, detect_session_regex remain in schema for SQLite compat)
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

  CREATE TABLE IF NOT EXISTS engine_configs (
    name           TEXT PRIMARY KEY,
    engine         TEXT NOT NULL,
    model          TEXT,
    thinking       TEXT,
    permissions    TEXT,
    hook_start     TEXT,
    hook_resume    TEXT,
    hook_compact   TEXT,
    hook_exit      TEXT,
    hook_interrupt TEXT,
    hook_submit    TEXT,
    indicators     TEXT,
    detection      TEXT,
    launch_env     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    slug           TEXT PRIMARY KEY,
    title          TEXT,
    agent          TEXT,
    file_count     INTEGER NOT NULL DEFAULT 0,
    total_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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

    // Migrate agent columns — special cases first, then registry-driven bulk
    const agentColumns = this.db.prepare('PRAGMA table_info(agents)').all() as Array<Record<string, unknown>>;
    const agentColNames = new Set(agentColumns.map(c => c['name'] as string));

    // Special: sort_order has NOT NULL DEFAULT 0 (not a simple TEXT column)
    if (!agentColNames.has('sort_order')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    }
    // Special: hook_spawn → hook_start data migration
    if (!agentColNames.has('hook_spawn')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_spawn TEXT');
    }
    if (!agentColNames.has('hook_start')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_start TEXT');
      this.db.exec('UPDATE agents SET hook_start = hook_spawn WHERE hook_spawn IS NOT NULL');
      agentColNames.add('hook_start'); // track so registry doesn't re-add
    }
    // Special: captured_vars is a runtime field, not in the config registry
    if (!agentColNames.has('captured_vars')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN captured_vars TEXT');
    }

    // Registry-driven: adds any remaining missing config columns
    for (const stmt of buildMigrationStatements(agentColNames)) {
      this.db.exec(stmt);
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

    // Add custom_buttons column to engine_configs if not present
    const ecCols = this.db.prepare('PRAGMA table_info(engine_configs)').all() as Array<Record<string, unknown>>;
    if (!ecCols.some((c) => c['name'] === 'custom_buttons')) {
      this.db.exec('ALTER TABLE engine_configs ADD COLUMN custom_buttons TEXT');
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

    // Add skip_if_active column to reminders if not present
    const reminderColumns = this.db.prepare('PRAGMA table_info(reminders)').all() as Array<Record<string, unknown>>;
    if (!reminderColumns.some((c) => c['name'] === 'skip_if_active')) {
      this.db.exec('ALTER TABLE reminders ADD COLUMN skip_if_active INTEGER NOT NULL DEFAULT 0');
    }

    // Add indicators and detection columns to engine_configs if not present
    const ecColumns = this.db.prepare('PRAGMA table_info(engine_configs)').all() as Array<Record<string, unknown>>;
    if (ecColumns.length > 0) {
      if (!ecColumns.some((c) => c['name'] === 'indicators')) {
        this.db.exec('ALTER TABLE engine_configs ADD COLUMN indicators TEXT');
      }
      if (!ecColumns.some((c) => c['name'] === 'detection')) {
        this.db.exec('ALTER TABLE engine_configs ADD COLUMN detection TEXT');
      }
    }

    // Create data_stores table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_stores (
        name       TEXT PRIMARY KEY,
        agent      TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `);

    // Create destinations table (telegram, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS destinations (
        name       TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        config     TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
    proxyId?: string;
    agentGroup?: string;
    launchEnv?: LaunchEnv | null;
    hookStart?: string;
    hookResume?: string;
    hookCompact?: string;
    hookExit?: string;
    hookInterrupt?: string;
    hookSubmit?: string;
    customButtons?: string;
    indicators?: string;
  }): AgentRecord {
    const cols = configInsertColumns();
    const allCols = ['name', ...cols, 'state'].join(', ');
    const placeholders = ['?', ...cols.map(() => '?'), "'void'"].join(', ');
    this.db.prepare(
      `INSERT INTO agents (${allCols}) VALUES (${placeholders})`,
    ).run(opts.name, ...serializeConfigParams(opts));
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
    agentGroup?: string;
    launchEnv?: LaunchEnv | null;
    hookStart?: string;
    hookResume?: string;
    hookCompact?: string;
    hookExit?: string;
    hookInterrupt?: string;
    hookSubmit?: string;
    customButtons?: string;
    indicators?: string;
  }): AgentRecord {
    const existing = this.getAgent(opts.name);
    if (!existing) {
      return this.createAgent(opts);
    }
    // Update config fields only — preserve runtime state
    this.db.prepare(
      `UPDATE agents SET ${configUpdateSetClause()} WHERE name = ?`,
    ).run(...serializeUpsertParams(opts), opts.name);
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

  /**
   * Merge a single captured variable into the agent's captured_vars JSON map.
   * Creates the map if null, overwrites the key if already present.
   */
  updateAgentCapturedVar(name: string, varName: string, value: string): void {
    const agent = this.getAgent(name);
    if (!agent) return;
    const vars = agent.capturedVars ?? {};
    vars[varName] = value;
    this.db.prepare('UPDATE agents SET captured_vars = ? WHERE name = ?').run(
      JSON.stringify(vars),
      name,
    );
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

  getDashboardThreads(agentName?: string): Record<string, DashboardMessage[]> {
    const query = `
      SELECT dm.*, pm.status AS delivery_status
      FROM dashboard_messages dm
      LEFT JOIN pending_messages pm ON dm.queue_id = pm.id
      WHERE 1=1${agentName ? ' AND dm.agent = ?' : ''}
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

  searchMessages(query: string, agent?: string): DashboardMessage[] {
    const pattern = `%${query}%`;
    let sql = `
      SELECT dm.*, pm.status AS delivery_status
      FROM dashboard_messages dm
      LEFT JOIN pending_messages pm ON dm.queue_id = pm.id
      WHERE dm.message LIKE ?
    `;
    const params: unknown[] = [pattern];
    if (agent) {
      sql += ' AND dm.agent = ?';
      params.push(agent);
    }
    sql += ' ORDER BY dm.created_at DESC LIMIT 200';
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapDashboardMessageRow);
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
      WHERE dm.id > COALESCE(rc.last_read_msg_id, 0)
      GROUP BY dm.agent
    `).all() as Array<Record<string, unknown>>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row['agent'] as string] = row['cnt'] as number;
    }
    return counts;
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

  createReminder(opts: { agentName: string; createdBy?: string; prompt: string; cadenceMinutes: number; skipIfActive?: boolean }): Reminder {
    if (opts.cadenceMinutes < 5) {
      throw new Error('cadenceMinutes must be >= 5');
    }
    // Auto-assign sort_order as max(sort_order) + 1 for that agent's pending reminders
    const maxRow = this.db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM reminders WHERE agent_name = ? AND status = 'pending'"
    ).get(opts.agentName) as Record<string, unknown>;
    const nextOrder = ((maxRow['max_order'] as number) ?? -1) + 1;

    this.db.prepare(`
      INSERT INTO reminders (agent_name, created_by, prompt, cadence_minutes, sort_order, skip_if_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(opts.agentName, opts.createdBy ?? null, opts.prompt, opts.cadenceMinutes, nextOrder, opts.skipIfActive ? 1 : 0);

    const row = this.db.prepare('SELECT * FROM reminders WHERE id = last_insert_rowid()').get() as Record<string, unknown>;
    return mapReminderRow(row);
  }

  listReminders(agentName?: string): Reminder[] {
    const pendingRows = (agentName
      ? this.db.prepare(
          "SELECT * FROM reminders WHERE agent_name = ? AND status = 'pending' ORDER BY sort_order ASC"
        ).all(agentName)
      : this.db.prepare(
          "SELECT * FROM reminders WHERE status = 'pending' ORDER BY agent_name ASC, sort_order ASC"
        ).all()) as Array<Record<string, unknown>>;

    const completedRows = (agentName
      ? this.db.prepare(
          "SELECT * FROM reminders WHERE agent_name = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 5"
        ).all(agentName)
      : this.db.prepare(
          "SELECT * FROM reminders WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 5"
        ).all()) as Array<Record<string, unknown>>;

    return [...pendingRows, ...completedRows].map(mapReminderRow);
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

  updateReminder(id: number, opts: { prompt?: string; cadenceMinutes?: number; skipIfActive?: boolean }): Reminder | undefined {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (opts.prompt !== undefined) { sets.push('prompt = ?'); params.push(opts.prompt); }
    if (opts.cadenceMinutes !== undefined) {
      if (opts.cadenceMinutes < 5) throw new Error('cadenceMinutes must be >= 5');
      sets.push('cadence_minutes = ?'); params.push(opts.cadenceMinutes);
    }
    if (opts.skipIfActive !== undefined) { sets.push('skip_if_active = ?'); params.push(opts.skipIfActive ? 1 : 0); }
    if (sets.length === 0) return this.getReminder(id);
    params.push(id);
    this.db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getReminder(id);
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

  // ── Engine Configs ──

  createEngineConfig(opts: {
    name: string;
    engine: string;
    model?: string | null;
    thinking?: string | null;
    permissions?: string | null;
    hookStart?: string | null;
    hookResume?: string | null;
    hookCompact?: string | null;
    hookExit?: string | null;
    hookInterrupt?: string | null;
    hookSubmit?: string | null;
    indicators?: string | null;
    detection?: string | null;
    launchEnv?: Record<string, string> | null;
  }): EngineConfigRecord {
    this.db.prepare(`
      INSERT INTO engine_configs (name, engine, model, thinking, permissions, hook_start, hook_resume, hook_compact, hook_exit, hook_interrupt, hook_submit, indicators, detection, launch_env)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.name,
      opts.engine,
      opts.model ?? null,
      opts.thinking ?? null,
      opts.permissions ?? null,
      opts.hookStart ?? null,
      opts.hookResume ?? null,
      opts.hookCompact ?? null,
      opts.hookExit ?? null,
      opts.hookInterrupt ?? null,
      opts.hookSubmit ?? null,
      opts.indicators ?? null,
      opts.detection ?? null,
      opts.launchEnv ? JSON.stringify(opts.launchEnv) : null,
    );
    return this.getEngineConfig(opts.name)!;
  }

  getEngineConfig(name: string): EngineConfigRecord | null {
    const row = this.db.prepare('SELECT * FROM engine_configs WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapEngineConfigRow(row);
  }

  listEngineConfigs(): EngineConfigRecord[] {
    const rows = this.db.prepare('SELECT * FROM engine_configs ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    return rows.map(mapEngineConfigRow);
  }

  updateEngineConfig(name: string, opts: {
    engine?: string;
    model?: string | null;
    thinking?: string | null;
    permissions?: string | null;
    hookStart?: string | null;
    hookResume?: string | null;
    hookCompact?: string | null;
    hookExit?: string | null;
    hookInterrupt?: string | null;
    hookSubmit?: string | null;
    indicators?: string | null;
    detection?: string | null;
    customButtons?: string | null;
    launchEnv?: Record<string, string> | null;
  }): EngineConfigRecord | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (opts.engine !== undefined) { sets.push('engine = ?'); params.push(opts.engine); }
    if (opts.model !== undefined) { sets.push('model = ?'); params.push(opts.model); }
    if (opts.thinking !== undefined) { sets.push('thinking = ?'); params.push(opts.thinking); }
    if (opts.permissions !== undefined) { sets.push('permissions = ?'); params.push(opts.permissions); }
    if (opts.hookStart !== undefined) { sets.push('hook_start = ?'); params.push(opts.hookStart); }
    if (opts.hookResume !== undefined) { sets.push('hook_resume = ?'); params.push(opts.hookResume); }
    if (opts.hookCompact !== undefined) { sets.push('hook_compact = ?'); params.push(opts.hookCompact); }
    if (opts.hookExit !== undefined) { sets.push('hook_exit = ?'); params.push(opts.hookExit); }
    if (opts.hookInterrupt !== undefined) { sets.push('hook_interrupt = ?'); params.push(opts.hookInterrupt); }
    if (opts.hookSubmit !== undefined) { sets.push('hook_submit = ?'); params.push(opts.hookSubmit); }
    if (opts.indicators !== undefined) { sets.push('indicators = ?'); params.push(opts.indicators); }
    if (opts.detection !== undefined) { sets.push('detection = ?'); params.push(opts.detection); }
    if (opts.customButtons !== undefined) { sets.push('custom_buttons = ?'); params.push(opts.customButtons); }
    if (opts.launchEnv !== undefined) { sets.push('launch_env = ?'); params.push(opts.launchEnv ? JSON.stringify(opts.launchEnv) : null); }
    if (sets.length === 0) return this.getEngineConfig(name);
    params.push(name);
    this.db.prepare(`UPDATE engine_configs SET ${sets.join(', ')} WHERE name = ?`).run(...params);
    return this.getEngineConfig(name);
  }

  deleteEngineConfig(name: string): boolean {
    const result = this.db.prepare('DELETE FROM engine_configs WHERE name = ?').run(name);
    return result.changes > 0;
  }

  // ── Pages ──

  createPage(opts: { slug: string; title?: string; agent?: string; fileCount: number; totalBytes: number }): PageRecord {
    this.db.prepare(`
      INSERT INTO pages (slug, title, agent, file_count, total_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        agent = excluded.agent,
        file_count = excluded.file_count,
        total_bytes = excluded.total_bytes,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `).run(opts.slug, opts.title ?? null, opts.agent ?? null, opts.fileCount, opts.totalBytes);
    return this.getPage(opts.slug)!;
  }

  getPage(slug: string): PageRecord | null {
    const row = this.db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapPageRow(row);
  }

  listPages(): PageRecord[] {
    const rows = this.db.prepare('SELECT * FROM pages ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(mapPageRow);
  }

  deletePage(slug: string): boolean {
    const result = this.db.prepare('DELETE FROM pages WHERE slug = ?').run(slug);
    return result.changes > 0;
  }

  // ── Data Stores ──

  createStore(opts: { name: string; agent?: string }): DataStoreRecord {
    this.db.prepare(`
      INSERT INTO data_stores (name, agent)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET
        agent = excluded.agent,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `).run(opts.name, opts.agent ?? null);
    return this.getStore(opts.name)!;
  }

  getStore(name: string): DataStoreRecord | null {
    const row = this.db.prepare('SELECT * FROM data_stores WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapStoreRow(row);
  }

  listStores(): DataStoreRecord[] {
    const rows = this.db.prepare('SELECT * FROM data_stores ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(mapStoreRow);
  }

  touchStore(name: string): void {
    this.db.prepare("UPDATE data_stores SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE name = ?").run(name);
  }

  deleteStore(name: string): boolean {
    const result = this.db.prepare('DELETE FROM data_stores WHERE name = ?').run(name);
    return result.changes > 0;
  }

  // ── Destinations ──

  createDestination(opts: { name: string; type: string; config: Record<string, unknown> }): DestinationRecord {
    this.db.prepare(`
      INSERT INTO destinations (name, type, config)
      VALUES (?, ?, ?)
    `).run(opts.name, opts.type, JSON.stringify(opts.config));
    return this.getDestination(opts.name)!;
  }

  getDestination(name: string): DestinationRecord | null {
    const row = this.db.prepare('SELECT * FROM destinations WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapDestinationRow(row);
  }

  listDestinations(): DestinationRecord[] {
    const rows = this.db.prepare('SELECT * FROM destinations ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
    return rows.map(mapDestinationRow);
  }

  updateDestination(name: string, updates: { config?: Record<string, unknown>; enabled?: boolean }): DestinationRecord | null {
    const existing = this.getDestination(name);
    if (!existing) return null;
    if (updates.config !== undefined) {
      this.db.prepare("UPDATE destinations SET config = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE name = ?")
        .run(JSON.stringify(updates.config), name);
    }
    if (updates.enabled !== undefined) {
      this.db.prepare("UPDATE destinations SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE name = ?")
        .run(updates.enabled ? 1 : 0, name);
    }
    return this.getDestination(name);
  }

  deleteDestination(name: string): boolean {
    const result = this.db.prepare('DELETE FROM destinations WHERE name = ?').run(name);
    return result.changes > 0;
  }
}

// ── Row Mappers ──

function mapAgentRow(row: Record<string, unknown>): AgentRecord {
  // Config fields from registry (engine, model, hooks, customButtons, etc.)
  const config = mapConfigFromRow(row);
  return {
    ...config,
    // Primary key
    name: row['name'] as string,
    // Runtime state fields (not in registry)
    sortOrder: (row['sort_order'] as number) ?? 0,
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
    capturedVars: deserializeCapturedVars(row['captured_vars']),
    version: row['version'] as number,
    spawnCount: row['spawn_count'] as number,
    createdAt: row['created_at'] as string,
  } as AgentRecord;
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
    skipIfActive: (row['skip_if_active'] as number) === 1,
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

function mapEngineConfigRow(row: Record<string, unknown>): EngineConfigRecord {
  let launchEnv: Record<string, string> | null = null;
  const rawEnv = row['launch_env'];
  if (typeof rawEnv === 'string' && rawEnv.length > 0) {
    try {
      const parsed = JSON.parse(rawEnv);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const env: Record<string, string> = {};
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === 'string') env[key] = val;
        }
        launchEnv = env;
      }
    } catch { /* ignore */ }
  }
  return {
    name: row['name'] as string,
    engine: row['engine'] as string,
    model: (row['model'] as string | null) ?? null,
    thinking: (row['thinking'] as string | null) ?? null,
    permissions: (row['permissions'] as string | null) ?? null,
    hookStart: (row['hook_start'] as string | null) ?? null,
    hookResume: (row['hook_resume'] as string | null) ?? null,
    hookCompact: (row['hook_compact'] as string | null) ?? null,
    hookExit: (row['hook_exit'] as string | null) ?? null,
    hookInterrupt: (row['hook_interrupt'] as string | null) ?? null,
    hookSubmit: (row['hook_submit'] as string | null) ?? null,
    indicators: (row['indicators'] as string | null) ?? null,
    detection: (row['detection'] as string | null) ?? null,
    customButtons: (row['custom_buttons'] as string | null) ?? null,
    launchEnv,
    createdAt: row['created_at'] as string,
  };
}

function mapPageRow(row: Record<string, unknown>): PageRecord {
  return {
    slug: row['slug'] as string,
    title: (row['title'] as string | null) ?? null,
    agent: (row['agent'] as string | null) ?? null,
    fileCount: (row['file_count'] as number) ?? 0,
    totalBytes: (row['total_bytes'] as number) ?? 0,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function mapStoreRow(row: Record<string, unknown>): DataStoreRecord {
  return {
    name: row['name'] as string,
    agent: (row['agent'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function mapDestinationRow(row: Record<string, unknown>): DestinationRecord {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row['config'] as string); } catch { /* empty */ }
  return {
    name: row['name'] as string,
    type: row['type'] as string,
    config,
    enabled: (row['enabled'] as number) === 1,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

/** camelCase → snake_case for updateAgentState extra fields. */
const COLUMN_MAP: Record<string, string> = {
  // Runtime fields (not in config registry)
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
  capturedVars: 'captured_vars',
  // Config fields from registry
  ...configColumnMap(),
};

function toColumnName(key: string): string {
  const col = COLUMN_MAP[key];
  if (!col) throw new Error(`Unknown agent column: "${key}"`);
  return col;
}

function deserializeCapturedVars(value: unknown): Record<string, string> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const vars: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw !== 'string') return null;
      vars[key] = raw;
    }
    return vars;
  } catch {
    return null;
  }
}
