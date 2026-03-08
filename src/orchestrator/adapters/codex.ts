/**
 * OpenAI Codex CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

/**
 * Build the `-c 'developer_instructions="..."'` flag for Codex.
 *
 * Codex parses the value as TOML, so internal double quotes and backslashes
 * must be escaped for TOML. The entire `-c` argument is then shell-quoted.
 */
function buildDeveloperInstructionsFlag(prompt: string): string {
  // Escape for TOML: backslashes first, then double quotes, then newlines
  const tomlSafe = prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `-c developer_instructions="${tomlSafe}"`;
}

export class CodexAdapter implements EngineAdapter {
  readonly engine = 'codex';
  readonly canDeliverWhileActive = false;

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['codex'];

    if (opts.dangerouslySkipPermissions === true) {
      parts.push('--dangerously-bypass-approvals-and-sandbox');
    }

    if (opts.model) {
      parts.push('--model', opts.model);
    }

    if (opts.appendSystemPrompt) {
      parts.push(buildDeveloperInstructionsFlag(opts.appendSystemPrompt));
    }

    if (opts.task) {
      parts.push(shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['codex', 'resume'];

    if (opts.sessionId) {
      parts.push(opts.sessionId);
    } else {
      parts.push('--last');
    }

    if (opts.appendSystemPrompt) {
      parts.push(buildDeveloperInstructionsFlag(opts.appendSystemPrompt));
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
      // e.g. "gpt-5.4 xhigh · 81% left · ~/path" or "tab to queue message ... 83% context left"
      if (/\d+%\s+(?:context\s+)?left/.test(line)) continue;

      // Working indicator: "◦ Working (32s • esc to interrupt)" or "• Working"
      if (/^[◦•]\s*Working/.test(line)) return 'running_tool';

      // Running indicators (braille spinner)
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      // Codex TUI prompt: › (U+203A) or > followed by placeholder or empty
      if (/^[›>]\s/.test(line) || /^[›>]\s*$/.test(line)) {
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

  buildCompactCommand(): string {
    return '/compact';
  }

  buildRenameCommand(_name: string): string | null {
    // Codex doesn't support /rename
    return null;
  }

  interruptKeys(): string[] {
    return ['Escape', 'Escape'];
  }

  extractSessionId(_paneOutput: string): string | null {
    // Codex doesn't print session IDs in terminal output.
    // Falls back to `codex resume --last` which resumes the most recent session.
    return null;
  }
}

