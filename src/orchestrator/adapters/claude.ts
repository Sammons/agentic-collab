/**
 * Claude Code CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class ClaudeAdapter implements EngineAdapter {
  readonly engine = 'claude';
  readonly canDeliverWhileActive = true;
  readonly supportsResumePrompt = false;

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['claude'];

    if (opts.dangerouslySkipPermissions === true) {
      parts.push('--dangerously-skip-permissions');
    }

    if (opts.model) {
      parts.push('--model', opts.model);
    }

    // Claude Code uses --effort for reasoning effort (low, medium, high)
    if (opts.thinking) {
      parts.push('--effort', opts.thinking);
    }

    // Pre-set session ID so we can resume later without parsing output
    if (opts.sessionId) {
      parts.push('--session-id', opts.sessionId);
    }

    if (opts.appendSystemPrompt) {
      parts.push('--append-system-prompt', shellQuote(opts.appendSystemPrompt));
    }

    if (opts.task) {
      // Positional argument for initial prompt in interactive mode.
      // Do NOT use -p/--print — that exits after the first response.
      parts.push(shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['claude', '--resume', opts.sessionId];

    if (opts.appendSystemPrompt) {
      parts.push('--append-system-prompt', shellQuote(opts.appendSystemPrompt));
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    // Search bottom-up through captured lines, skipping the status bar
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Skip status bar lines (token counts, version info, permission mode, /ide hints, context warnings)
      if (/\d+\s*tokens/.test(line)) continue;
      if (/current:.*latest:/.test(line)) continue;
      if (/bypass permissions/.test(line)) continue;
      if (/\/ide\s/.test(line)) continue;
      if (/Context left until/.test(line)) continue;
      if (/Remote Control/.test(line)) continue;

      // Claude Code shows "❯" (U+276F) or ">" prompt when waiting for input.
      // The prompt line may contain only the prompt character and whitespace.
      if (/^[\u276f>]\s*$/.test(line)) return 'waiting_for_input';

      // Horizontal rule separators (─ U+2500) around the input area
      if (/^[\u2500\u25aa\s]+$/.test(line)) continue;

      // Claude shows tool execution indicators
      if (/^\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|WebFetch|WebSearch)\s/.test(line)) return 'running_tool';
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      // Streaming output (partial lines, thinking indicators)
      if (/^\.{2,}$/.test(line)) return 'streaming';
      if (/thinking/i.test(line) && /\.\.\./i.test(line)) return 'streaming';

      // If we see a prompt-like pattern (e.g. "claude>"), it's waiting
      if (/claude.*[>\u276f]\s*$/.test(line)) return 'waiting_for_input';

      // If we hit actual content, it's not idle
      break;
    }

    return 'unknown';
  }

  parseContextPercent(paneOutput: string): ContextResult {
    const lines = paneOutput.split('\n');

    // Search bottom-up for status bar indicators.
    // Claude Code v2.x shows token count ("NNNNN tokens") in the status bar.
    // Older versions may show "XX% context used".
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const line = lines[i] ?? '';

      // Percentage format: "XX% context"
      const pctMatch = line.match(/(\d+)%\s*context/i);
      if (pctMatch) {
        return { contextPct: parseInt(pctMatch[1]!, 10), confident: true };
      }

      // Token count format: "NNNNN tokens" — estimate percentage from 200k context window
      const tokenMatch = line.match(/(\d[\d,]*)\s*tokens/);
      if (tokenMatch) {
        const tokens = parseInt(tokenMatch[1]!.replace(/,/g, ''), 10);
        const maxTokens = 200_000; // Claude's context window
        const pct = Math.min(100, Math.round((tokens / maxTokens) * 100));
        return { contextPct: pct, confident: true };
      }
    }

    return { contextPct: null, confident: false };
  }

  buildExitCommand(): string {
    return '/exit';
  }

  buildCompactCommand(): string {
    return '/compact';
  }

  buildRenameCommand(name: string): string | null {
    return `/rename ${name}`;
  }

  interruptKeys(): string[] {
    return ['Escape', 'Escape', 'Escape'];
  }

  extractSessionId(_paneOutput: string): string | null {
    // Claude uses --session-id at spawn time, so we don't need to parse output.
    return null;
  }
}

