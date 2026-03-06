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
  ProxyRegistration,
  WorkstreamRecord,
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

  CREATE TABLE IF NOT EXISTS workstreams (
    name       TEXT PRIMARY KEY,
    goal       TEXT NOT NULL,
    plan       TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS workstream_agents (
    workstream TEXT NOT NULL REFERENCES workstreams(name) ON DELETE CASCADE,
    agent      TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    PRIMARY KEY (workstream, agent)
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
`;

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
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
    proxyId?: string;
  }): AgentRecord {
    this.db.prepare(`
      INSERT INTO agents (name, engine, model, thinking, cwd, persona, proxy_id, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'void')
    `).run(
      opts.name,
      opts.engine,
      opts.model ?? null,
      opts.thinking ?? null,
      opts.cwd,
      opts.persona ?? null,
      opts.proxyId ?? null,
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
    let rows: Array<Record<string, unknown>>;
    if (agentName) {
      rows = this.db.prepare(
        'SELECT * FROM dashboard_messages WHERE agent = ? ORDER BY created_at ASC'
      ).all(agentName) as Array<Record<string, unknown>>;
    } else {
      rows = this.db.prepare(
        'SELECT * FROM dashboard_messages ORDER BY created_at ASC'
      ).all() as Array<Record<string, unknown>>;
    }

    const threads: Record<string, DashboardMessage[]> = {};
    for (const row of rows) {
      const msg = mapDashboardMessageRow(row);
      if (!threads[msg.agent]) threads[msg.agent] = [];
      threads[msg.agent]!.push(msg);
    }
    return threads;
  }

  // ── Workstreams ──

  createWorkstream(name: string, goal: string, plan?: string): WorkstreamRecord {
    this.db.prepare(`
      INSERT INTO workstreams (name, goal, plan) VALUES (?, ?, ?)
    `).run(name, goal, plan ?? null);
    return this.getWorkstream(name)!;
  }

  getWorkstream(name: string): WorkstreamRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workstreams WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapWorkstreamRow(row);
  }

  listWorkstreams(): WorkstreamRecord[] {
    const rows = this.db.prepare('SELECT * FROM workstreams ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map(mapWorkstreamRow);
  }

  addAgentToWorkstream(workstream: string, agent: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO workstream_agents (workstream, agent) VALUES (?, ?)
    `).run(workstream, agent);
  }

  getWorkstreamAgents(workstream: string): string[] {
    const rows = this.db.prepare(
      'SELECT agent FROM workstream_agents WHERE workstream = ? ORDER BY agent'
    ).all(workstream) as Array<Record<string, unknown>>;
    return rows.map((r) => r['agent'] as string);
  }

  // ── Proxies ──

  registerProxy(proxyId: string, token: string, host: string): ProxyRegistration {
    this.db.prepare(`
      INSERT OR REPLACE INTO proxies (proxy_id, token, host, last_heartbeat, registered_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    `).run(proxyId, token, host);
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
    createdAt: row['created_at'] as string,
  };
}

function mapWorkstreamRow(row: Record<string, unknown>): WorkstreamRecord {
  return {
    name: row['name'] as string,
    goal: row['goal'] as string,
    plan: row['plan'] as string | null,
    status: row['status'] as string,
    createdAt: row['created_at'] as string,
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
