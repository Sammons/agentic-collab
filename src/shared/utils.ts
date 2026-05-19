/**
 * Shared utility functions.
 */

/** POSIX-safe shell quoting. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Default on-disk prefix used by the v3 worktree convention (`wt-<id>`).
 * Shared so Q3 (spawn-side) and Q8 (sweep-side) stay in sync if the prefix
 * ever changes.
 */
export const DEFAULT_WORKTREE_PREFIX = /^wt-/;
