/**
 * Unified hook resolver.
 *
 * Every hookable lifecycle operation (start, resume, exit, compact, interrupt, submit)
 * resolves through this module. Hook values from persona frontmatter support three modes:
 *
 *   1. null / undefined  → implicit preset behavior (adapter default)
 *   2. "preset:<engine>" → explicit adapter method call
 *   3. "file:<path>"     → read script file content and paste it
 *   4. bare string       → inline command or keys (auto-detected)
 *
 * The resolver returns a HookResult describing how the lifecycle should deliver the command.
 */

import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { EngineAdapter, SpawnOptions, ResumeOptions } from './adapters/types.ts';
import type { AgentRecord } from '../shared/types.ts';
import { getAdapter } from './adapters/index.ts';

// ── Result Types ──

export type HookResult =
  | { mode: 'paste'; text: string }
  | { mode: 'keys'; keys: string[] }
  | { mode: 'skip' };

// ── Hook Fields ──

export type HookField = 'start' | 'resume' | 'exit' | 'compact' | 'interrupt' | 'submit';

// ── Context for resolution ──

export type HookContext = {
  /** SpawnOptions for start hooks */
  spawnOpts?: SpawnOptions;
  /** ResumeOptions for resume hooks */
  resumeOpts?: ResumeOptions;
  /** Task text for submit hooks */
  task?: string;
};

// ── Resolver ──

/**
 * Resolve a hook value to a concrete action.
 *
 * @param field   Which lifecycle operation (start, resume, exit, compact, interrupt, submit)
 * @param value   The raw hook value from the agent record (hookStart, hookResume, etc.)
 * @param agent   The agent record (for engine type fallback)
 * @param context Optional context (spawn/resume options, task text)
 * @returns       HookResult describing what to do
 */
export function resolveHook(
  field: HookField,
  value: string | null | undefined,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  // null/undefined → use adapter preset
  if (!value) {
    return resolvePreset(field, agent, context);
  }

  // "preset:<engine>" → explicit preset (ignores agent.engine, uses specified engine)
  if (value.startsWith('preset:')) {
    const engine = value.slice(7).trim();
    if (!engine) {
      return resolvePreset(field, agent, context);
    }
    // Use the specified engine's adapter
    const adapter = getAdapter(engine as AgentRecord['engine']);
    return resolvePresetWithAdapter(field, adapter, context);
  }

  // "file:<path>" → read script file
  if (value.startsWith('file:')) {
    const filePath = value.slice(5).trim();
    return resolveFile(filePath);
  }

  // Bare string → inline command (paste)
  return { mode: 'paste', text: value };
}

// ── Preset Resolution ──

function resolvePreset(
  field: HookField,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  const adapter = getAdapter(agent.engine);
  return resolvePresetWithAdapter(field, adapter, context);
}

function resolvePresetWithAdapter(
  field: HookField,
  adapter: EngineAdapter,
  context?: HookContext,
): HookResult {
  switch (field) {
    case 'start': {
      if (!context?.spawnOpts) {
        throw new Error('resolveHook: spawnOpts required for start hook');
      }
      return { mode: 'paste', text: adapter.buildSpawnCommand(context.spawnOpts) };
    }

    case 'resume': {
      if (!context?.resumeOpts) {
        throw new Error('resolveHook: resumeOpts required for resume hook');
      }
      return { mode: 'paste', text: adapter.buildResumeCommand(context.resumeOpts) };
    }

    case 'exit': {
      if (adapter.exitKeys) {
        return { mode: 'keys', keys: adapter.exitKeys() };
      }
      return { mode: 'paste', text: adapter.buildExitCommand() };
    }

    case 'compact': {
      if (adapter.compactKeys) {
        return { mode: 'keys', keys: adapter.compactKeys() };
      }
      const cmd = adapter.buildCompactCommand();
      if (!cmd) return { mode: 'skip' };
      return { mode: 'paste', text: cmd };
    }

    case 'interrupt': {
      return { mode: 'keys', keys: adapter.interruptKeys() };
    }

    case 'submit': {
      // Default submit behavior: plain paste of the task text
      if (context?.task) {
        return { mode: 'paste', text: context.task };
      }
      return { mode: 'skip' };
    }
  }
}

// ── File Resolution ──

/**
 * Read a script file and return its contents as a paste action.
 * Path must be absolute. Relative paths are rejected for safety.
 */
function resolveFile(filePath: string): HookResult {
  if (!isAbsolute(filePath)) {
    throw new Error(`resolveHook file: path must be absolute, got "${filePath}"`);
  }

  // Basic path traversal check — no .. components after resolution
  const resolved = resolve(filePath);
  if (resolved !== filePath) {
    // The resolved path differs from input, meaning there were .. or . components
    throw new Error(`resolveHook file: path contains traversal components "${filePath}"`);
  }

  try {
    const content = readFileSync(resolved, 'utf-8').trim();
    if (!content) return { mode: 'skip' };
    return { mode: 'paste', text: content };
  } catch (err) {
    throw new Error(`resolveHook file: failed to read "${filePath}": ${(err as Error).message}`);
  }
}

// ── Convenience: get hook value from agent record ──

const HOOK_FIELD_MAP: Record<HookField, keyof AgentRecord> = {
  start: 'hookStart',
  resume: 'hookResume',
  exit: 'hookExit',
  compact: 'hookCompact',
  interrupt: 'hookInterrupt',
  submit: 'hookSubmit',
};

/**
 * Convenience wrapper: resolve a hook by field name, reading the value from the agent record.
 */
export function resolveAgentHook(
  field: HookField,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  const value = agent[HOOK_FIELD_MAP[field]] as string | null;
  return resolveHook(field, value, agent, context);
}
