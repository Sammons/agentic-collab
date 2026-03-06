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

export function getAdapter(engine: EngineType): EngineAdapter {
  const adapter = adapters[engine];
  if (!adapter) throw new Error(`Unknown engine: ${engine}`);
  return adapter;
}
