/**
 * SQLite-based timed locks for agent pane access.
 * Every lock acquisition gets a unique ID. Locks expire automatically.
 * Contention results in a poll-wait, not an eager failure.
 *
 * Uses epoch milliseconds (INTEGER) for expiry to avoid datetime resolution issues.
 */

import type { DatabaseSync } from 'node:sqlite';
import { generateToken } from './sanitize.ts';

const LOCK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_locks (
    agent_name  TEXT PRIMARY KEY,
    locked_by   TEXT NOT NULL,
    locked_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
`;

const DEFAULT_DURATION_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;

export class LockManager {
  private db: DatabaseSync;
  private stmts: {
    deleteExpired: ReturnType<DatabaseSync['prepare']>;
    insertLock: ReturnType<DatabaseSync['prepare']>;
    deleteLock: ReturnType<DatabaseSync['prepare']>;
    forceDelete: ReturnType<DatabaseSync['prepare']>;
    selectOne: ReturnType<DatabaseSync['prepare']>;
    selectAll: ReturnType<DatabaseSync['prepare']>;
    selectHolder: ReturnType<DatabaseSync['prepare']>;
  };

  constructor(db: DatabaseSync) {
    db.exec(LOCK_SCHEMA);
    this.db = db;
    this.stmts = {
      deleteExpired: db.prepare(`DELETE FROM agent_locks WHERE expires_at < ?`),
      insertLock: db.prepare(`INSERT OR IGNORE INTO agent_locks (agent_name, locked_by, locked_at, expires_at) VALUES (?, ?, ?, ?)`),
      deleteLock: db.prepare(`DELETE FROM agent_locks WHERE agent_name = ? AND locked_by = ?`),
      forceDelete: db.prepare(`DELETE FROM agent_locks WHERE agent_name = ?`),
      selectOne: db.prepare(`SELECT 1 FROM agent_locks WHERE agent_name = ? AND expires_at >= ?`),
      selectAll: db.prepare(`SELECT * FROM agent_locks WHERE expires_at >= ? ORDER BY agent_name`),
      selectHolder: db.prepare(`SELECT locked_by, locked_at, expires_at FROM agent_locks WHERE agent_name = ?`),
    };
  }

  /**
   * Acquire a lock on an agent. Returns a unique lock ID.
   * Polls until the lock is acquired or timeout is reached.
   */
  async lock(agentName: string, durationMs = DEFAULT_DURATION_MS, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const lockId = `lock-${generateToken().slice(0, 16)}`;
    const start = Date.now();

    while (true) {
      const now = Date.now();

      // Clear expired locks
      this.stmts.deleteExpired.run(now);

      // Try to acquire
      const expiresAt = now + durationMs;
      const result = this.stmts.insertLock.run(agentName, lockId, now, expiresAt);

      if (result.changes > 0) return lockId;

      if (now - start > timeoutMs) {
        const holder = this.stmts.selectHolder.get(agentName) as Record<string, unknown> | undefined;
        const info = holder
          ? ` (held by ${holder['locked_by']} since ${new Date(holder['locked_at'] as number).toISOString()}, expires ${new Date(holder['expires_at'] as number).toISOString()})`
          : '';
        throw new Error(`Lock timeout for agent "${agentName}" after ${timeoutMs}ms${info}`);
      }

      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /**
   * Release a lock. Requires the lock ID returned by lock().
   * Returns true if the lock was actually released, false if already expired/released.
   */
  unlock(agentName: string, lockId: string): boolean {
    const result = this.stmts.deleteLock.run(agentName, lockId);
    return result.changes > 0;
  }

  /**
   * Execute a function while holding a lock on an agent.
   */
  async withLock<T>(agentName: string, fn: () => T | Promise<T>, durationMs?: number, timeoutMs?: number): Promise<T> {
    const lockId = await this.lock(agentName, durationMs, timeoutMs);
    try {
      return await fn();
    } finally {
      this.unlock(agentName, lockId);
    }
  }

  /**
   * Check if an agent is currently locked (non-expired).
   */
  isLocked(agentName: string): boolean {
    const row = this.stmts.selectOne.get(agentName, Date.now());
    return row !== undefined;
  }

  /**
   * Force-clear a lock (for cleanup/testing). No lockId required.
   */
  forceUnlock(agentName: string): void {
    this.stmts.forceDelete.run(agentName);
  }

  /**
   * List all active (non-expired) locks.
   */
  listLocks(): Array<{ agentName: string; lockedBy: string; lockedAt: string; expiresAt: string }> {
    const now = Date.now();
    const rows = this.stmts.selectAll.all(now) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      agentName: r['agent_name'] as string,
      lockedBy: r['locked_by'] as string,
      lockedAt: new Date(r['locked_at'] as number).toISOString(),
      expiresAt: new Date(r['expires_at'] as number).toISOString(),
    }));
  }
}
