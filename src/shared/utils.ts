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
 * HOME-relative directory where the proxy persists per-agent OpenCode
 * instruction files (`<agent-name>.md`). Cross-process contract: the
 * OpenCode adapter (orchestrator) references the file as
 * `~/{dir}/<name>.md` inside OPENCODE_CONFIG_CONTENT, and the proxy
 * writes the file under `homedir()/{dir}/`. OpenCode expands the `~/`
 * itself (sst/opencode v1.17.3 session/instruction.ts).
 */
export const OPENCODE_COLLAB_INSTRUCTIONS_DIR = '.config/opencode/collab';
