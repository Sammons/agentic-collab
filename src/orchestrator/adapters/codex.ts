/**
 * OpenAI Codex CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote } from '../../shared/utils.ts';

export class CodexAdapter implements EngineAdapter {
  readonly engine = 'codex';

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['codex'];

    if (opts.model) {
      parts.push('--model', opts.model);
    }

    if (opts.task) {
      parts.push(shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    // Codex doesn't have native resume — start new session in same cwd
    const parts = ['codex'];

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

      // Codex shows a prompt when waiting
      if (/^>\s*$/.test(line) || /codex.*>\s*$/.test(line)) return 'waiting_for_input';

      // Running indicators
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      break;
    }

    return 'unknown';
  }

  parseContextPercent(_paneOutput: string): ContextResult {
    // Codex doesn't expose context percentage in status bar
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
}

