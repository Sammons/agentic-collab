/**
 * OpenCode CLI adapter — persistent TUI mode.
 *
 * OpenCode v1.2.x behavior (validated 2026-03-08 via tmux TUI testing):
 *   - `opencode` — launches full-screen Bubble Tea TUI (persistent session)
 *   - `opencode -s <id>` — resumes specific session in TUI mode
 *   - `opencode -c` — resumes last session in TUI mode
 *   - `opencode -m <model>` — selects model at launch
 *   - `opencode --variant <thinking>` — selects thinking variant
 *
 * TUI interaction patterns (all via tmux send-keys):
 *   - Input: type message + Enter to submit
 *   - Compact: Ctrl-X then C (chord sequence)
 *   - Exit: Ctrl-C (prints session ID on exit: "Continue  opencode -s ses_xxx")
 *   - Rename: Ctrl-R then type name + Enter
 *   - Interrupt: Escape
 *   - Command palette: Ctrl-P
 *
 * Idle detection:
 *   - Active: "esc interrupt" visible in bottom-left of pane
 *   - Idle: "esc interrupt" absent, input box ready
 *
 * Context parsing:
 *   - Sidebar shows "NNN tokens" and "N% used"
 *
 * Session IDs:
 *   - On exit (Ctrl-C), OpenCode prints: "Continue  opencode -s ses_xxx"
 *   - Format: ses_[a-zA-Z0-9]{20,}
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';

export class OpenCodeAdapter implements EngineAdapter {
  readonly engine = 'opencode';
  readonly canDeliverWhileActive = false;
  readonly supportsResumePrompt = false;

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['opencode'];

    if (opts.model) {
      parts.push('-m', opts.model);
    }

    if (opts.thinking) {
      parts.push('--variant', opts.thinking);
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['opencode'];

    if (opts.sessionId) {
      parts.push('-s', opts.sessionId);
    } else {
      // -c does not reliably resume in TUI mode (may create a new empty session).
      // Without a session ID, launch a fresh TUI. The orchestrator should always
      // have a session ID from extractSessionId() after exit.
      // Fall through to plain 'opencode' — better than a broken -c resume.
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    // Scan bottom-up for TUI state indicators.
    // "esc interrupt" in the bottom-left means the engine is active/generating.
    // Its absence means the input box is ready for the next message.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Active: "esc interrupt" visible during generation
      if (/esc\s+interrupt/i.test(line)) return 'running_tool';
      // Spinner in output area
      if (SPINNER_REGEX.test(line)) return 'running_tool';
      // Status bar with "ctrl+t variants" indicates idle TUI with input ready
      if (/ctrl\+t\s+variants/i.test(line)) return 'waiting_for_input';
      // "Ask anything" placeholder in input box — idle
      if (/ask anything/i.test(line)) return 'waiting_for_input';

      break;
    }

    // Fallback: scan more broadly (not just last non-empty line)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i]!.trim();
      if (/esc\s+interrupt/i.test(line)) return 'running_tool';
      if (/ctrl\+t\s+variants/i.test(line)) return 'waiting_for_input';
      if (/ctrl\+p\s+commands/i.test(line)) return 'waiting_for_input';
    }

    return 'unknown';
  }

  parseContextPercent(paneOutput: string): ContextResult {
    // OpenCode TUI sidebar shows "N% used"
    const pctMatch = paneOutput.match(/(\d+)%\s+used/);
    if (pctMatch) {
      return { contextPct: parseInt(pctMatch[1]!, 10), confident: true };
    }

    // Also shows "NNN tokens" — can't convert to % without knowing the max,
    // but the presence indicates context is being tracked
    const tokenMatch = paneOutput.match(/([\d,]+)\s+tokens/);
    if (tokenMatch) {
      // Can't compute percentage without knowing model context window
      return { contextPct: null, confident: false };
    }

    return { contextPct: null, confident: false };
  }

  buildExitCommand(): string {
    // Fallback for paste-based delivery. In practice, exitKeys() is used instead.
    return '/exit';
  }

  exitKeys(): string[] {
    // Ctrl-C exits the TUI cleanly and prints session ID for resume
    return ['C-c'];
  }

  buildCompactCommand(): string {
    // Fallback for paste-based delivery. In practice, compactKeys() is used instead.
    return '/compact';
  }

  compactKeys(): string[] {
    // Ctrl-X then C triggers "Compact session" in the TUI command palette
    return ['C-x', 'c'];
  }

  buildRenameCommand(_name: string): string | null {
    // OpenCode supports rename via Ctrl-R, but it opens an interactive rename
    // dialog that requires typing the name and pressing Enter. The lifecycle
    // currently only supports paste-based rename (returns string to paste).
    // TODO: add renameKeys() support to lifecycle for keystroke-based rename
    return null;
  }

  interruptKeys(): string[] {
    return ['Escape'];
  }

  extractSessionId(paneOutput: string): string | null {
    // On Ctrl-C exit, OpenCode prints: "Continue  opencode -s ses_xxx"
    // Also visible in `opencode session list` output.
    const match = paneOutput.match(/\b(ses_[a-zA-Z0-9]{20,})\b/);
    return match ? match[1]! : null;
  }
}
