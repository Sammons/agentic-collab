/**
 * Claude Code CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class ClaudeAdapter implements EngineAdapter {
  readonly engine = 'claude';

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['claude'];

    if (opts.dangerouslySkipPermissions === true) {
      parts.push('--dangerously-skip-permissions');
    }

    if (opts.model) {
      parts.push('--model', opts.model);
    }

    if (opts.appendSystemPrompt) {
      parts.push('--append-system-prompt', shellQuote(opts.appendSystemPrompt));
    }

    if (opts.task) {
      // -p for initial prompt in interactive mode (NOT --print which exits after)
      parts.push('-p', shellQuote(opts.task));
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

    // Search bottom-up through captured lines
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Claude Code shows ">" prompt when waiting for input
      if (/^>\s*$/.test(line)) return 'waiting_for_input';

      // Claude shows tool execution indicators
      if (/^\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|WebFetch|WebSearch)\s/.test(line)) return 'running_tool';
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      // Streaming output (partial lines, thinking indicators)
      if (/^\.{2,}$/.test(line)) return 'streaming';
      if (/thinking/i.test(line) && /\.\.\./i.test(line)) return 'streaming';

      // If we see a prompt-like pattern, it's waiting
      if (/claude.*>\s*$/.test(line)) return 'waiting_for_input';

      // If we see content that looks like generated text, streaming
      if (i === lines.length - 1 && line.length > 0) {
        // Last non-empty line without a prompt — could be streaming or unknown
        break;
      }
    }

    return 'unknown';
  }

  parseContextPercent(paneOutput: string): ContextResult {
    const lines = paneOutput.split('\n');

    // Search bottom-up for status bar with context percentage
    // Claude Code shows "XX% context used" in status bar
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const line = lines[i] ?? '';
      const match = line.match(/(\d+)%\s*context/i);
      if (match) {
        return { contextPct: parseInt(match[1]!, 10), confident: true };
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
}

