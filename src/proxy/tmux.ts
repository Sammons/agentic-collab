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
  exec(`tmux new-session -d -s '${esc(sessionName)}' -c '${esc(cwd)}'`);
}

export function hasSession(sessionName: string): boolean {
  try {
    exec(`tmux has-session -t '${esc(sessionName)}'`);
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName: string): void {
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
export function pasteText(sessionName: string, text: string, pressEnter: boolean): void {
  // Pass text via stdin (input option) to avoid all shell escaping issues
  execSync('tmux load-buffer -', { ...EXEC_OPTS, input: text });
  exec(`tmux paste-buffer -t '${esc(sessionName)}'`);

  if (pressEnter) {
    // Wait 500ms then press Enter (as per spec)
    execSync('sleep 0.5', { timeout: 5000 });
    exec(`tmux send-keys -t '${esc(sessionName)}' Enter`);
  }
}

/**
 * Capture the last N lines from the tmux pane.
 */
export function capturePaneLines(sessionName: string, lines: number): string {
  return exec(`tmux capture-pane -t '${esc(sessionName)}' -p -S -${lines}`);
}

/**
 * Send raw keys to a tmux session.
 */
export function sendKeys(sessionName: string, keys: string): void {
  exec(`tmux send-keys -t '${esc(sessionName)}' '${esc(keys)}'`);
}

/**
 * Escape single quotes for shell.
 */
function esc(s: string): string {
  return s.replace(/'/g, "'\\''");
}
