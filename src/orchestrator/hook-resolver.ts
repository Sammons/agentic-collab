/**
 * Unified hook resolver.
 *
 * Every hookable lifecycle operation (start, resume, exit, compact, interrupt, submit)
 * resolves through this module. Hook values support two formats:
 *
 * Legacy (string):
 *   1. null / undefined  → implicit preset behavior (adapter default)
 *   2. "preset:<engine>" → explicit adapter method call
 *   3. "file:<path>"     → read script file content and paste it
 *   4. bare string       → inline command or keys (auto-detected)
 *
 * Structured (object):
 *   1. { preset: "<engine>", options?: { model, thinking, permissions } }
 *   2. { shell: "<command>", env?: { KEY: "val" } }
 *   3. { send: [{ keystroke: "Escape" }, { paste: "hello", post_wait_ms: 200 }] }
 *
 * The resolver returns a HookResult describing how the lifecycle should deliver the command.
 */

import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { EngineAdapter, SpawnOptions, ResumeOptions } from './adapters/types.ts';
import type { AgentRecord, HookValue, StructuredHook, SendAction, PresetHook, ShellHook, SendHook } from '../shared/types.ts';
import { getAdapter } from './adapters/index.ts';
import { deserializeHookValue } from './persona.ts';

// ── Result Types ──

export type HookResult =
  | { mode: 'paste'; text: string }
  | { mode: 'keys'; keys: string[] }
  | { mode: 'send'; actions: SendAction[] }
  | { mode: 'skip' };

// ── Hook Fields ──

export type HookField = 'start' | 'resume' | 'exit' | 'compact' | 'interrupt' | 'submit' | 'detect_session';

// ── Context for resolution ──

export type HookContext = {
  /** SpawnOptions for start hooks */
  spawnOpts?: SpawnOptions;
  /** ResumeOptions for resume hooks */
  resumeOpts?: ResumeOptions;
  /** Task text for submit hooks */
  task?: string;
  /** Agent CWD for detect_session hooks */
  cwd?: string;
};

// ── Type guards ──

function isPresetHook(v: StructuredHook): v is PresetHook {
  return 'preset' in v;
}

function isShellHook(v: StructuredHook): v is ShellHook {
  return 'shell' in v;
}

function isSendHook(v: StructuredHook): v is SendHook {
  return 'send' in v;
}

// ── Resolver ──

/**
 * Resolve a hook value to a concrete action.
 *
 * @param field   Which lifecycle operation (start, resume, exit, compact, interrupt, submit)
 * @param value   The raw hook value — string (legacy or from DB), structured object, or null
 * @param agent   The agent record (for engine type fallback)
 * @param context Optional context (spawn/resume options, task text)
 * @returns       HookResult describing what to do
 */
export function resolveHook(
  field: HookField,
  value: string | StructuredHook | null | undefined,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  // null/undefined → use adapter preset
  if (value == null) {
    return resolvePreset(field, agent, context);
  }

  // String value — could be legacy format or JSON-serialized structured hook from DB
  if (typeof value === 'string') {
    // Try to deserialize JSON from DB storage
    const deserialized = deserializeHookValue(value);
    if (deserialized != null && typeof deserialized !== 'string') {
      // It was a JSON-serialized structured hook — recurse with the parsed object
      return resolveHook(field, deserialized, agent, context);
    }

    // Legacy string format
    return resolveStringHook(field, value, agent, context);
  }

  // Structured hook object
  return resolveStructuredHook(field, value, agent, context);
}

/** Resolve legacy string hook values. */
function resolveStringHook(
  field: HookField,
  value: string,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  // "preset:<engine>" → explicit preset (ignores agent.engine, uses specified engine)
  if (value.startsWith('preset:')) {
    const engine = value.slice(7).trim();
    if (!engine) {
      return resolvePreset(field, agent, context);
    }
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

/** Resolve structured (nested YAML) hook values. */
function resolveStructuredHook(
  field: HookField,
  value: StructuredHook,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  if (isPresetHook(value)) {
    const engine = value.preset.trim();
    if (!engine) {
      return resolvePreset(field, agent, context);
    }
    // Apply options overrides to context if provided
    const enrichedContext = applyPresetOptions(value, context);
    const adapter = getAdapter(engine as AgentRecord['engine']);
    return resolvePresetWithAdapter(field, adapter, enrichedContext);
  }

  if (isShellHook(value)) {
    // Build env var prefix from agent identity + custom env
    const envParts: string[] = [];
    envParts.push(`COLLAB_AGENT=${agent.name}`);
    if (value.env) {
      for (const [k, v] of Object.entries(value.env)) {
        envParts.push(`${k}=${v}`);
      }
    }
    const envPrefix = `export ${envParts.join(' ')}`;
    return { mode: 'paste', text: `${envPrefix} && ${value.shell}` };
  }

  if (isSendHook(value)) {
    if (!value.send || value.send.length === 0) return { mode: 'skip' };
    return { mode: 'send', actions: value.send };
  }

  // Unknown structure — skip
  return { mode: 'skip' };
}

/** Apply preset options (model, thinking, permissions) to spawn/resume context. */
function applyPresetOptions(hook: PresetHook, context?: HookContext): HookContext | undefined {
  if (!hook.options) return context;
  if (!context) return context;

  // Apply options to spawn opts
  if (context.spawnOpts) {
    return {
      ...context,
      spawnOpts: {
        ...context.spawnOpts,
        model: hook.options.model ?? context.spawnOpts.model,
        thinking: hook.options.thinking ?? context.spawnOpts.thinking,
        dangerouslySkipPermissions: hook.options.permissions === 'skip' ? true : context.spawnOpts.dangerouslySkipPermissions,
      },
    };
  }

  // Apply to resume opts — model and thinking don't apply to resume
  return context;
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
      if (!context?.task) return { mode: 'skip' };
      // Prefer structured submit actions (e.g. Codex extra Enter after delay)
      if (adapter.submitActions) {
        const actions = adapter.submitActions(context.task);
        if (actions) return { mode: 'send', actions };
      }
      return { mode: 'paste', text: adapter.buildSubmitCommand(context.task) };
    }

    case 'detect_session': {
      const cmd = adapter.buildDetectSessionCommand(context?.cwd ?? '.');
      if (!cmd) return { mode: 'skip' };
      return { mode: 'paste', text: cmd };
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
  detect_session: 'hookDetectSession',
};

/**
 * Convenience wrapper: resolve a hook by field name, reading the value from the agent record.
 * DB-stored values are strings (possibly JSON-serialized); resolveHook handles deserialization.
 */
export function resolveAgentHook(
  field: HookField,
  agent: AgentRecord,
  context?: HookContext,
): HookResult {
  const value = agent[HOOK_FIELD_MAP[field]] as string | null;
  return resolveHook(field, value, agent, context);
}
