/**
 * Schema-driven field registry for AgentRecord config fields.
 *
 * Single source of truth for field names, column mappings, serialization,
 * and persona-sync behavior. Covers the 19 persona-managed config fields.
 * Runtime fields (state, version, capturedVars, etc.) are NOT in the registry.
 */

import type { LaunchEnv, EngineType, HookValue, PipelineStep, IndicatorDefinition } from '../shared/types.ts';
import type { PersonaFrontmatter } from './persona.ts';

// ── Field Descriptor ──

export type FieldKind = 'scalar' | 'hook' | 'json';

export type FieldDef = {
  /** camelCase key on AgentRecord (e.g., 'hookStart'). */
  name: string;
  /** snake_case DB column (e.g., 'hook_start'). */
  column: string;
  /** Frontmatter key (e.g., 'start'). null = not set via persona frontmatter. */
  personaKey: string | null;
  kind: FieldKind;
  /** True if the persona key needs structured YAML parsing (NESTED_FIELDS). */
  nested: boolean;
  /** True if this field is in both createAgent AND upsertAgentFromPersona. */
  upsertable: boolean;
  /** True if also present in createAgent only (not upsert). e.g., proxyId. */
  createOnly: boolean;
  /** Custom serializer for json kind. */
  serialize?: (v: unknown) => string | null;
  /** Custom deserializer for json kind (DB row → AgentRecord value). */
  deserialize?: (v: unknown) => unknown;
  /** Custom equality check for syncPersonasWithDiff. Default: optionalScalarEquals. */
  equals?: (a: unknown, b: unknown) => boolean;
};

// ── Serialization Helpers ──

function serializeLaunchEnv(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function deserializeLaunchEnv(value: unknown): LaunchEnv | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw !== 'string') return null;
      env[key] = raw;
    }
    return env;
  } catch {
    return null;
  }
}

function launchEnvEquals(a: unknown, b: unknown): boolean {
  const left = (a ?? null) as LaunchEnv | null;
  const right = (b ?? null) as LaunchEnv | null;
  if (left === null || right === null) return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function serializeHookValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function serializeCustomButtons(value: unknown): string | null {
  if (value == null) return null;
  const obj = value as Record<string, PipelineStep[]>;
  if (Object.keys(obj).length === 0) return null;
  return JSON.stringify(obj);
}

function serializeIndicators(value: unknown): string | null {
  if (value == null) return null;
  const arr = value as IndicatorDefinition[];
  if (arr.length === 0) return null;
  return JSON.stringify(arr);
}

// ── The Registry ──
// Order matters: INSERT columns follow this order for config fields.

export const CONFIG_FIELDS: readonly FieldDef[] = [
  { name: 'engine',             column: 'engine',                personaKey: 'engine',                kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'model',              column: 'model',                 personaKey: 'model',                 kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'thinking',           column: 'thinking',              personaKey: 'thinking',              kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'cwd',                column: 'cwd',                   personaKey: 'cwd',                   kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'persona',            column: 'persona',               personaKey: null,                    kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'permissions',        column: 'permissions',           personaKey: 'permissions',           kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'proxyHost',          column: 'proxy_host',            personaKey: 'proxy_host',            kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'proxyId',            column: 'proxy_id',              personaKey: null,                    kind: 'scalar', nested: false, upsertable: false, createOnly: true },
  { name: 'agentGroup',         column: 'agent_group',           personaKey: 'group',                 kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'account',            column: 'account',               personaKey: 'account',               kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'launchEnv',          column: 'launch_env',            personaKey: 'env',                   kind: 'json',   nested: false, upsertable: true,  createOnly: false, serialize: serializeLaunchEnv, deserialize: deserializeLaunchEnv, equals: launchEnvEquals },
  { name: 'hookStart',          column: 'hook_start',            personaKey: 'start',                 kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'hookResume',         column: 'hook_resume',           personaKey: 'resume',                kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'hookCompact',        column: 'hook_compact',          personaKey: 'compact',               kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'hookExit',           column: 'hook_exit',             personaKey: 'exit',                  kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'hookInterrupt',      column: 'hook_interrupt',        personaKey: 'interrupt',             kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'hookSubmit',         column: 'hook_submit',           personaKey: 'submit',                kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'hookDetectSession',  column: 'hook_detect_session',   personaKey: 'detect_session',        kind: 'hook',   nested: true,  upsertable: true,  createOnly: false },
  { name: 'detectSessionRegex', column: 'detect_session_regex',  personaKey: 'detect_session_regex',  kind: 'scalar', nested: false, upsertable: true,  createOnly: false },
  { name: 'customButtons',      column: 'custom_buttons',        personaKey: 'custom_buttons',        kind: 'json',   nested: false, upsertable: true,  createOnly: false, serialize: serializeCustomButtons },
  { name: 'indicators',         column: 'indicators',            personaKey: 'indicators',            kind: 'json',   nested: false, upsertable: true,  createOnly: false, serialize: serializeIndicators },
];

// ── Derived Utilities ──

/** camelCase → snake_case map for config fields (subset of COLUMN_MAP). */
export function configColumnMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of CONFIG_FIELDS) {
    map[f.name] = f.column;
  }
  return map;
}

