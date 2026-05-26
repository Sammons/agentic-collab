/**
 * Engine adapter registry.
 */

import type { EngineAdapter } from './types.ts';
import type { EngineType } from '../../shared/types.ts';
import { ClaudeAdapter } from './claude.ts';
import { CodexAdapter } from './codex.ts';
import { OpenCodeAdapter } from './opencode.ts';

export type { EngineAdapter, IdleState, ContextResult, SpawnOptions, ResumeOptions } from './types.ts';

const adapters: Record<EngineType, EngineAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
};

// Optional resolver for custom engine names (e.g. "claude-with-home" → "claude").
// Set at module init via setCustomEngineResolver so we don't need to thread
// `db` through every getAdapter call site. Returns the underlying EngineType
// or null when the name isn't a known custom engine.
let customEngineResolver: ((name: string) => EngineType | null) | null = null;

export function setCustomEngineResolver(resolver: (name: string) => EngineType | null): void {
  customEngineResolver = resolver;
}

export function getAdapter(engine: string): EngineAdapter {
  const direct = adapters[engine as EngineType];
  if (direct) return direct;

  // Custom engine: look it up via the resolver (typically engine_configs DB).
  const underlying = customEngineResolver?.(engine);
  if (underlying) {
    const resolved = adapters[underlying];
    if (resolved) return resolved;
  }

  throw new Error(`Unknown engine: ${engine}`);
}
