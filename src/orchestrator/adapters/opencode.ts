/**
 * OpenCode CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class OpenCodeAdapter implements EngineAdapter {
  readonly engine = 'opencode';

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['opencode'];

    if (opts.model) {
      parts.push('--model', opts.model);
    }

    if (opts.task) {
      parts.push('--prompt', shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['opencode'];

    // OpenCode supports session resume via --session
    if (opts.sessionId) {
      parts.push('--session', opts.sessionId);
    } else {
      parts.push('--continue');
    }

    if (opts.task) {
      parts.push('--prompt', shellQuote(opts.task));
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
}

