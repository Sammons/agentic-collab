/**
 * OpenCode CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult, type ElicitationResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class OpenCodeAdapter implements EngineAdapter {
  readonly engine = 'opencode';
  readonly canDeliverWhileActive = false;

  buildSpawnCommand(opts: SpawnOptions): string {
    // opencode TUI mode for interactive sessions; 'run' subcommand for headless
    // We use the default TUI subcommand with flags from 'run' since they share them
    const parts = ['opencode', 'run'];

    if (opts.model) {
      parts.push('-m', opts.model);
    }

    // --variant controls reasoning effort in opencode (e.g., high, max, minimal)
    if (opts.thinking) {
      parts.push('--variant', opts.thinking);
    }

    if (opts.task) {
      // Task is a positional argument to 'opencode run'
      parts.push(shellQuote(opts.task));
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
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      if (/^>\s*$/.test(line) || /opencode.*>\s*$/.test(line)) return 'waiting_for_input';
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      break;
    }

    return 'unknown';
  }

  parseContextPercent(_paneOutput: string): ContextResult {
    // OpenCode doesn't expose context percentage
    return { contextPct: null, confident: false };
  }

  buildExitCommand(): string {
    return '/exit';
  }

  buildCompactCommand(): string {
    return '/compact';
  }

  buildRenameCommand(_name: string): string | null {
    return null;
  }

  interruptKeys(): string[] {
    return ['Escape', 'Escape'];
  }

  detectElicitation(_paneOutput: string): ElicitationResult | null {
    return null;
  }
}