/** Set of frontmatter keys that support structured (nested) YAML parsing. */
export function nestedPersonaKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of CONFIG_FIELDS) {
    if (f.nested && f.personaKey) keys.add(f.personaKey);
  }
  return keys;
}

/** Deserialize config fields from a raw DB row. */
export function mapConfigFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const f of CONFIG_FIELDS) {
    if (f.createOnly) {
      // proxyId is not read back in mapAgentRow config section —
      // it's in the runtime section. Skip.
      continue;
    }
    const raw = row[f.column];
    if (f.kind === 'json' && f.deserialize) {
      result[f.name] = f.deserialize(raw);
    } else {
      result[f.name] = raw;
    }
  }
  return result;
}

/**
 * Column list for createAgent INSERT (config portion).
 * Does NOT include 'name' or 'state' — those are prepended/appended manually.
 */
export function configInsertColumns(): string[] {
  return CONFIG_FIELDS.map(f => f.column);
}

/**
 * Serialize opts values for INSERT (config portion).
 * Returns params in CONFIG_FIELDS order.
 *
 * Values that are already strings pass through unchanged — this supports
 * both pre-serialized opts (from buildUpsertOpts) and raw objects.
 */
export function serializeConfigParams(opts: Record<string, unknown>): unknown[] {
  return CONFIG_FIELDS.map(f => {
    const value = opts[f.name];
    if (f.kind === 'json' && f.serialize) {
      // Skip serialization if already a string (pre-serialized by buildUpsertOpts)
      if (typeof value === 'string') return value;
      return f.serialize(value);
    }
    if (f.kind === 'hook') {
      return serializeHookValue(value);
    }
    return value ?? null;
  });
}

/**
 * Column list for upsertAgentFromPersona UPDATE (excludes createOnly fields like proxyId).
 */
export function configUpsertColumns(): string[] {
  return CONFIG_FIELDS.filter(f => f.upsertable).map(f => f.column);
}

/** SET clause for upsertAgentFromPersona UPDATE. */
export function configUpdateSetClause(): string {
  return configUpsertColumns().map(c => `${c} = ?`).join(', ');
}

/**
 * Serialize opts for upsert UPDATE (excludes createOnly fields).
 */
export function serializeUpsertParams(opts: Record<string, unknown>): unknown[] {
  return CONFIG_FIELDS.filter(f => f.upsertable).map(f => {
    const value = opts[f.name];
    if (f.kind === 'json' && f.serialize) {
      if (typeof value === 'string') return value;
      return f.serialize(value);
    }
    if (f.kind === 'hook') {
      return serializeHookValue(value);
    }
    return value ?? null;
  });
}

/** Compare config fields between existing AgentRecord and upsert opts. */
export function configFieldsChanged(
  existing: Record<string, unknown>,
  upsertOpts: Record<string, unknown>,
): boolean {
  for (const f of CONFIG_FIELDS) {
    if (!f.upsertable) continue;
    // Skip 'persona' — it's always set to name, not compared
    if (f.name === 'persona') continue;
    const a = existing[f.name];
    const b = upsertOpts[f.name];
    if (f.equals) {
      if (!f.equals(a, b)) return true;
    } else {
      // Default: optionalScalarEquals semantics
      if ((a ?? null) !== (b ?? null)) return true;
    }
  }
  return false;
}

/**
 * Build upsert opts from persona frontmatter.
 * Handles the field name mapping (e.g., 'group' → 'agentGroup'),
 * hook serialization, and the legacy 'spawn' alias.
 */
export function buildUpsertOptsFromFrontmatter(
  name: string,
  fm: PersonaFrontmatter,
): Record<string, unknown> {
  const opts: Record<string, unknown> = { name };

  for (const f of CONFIG_FIELDS) {
    if (f.createOnly) continue; // proxyId not set from persona
    if (f.name === 'persona') {
      opts.persona = name;
      continue;
    }
    if (!f.personaKey) continue;

    let value: unknown;

    // Special case: hookStart can fall back to legacy 'spawn' alias
    if (f.name === 'hookStart') {
      value = fm.start ?? fm.spawn;
    } else {
      value = (fm as Record<string, unknown>)[f.personaKey];
    }

    // Apply serialization based on kind.
    // launchEnv is special: buildUpsertOpts returns the normalized object,
    // not the JSON string — serialization happens later in createAgent/upsert.
    if (f.name === 'launchEnv') {
      opts[f.name] = normalizeLaunchEnv(value);
    } else if (f.kind === 'json' && f.serialize) {
      opts[f.name] = f.serialize(value);
    } else if (f.kind === 'hook') {
      opts[f.name] = serializeHookValue(value);
    } else {
      opts[f.name] = value;
    }
  }

  return opts;
}

/**
 * Generate ALTER TABLE statements for missing config columns.
 * Non-config columns (dashboard_messages, proxies, etc.) stay manual.
 */
export function buildMigrationStatements(existingColumns: Set<string>): string[] {
  const stmts: string[] = [];
  for (const f of CONFIG_FIELDS) {
    if (!existingColumns.has(f.column)) {
      stmts.push(`ALTER TABLE agents ADD COLUMN ${f.column} TEXT`);
    }
  }
  return stmts;
}

// ── Internal helpers ──

function normalizeLaunchEnv(value: unknown): LaunchEnv | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') return undefined;
    env[key] = raw;
  }
  return env;
}
