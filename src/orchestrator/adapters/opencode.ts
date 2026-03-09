/**
 * OpenCode CLI adapter.
 *
 * OpenCode v1.2.x behavior (validated 2026-03-08):
 *   - `opencode run "message"` — headless mode, processes message and exits
 *   - `opencode run -c "message"` — continues last session, headless
 *   - `opencode run -s <id> "message"` — continues specific session, headless
 *   - `opencode run --command /compact` — runs a slash command headlessly
 *   - `opencode` (no subcommand) — full-screen TUI, not used by orchestrator
 *   - `opencode session list` — lists session IDs (ses_xxx format)
 *
 * The orchestrator uses headless `run` mode exclusively. A task/message is
 * required — `opencode run` without a message errors. Idle detection looks
 * for the shell prompt ($) after the run completes, not an OpenCode prompt.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class OpenCodeAdapter implements EngineAdapter {
  readonly engine = 'opencode';
  readonly canDeliverWhileActive = false;
  readonly supportsResumePrompt = false;

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['opencode', 'run'];

    if (opts.model) {
      parts.push('-m', opts.model);
    }

    if (opts.thinking) {
      parts.push('--variant', opts.thinking);
    }

    if (opts.task) {
      parts.push(shellQuote(opts.task));
    } else {
      // opencode run requires a message — provide a no-op if none given
      parts.push(shellQuote('You are ready. Wait for instructions.'));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['opencode', 'run'];

    if (opts.sessionId) {
      parts.push('-s', opts.sessionId);
    } else {
      parts.push('-c');
    }

    if (opts.task) {
      parts.push(shellQuote(opts.task));
    } else {
      parts.push(shellQuote('Session resumed. Continue where you left off.'));
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    // In headless mode, opencode runs and returns to shell.
    // Scan bottom-up for shell prompt or opencode activity.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Shell prompt — opencode finished, back at shell
      if (/[\$%#]\s*$/.test(line)) return 'waiting_for_input';
      // OpenCode output header ("> model · agent")
      if (/^>\s+\S+/.test(line)) return 'running_tool';
      // Spinner
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      break;
    }

    return 'unknown';
  }

  parseContextPercent(_paneOutput: string): ContextResult {
    // OpenCode doesn't expose context percentage in headless mode
    return { contextPct: null, confident: false };
  }

  buildExitCommand(): string {
    // In headless mode, opencode exits on its own. This is a no-op fallback
    // for the orchestrator's suspend flow which pastes /exit into the pane.
    // Ctrl-C (sent as interrupt keys) is the real abort mechanism.
    return '/exit';
  }

  buildCompactCommand(): string {
    // Use --command flag for headless slash command execution
    return 'opencode run -c --command /compact';
  }

  buildRenameCommand(_name: string): string | null {
    return null;
  }

  interruptKeys(): string[] {
    return ['Escape', 'Escape'];
  }

  extractSessionId(paneOutput: string): string | null {
    // Try to extract session ID from `opencode session list` output or run output.
    // Session IDs look like: ses_32f5f6d58ffe3nGmWrOCaQVOEZ
    const match = paneOutput.match(/\b(ses_[a-zA-Z0-9]{20,})\b/);
    return match ? match[1]! : null;
  }
}
