/**
 * OpenAI Codex CLI adapter.
 *
 * System prompt injection uses Codex config profiles (~/.codex/config.toml)
 * instead of inline -c flags. The proxy writes a [profiles.<agent-name>]
 * section with developer_instructions in TOML triple-quoted strings, which
 * handle ALL special characters (backticks, $, !, quotes) without any
 * bash shell escaping.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class CodexAdapter implements EngineAdapter {
  readonly engine = 'codex';
  readonly canDeliverWhileActive = false;
  readonly supportsResumePrompt = true;

  /**
   * Whether this engine uses a config profile for system prompt injection.
   * When true, the orchestrator must dispatch a write_codex_profile action
   * to the proxy BEFORE pasting the spawn/resume command.
   */
  readonly usesConfigProfile = true;

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['codex', '--no-alt-screen'];

    if (opts.dangerouslySkipPermissions === true) {
      // Granular flags instead of monolithic --dangerously-bypass-approvals-and-sandbox.
      // -a never: never prompt for approval (prevents TUI hangs in unattended tmux sessions).
      // -s danger-full-access: full filesystem access (matches persona permissions: skip).
      parts.push('-a', 'never', '-s', 'danger-full-access');
    }

    if (opts.model) {
      parts.push('--model', opts.model);
    }

    // System prompt is injected via config profile, not -c flag.
    // The profile must be written before this command is pasted.
    if (opts.appendSystemPrompt) {
      parts.push('-p', opts.name);
    }

    if (opts.task) {
      parts.push(shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['codex', '--no-alt-screen', 'resume'];

    if (opts.sessionId) {
      parts.push(opts.sessionId);
    } else {
      parts.push('--last');
    }

    // System prompt via config profile
    if (opts.appendSystemPrompt) {
      parts.push('-p', opts.name);
    }

    if (opts.task) {
      parts.push(shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    // Scan from bottom, skipping empty lines and the status bar
    let foundPrompt = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Skip status bar lines (always present at bottom)
      // e.g. "gpt-5.4 xhigh · 81% left · ~/path" or "83% context left"
      if (/\d+%\s+(?:context\s+)?left/.test(line)) continue;
      // e.g. "44091 tokens" or "⏵⏵ bypass permissions on" or "current: 2.1.71"
      if (/^\d+\s+tokens/.test(line)) continue;
      if (/^[⏵⏴]/.test(line)) continue;
      if (/^current:\s/.test(line)) continue;
      // Separator lines: "────────" or "▪▪▪"
      if (/^[─━═▪]{3,}/.test(line)) continue;

      // Working indicator: "◦ Working (32s • esc to interrupt)" or "• Working"
      if (/^[◦•]\s*Working/.test(line)) return 'running_tool';

      // Running indicators (braille spinner)
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      // Codex TUI prompt: › (U+203A), ❯ (U+276F), or > followed by placeholder or empty
      if (/^[›❯>]\s/.test(line) || /^[›❯>]\s*$/.test(line)) {
        foundPrompt = true;
        continue; // keep scanning above for Working indicator
      }

      // Any other content — stop scanning
      break;
    }

    return foundPrompt ? 'waiting_for_input' : 'unknown';
  }

  parseContextPercent(paneOutput: string): ContextResult {
    // Codex status bar: "gpt-5.4 xhigh · 81% left · ~/path" or "83% context left"
    const match = paneOutput.match(/(\d+)%\s+(?:context\s+)?left/);
    if (match) {
      // Codex shows "% left" (remaining), convert to "% used"
      const remaining = parseInt(match[1]!, 10);
      return { contextPct: 100 - remaining, confident: true };
    }
    return { contextPct: null, confident: false };
  }

  buildExitCommand(): string {
    return '/exit';
  }

  buildCompactCommand(): string | null {
    // Codex CLI has no /compact equivalent — compaction is not supported.
    return null;
  }

  buildRenameCommand(_name: string): string | null {
    // Codex doesn't support /rename
    return null;
  }

  interruptKeys(): string[] {
    return ['Escape', 'Escape'];
  }

  buildSubmitCommand(task: string): string {
    return task;
  }

  submitActions(task: string): import('../../shared/types.ts').SendAction[] {
    // Codex TUI sometimes drops the first Enter after a large paste.
    // Paste the text, wait for terminal ingestion, press Enter, then
    // send a second Enter after 1s to ensure the prompt is submitted.
    return [
      { paste: task },
      { keystroke: 'Enter', post_wait_ms: 1000 },
      { keystroke: 'Enter' },
    ];
  }

  extractSessionId(_paneOutput: string): string | null {
    // Codex doesn't print session IDs in terminal output.
    // Falls back to `codex resume --last` which resumes the most recent session.
    return null;
  }

  buildDetectSessionCommand(cwd: string): string | null {
    // Find the most recently modified session file in ~/.codex/sessions/
    // that was created while in the agent's CWD. Falls back to the most
    // recent session file regardless of CWD.
    // Output: the UUID filename without the .jsonl extension.
    return `ls -t ~/.codex/sessions/*.jsonl 2>/dev/null | head -1 | xargs -r basename -s .jsonl`;
  }
}
