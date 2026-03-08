/**
 * Tmux operations. Runs on the host machine.
 * All tmux commands executed via child_process.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 10_000 };

function exec(cmd: string): string {
  try {
    return (execSync(cmd, EXEC_OPTS) as string).trim();
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`tmux command failed: ${cmd}\n${msg}`);
  }
}

export function createSession(sessionName: string, cwd: string): void {
  validateSessionName(sessionName);
  // Unset CLAUDECODE so spawned Claude Code instances don't think they're nested.
  // The proxy may itself be launched from within a Claude Code session.
  // Explicitly pass PATH so engines like Codex that spawn sub-shells don't lose
  // the collab bin directory that the proxy prepended at startup.
  const path = process.env['PATH'] ?? '';
  exec(`tmux new-session -d -s '${esc(sessionName)}' -c '${esc(cwd)}' -e CLAUDECODE= -e PATH='${esc(path)}'`);
}

export function hasSession(sessionName: string): boolean {
  validateSessionName(sessionName);
  try {
    exec(`tmux has-session -t '${esc(sessionName)}'`);
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName: string): void {
  validateSessionName(sessionName);
  try {
    exec(`tmux kill-session -t '${esc(sessionName)}'`);
  } catch {
    // Session may already be gone
  }
}

export function listSessions(): string[] {
  try {
    const output = exec("tmux list-sessions -F '#{session_name}'");
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Paste text into a tmux pane via load-buffer + paste-buffer.
 * Optionally press Enter after pasting.
 */
// Delay between paste and Enter to let tmux flush the buffer to the pane
const PASTE_ENTER_DELAY_MS = 500;

export async function pasteText(sessionName: string, text: string, pressEnter: boolean): Promise<void> {
  validateSessionName(sessionName);
  // Pass text via stdin (input option) to avoid all shell escaping issues
  execSync('tmux load-buffer -', { ...EXEC_OPTS, input: text });
  exec(`tmux paste-buffer -t '${esc(sessionName)}'`);

  if (pressEnter) {
    await new Promise<void>((r) => setTimeout(r, PASTE_ENTER_DELAY_MS));
    exec(`tmux send-keys -t '${esc(sessionName)}' Enter`);
  }
}

/**
 * Capture the last N lines from the tmux pane.
 */
export function capturePaneLines(sessionName: string, lines: number): string {
  validateSessionName(sessionName);
  const safeLines = Math.max(1, Math.min(Math.floor(lines) || 50, 10000));
  return exec(`tmux capture-pane -t '${esc(sessionName)}' -p -S -${safeLines}`);
}

/**
 * Get the last activity timestamp for a tmux session pane.
 * Returns Unix timestamp (seconds) from tmux's #{window_activity}.
 */
export function paneActivity(sessionName: string): number {
  validateSessionName(sessionName);
  const output = exec(`tmux display-message -t '${esc(sessionName)}' -p '#{window_activity}'`);
  const ts = parseInt(output, 10);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Send raw keys to a tmux session.
 * Keys are validated to prevent shell injection — only known tmux key names
 * and safe patterns (e.g. "Escape Escape Escape", "C-c", "Enter") are allowed.
 */
const SAFE_KEYS_RE = /^[a-zA-Z0-9 -]+$/;

export function sendKeys(sessionName: string, keys: string): void {
  validateSessionName(sessionName);
  if (!SAFE_KEYS_RE.test(keys)) {
    throw new Error(`Invalid keys: "${keys}" — only alphanumeric, spaces, and hyphens allowed`);
  }
  exec(`tmux send-keys -t '${esc(sessionName)}' ${keys}`);
}

/**
 * Validate tmux session name — only allow safe characters.
 */
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: "${name}" — only [a-zA-Z0-9_-] allowed`);
  }
}

/**
 * Escape single quotes for shell.
 */
function esc(s: string): string {
  return s.replace(/'/g, "'\\''");
}
