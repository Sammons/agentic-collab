/**
 * Agent persona loading.
 * Resolves persona files from persistent-agents/<name>.md by convention.
 * Composes system prompt: persona + messaging instructions + orchestrator rules.
 * Parses YAML-like frontmatter for agent configuration.
 */

import { readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { StructuredHook, HookValue, SendAction, LaunchEnv, PipelineStep } from '../shared/types.ts';

export const PERSONAS_DIR = process.env['PERSONAS_DIR'] ?? join(process.env['HOME'] ?? '/data', 'persistent-agents');

export function getPersonasDir(): string {
  return process.env['PERSONAS_DIR'] ?? PERSONAS_DIR;
}

/**
 * Map a container-side persona file path to the host-side path.
 * When PERSONAS_HOST_DIR is set, replaces the PERSONAS_DIR prefix with it.
 * Falls back to the original path if the env var is unset or the path doesn't match.
 */
export function toHostPath(containerPath: string): string {
  const hostDir = process.env['PERSONAS_HOST_DIR'];
  if (!hostDir) return containerPath;
  const personasDir = getPersonasDir();
  if (containerPath.startsWith(personasDir)) {
    return hostDir + containerPath.slice(personasDir.length);
  }
  return containerPath;
}

// ── Frontmatter ──

export type PersonaFrontmatter = {
  engine?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  proxy_host?: string;
  permissions?: string;
  group?: string;
  /** Launch-time environment variables injected on spawn/resume/reload. */
  env?: LaunchEnv;
  /** Hook value for starting the agent. String (legacy) or structured object. */
  start?: HookValue;
  /** Hook value for resuming the agent. */
  resume?: HookValue;
  /** Hook value for compacting the agent. */
  compact?: HookValue;
  /** Hook value for exiting the agent. */
  exit?: HookValue;
  /** Hook value for interrupting the agent. */
  interrupt?: HookValue;
  /** Hook value for submitting messages to the agent. */
  submit?: HookValue;
  /** Hook value for detecting the agent's session ID after spawn/resume. */
  detect_session?: HookValue;
  /** Regex to extract session ID from pane output on exit. First capture group = session ID. */
  detect_session_regex?: string;
  /** Legacy alias for start (backward compat). */
  spawn?: HookValue;
};

export type ParsedPersona = {
  name: string;
  frontmatter: PersonaFrontmatter;
  body: string;
};

/** Frontmatter field names that support structured (nested) values. */
const NESTED_FIELDS = new Set(['env', 'start', 'resume', 'compact', 'exit', 'interrupt', 'submit', 'detect_session', 'spawn']);

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Expects `---` delimiters. Supports:
 *   - Flat scalar values: `key: value`
 *   - One level of nested objects: `key:\n  sub: val`
 *   - Arrays of objects (for send hooks): `key:\n  send:\n    - keystroke: Escape`
 *   - Block scalars: `key: |` or `key: >` (multiline strings)
 *
 * Only nested-capable fields (env, start, resume, compact, exit, interrupt,
 * submit, spawn) receive structured parsing. All other fields remain flat strings.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: raw };
  }

  const fmBlock = trimmed.slice(4, endIdx); // skip opening ---\n
  const body = trimmed.slice(endIdx + 4).replace(/^\n/, ''); // skip closing ---\n

  const frontmatter: Record<string, unknown> = {};
  const lines = fmBlock.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Must be a top-level key (no leading whitespace for top-level)
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1);

    if (!key) {
      i++;
      continue;
    }

    // Check for block scalar indicators (| or >)
    const trimmedVal = rawVal.trim();
    if (trimmedVal === '|' || trimmedVal === '>') {
      const { value, nextLine } = parseBlockScalar(lines, i + 1);
      frontmatter[key] = value;
      i = nextLine;
      continue;
    }

    // Check if next line is indented (nested object, array, or pipeline)
    if (trimmedVal === '' && NESTED_FIELDS.has(key) && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent > 0) {
        // Try pipeline parser first (array of steps: - keystrokes:/shell:/capture:)
        if (key !== 'env' && nextLine.trim().startsWith('- ')) {
          try {
            const { value: pipelineSteps, nextLine: endLine } = parsePipelineSteps(lines, i + 1, nextIndent);
            if (pipelineSteps.length > 0) {
              frontmatter[key] = pipelineSteps;
              i = endLine;
              continue;
            }
          } catch { /* fall through to legacy parser */ }
        }
        const { value, nextLine: endLine } = parseNestedValue(lines, i + 1, nextIndent);
        frontmatter[key] = value;
        i = endLine;
        continue;
      }
    }

    // Flat scalar value
    frontmatter[key] = trimmedVal;
    i++;
  }

  return { frontmatter, body };
}

/**
 * Parse a block scalar (| or >) starting from the given line.
 * Collects all indented lines until a non-indented line or EOF.
 */
function parseBlockScalar(lines: string[], startLine: number): { value: string; nextLine: number } {
  if (startLine >= lines.length) return { value: '', nextLine: startLine };

  // Detect indent from first content line
  const firstLine = lines[startLine]!;
  const indent = firstLine.length - firstLine.trimStart().length;
  if (indent === 0) return { value: '', nextLine: startLine };

  const collected: string[] = [];
  let i = startLine;
  while (i < lines.length) {
    const line = lines[i]!;
    // Empty lines are preserved in block scalars
    if (line.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) break;
    collected.push(line.slice(indent));
    i++;
  }

  return { value: collected.join('\n').trim(), nextLine: i };
}

/**
 * Parse a nested YAML value (object or array) starting from the given line.
 * Handles one level of nesting with optional arrays.
 */
function parseNestedValue(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: StructuredHook | LaunchEnv | Record<string, unknown>; nextLine: number } {
  const result: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // If less indented than base, we're done with this block
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    const content = line.trim();

    // Array item at this indent level (e.g. "- keystroke: Escape")
    if (content.startsWith('- ')) {
      // This shouldn't appear at top level of a hook — arrays are nested under "send:"
      i++;
      continue;
    }

    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const subKey = content.slice(0, colonIdx).trim();
    const subRawVal = content.slice(colonIdx + 1).trim();

    // Check if next line is further indented (sub-object or array)
    if (subRawVal === '' && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextContent = nextLine.trim();
      const nextIndent = nextLine.length - nextLine.trimStart().length;

      if (nextIndent > lineIndent) {
        // Array of objects (send actions)
        if (nextContent.startsWith('- ')) {
          const { value: arr, nextLine: endLine } = parseArray(lines, i + 1, nextIndent);
          result[subKey] = arr;
          i = endLine;
          continue;
        }
        // Sub-object (options, env)
        const { value: subObj, nextLine: endLine } = parseSubObject(lines, i + 1, nextIndent);
        result[subKey] = subObj;
        i = endLine;
        continue;
      }
    }

    // Scalar sub-value
    result[subKey] = subRawVal;
    i++;
  }

  return { value: result as StructuredHook, nextLine: i };
}

/**
 * Parse a pipeline — an array of steps where each step is one of:
 *   - keystrokes: [{keystroke: ...}, ...]
 *   - shell: <command>
 *   - capture: {lines: N, regex: '...', var: 'NAME'}
 *
 * Example YAML:
 *   - keystrokes:
 *     - keystroke: Escape
 *   - shell: /exit
 *   - capture:
 *       lines: 50
 *       regex: 'codex resume ([0-9a-f-]+)'
 *       var: SESSION_ID
 *
 * Throws on unrecognized step types so the caller can fall back to the legacy parser.
 */
function parsePipelineSteps(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: PipelineStep[]; nextLine: number } {
  const steps: PipelineStep[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    const content = line.trim();
    if (!content.startsWith('- ')) {
      // Not an array item at the expected indent — done
      break;
    }

    const itemContent = content.slice(2).trim();
    const colonIdx = itemContent.indexOf(':');
    if (colonIdx === -1) throw new Error(`Pipeline step missing key: ${itemContent}`);

    const stepKey = itemContent.slice(0, colonIdx).trim();
    const stepVal = itemContent.slice(colonIdx + 1).trim();

    if (stepKey === 'shell') {
      steps.push({ type: 'shell', command: stepVal });
      i++;
    } else if (stepKey === 'keystrokes' || stepKey === 'send') {
      // Parse the sub-array of SendAction items
      i++;
      const actions: SendAction[] = [];
      while (i < lines.length) {
        const subLine = lines[i]!;
        if (subLine.trim() === '') { i++; continue; }
        const subIndent = subLine.length - subLine.trimStart().length;
        if (subIndent <= lineIndent) break; // back to parent level
        const subContent = subLine.trim();
        if (!subContent.startsWith('- ')) { i++; continue; }
        const actionContent = subContent.slice(2).trim();
        const actionColonIdx = actionContent.indexOf(':');
        if (actionColonIdx === -1) { i++; continue; }
        const actionKey = actionContent.slice(0, actionColonIdx).trim();
        const actionVal = actionContent.slice(actionColonIdx + 1).trim();
        const action: Record<string, unknown> = { [actionKey]: coerceScalar(actionVal) };
        // Check for sub-properties on the next line (e.g. post_wait_ms)
        i++;
        while (i < lines.length) {
          const propLine = lines[i]!;
          if (propLine.trim() === '') { i++; continue; }
          const propIndent = propLine.length - propLine.trimStart().length;
          if (propIndent <= subIndent) break;
          const propContent = propLine.trim();
          const propColonIdx = propContent.indexOf(':');
          if (propColonIdx !== -1) {
            const propKey = propContent.slice(0, propColonIdx).trim();
            const propVal = propContent.slice(propColonIdx + 1).trim();
            action[propKey] = coerceScalar(propVal);
          }
          i++;
        }
        actions.push(action as SendAction);
      }
      steps.push({ type: 'keystrokes', actions });
    } else if (stepKey === 'capture') {
      // Parse capture sub-object (lines, regex, var)
      i++;
      const captureObj: Record<string, unknown> = {};
      while (i < lines.length) {
        const subLine = lines[i]!;
        if (subLine.trim() === '') { i++; continue; }
        const subIndent = subLine.length - subLine.trimStart().length;
        if (subIndent <= lineIndent) break;
        const subContent = subLine.trim();
        const subColonIdx = subContent.indexOf(':');
        if (subColonIdx !== -1) {
          const subKey = subContent.slice(0, subColonIdx).trim();
          const subVal = subContent.slice(subColonIdx + 1).trim();
          captureObj[subKey] = coerceScalar(subVal);
        }
        i++;
      }
      steps.push({
        type: 'capture',
        lines: typeof captureObj['lines'] === 'number' ? captureObj['lines'] : 50,
        regex: String(captureObj['regex'] ?? ''),
        var: String(captureObj['var'] ?? ''),
      });
    } else {
      throw new Error(`Unknown pipeline step type: ${stepKey}`);
    }
  }

  return { value: steps, nextLine: i };
}

/**
 * Parse an array of objects (used for send actions).
 * Each item starts with "- " and may have sub-keys on the same or next lines.
 */
function parseArray(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: Record<string, unknown>[]; nextLine: number } {
  const items: Record<string, unknown>[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    const content = line.trim();
    if (!content.startsWith('- ')) break;

    // Parse "- key: value" on the same line
    const itemContent = content.slice(2); // remove "- "
    const item: Record<string, unknown> = {};

    const colonIdx = itemContent.indexOf(':');
    if (colonIdx !== -1) {
      const k = itemContent.slice(0, colonIdx).trim();
      const v = itemContent.slice(colonIdx + 1).trim();
      if (k) item[k] = coerceScalar(v);
    }
    i++;

    // Check for continuation lines (same array item, further indented)
    const itemIndent = baseIndent + 2; // "- " adds 2 chars of content indent
    while (i < lines.length) {
      const nextLine = lines[i]!;
      if (nextLine.trim() === '') { i++; continue; }
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent < itemIndent) break;
      const nc = nextLine.trim();
      if (nc.startsWith('- ')) break; // next array item
      const ci = nc.indexOf(':');
      if (ci !== -1) {
        const k = nc.slice(0, ci).trim();
        const v = nc.slice(ci + 1).trim();
        if (k) item[k] = coerceScalar(v);
      }
      i++;
    }

    items.push(item);
  }

  return { value: items, nextLine: i };
}

/**
 * Parse a simple sub-object (one level of key: value pairs).
 * Used for options and env blocks.
 */
function parseSubObject(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: Record<string, string>; nextLine: number } {
  const result: Record<string, string> = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    const content = line.trim();
    const colonIdx = content.indexOf(':');
    if (colonIdx !== -1) {
      const k = content.slice(0, colonIdx).trim();
      const v = content.slice(colonIdx + 1).trim();
      if (k) result[k] = v;
    }
    i++;
  }

  return { value: result, nextLine: i };
}

/** Coerce YAML scalar strings to appropriate JS types. */
function coerceScalar(val: string): string | number | boolean {
  // Numbers
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
  // Booleans
  if (val === 'true') return true;
  if (val === 'false') return false;
  return val;
}

function normalizeLaunchEnv(value: unknown): LaunchEnv | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') return undefined;
    env[key] = raw;
  }
  return env;
}

function launchEnvEquals(a: LaunchEnv | null, b: LaunchEnv | null | undefined): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) {
    return left === right;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function optionalScalarEquals<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Scan the personas directory and return all parsed persona files.
 */
export function scanPersonas(personasDir?: string): ParsedPersona[] {
  const dir = personasDir ?? getPersonasDir();
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    const results: ParsedPersona[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        results.push({
          name: file.replace(/\.md$/, ''),
          frontmatter: frontmatter as PersonaFrontmatter,
          body,
        });
      } catch {
        // Skip unreadable files
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Resolve persona file path for an agent.
 * 1. If explicit path provided, validate it's within personasDir
 * 2. Check personasDir/<name>.md (convention)
 * 3. If neither found, return null
 */
export function resolvePersonaPath(agentName: string, explicitPath?: string | null, personasDir: string = PERSONAS_DIR): string | null {
  if (explicitPath) {
    // Use realpathSync as the primary check — resolves symlinks and validates existence
    // in a single atomic call, eliminating the TOCTOU between existsSync and realpathSync
    try {
      const real = realpathSync(resolve(explicitPath));
      const baseReal = realpathSync(personasDir);
      const rel = relative(baseReal, real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
      return real; // Return the resolved real path, not the original
    } catch {
      return null; // File doesn't exist or path is invalid
    }
  }

  const conventionPath = join(personasDir, `${agentName}.md`);
  try {
    const real = realpathSync(conventionPath);
    const baseReal = realpathSync(personasDir);
    const rel = relative(baseReal, real);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return real;
    return null; // Convention path escapes personasDir
  } catch {
    // File doesn't exist
  }

  return null;
}

/**
 * Load persona content from file. Returns the body (frontmatter stripped).
 */
export function loadPersona(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const { body } = parseFrontmatter(raw);
    return body || null;
  } catch {
    return null;
  }
}

/**
 * Load persona with frontmatter from file. Returns both parsed frontmatter and body.
 */
export function loadPersonaFull(path: string): ParsedPersona | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
    return { name, frontmatter: frontmatter as PersonaFrontmatter, body };
  } catch {
    return null;
  }
}

/**
 * Update a single frontmatter field in a persona file.
 * If the field exists, replaces its value. If not, adds it.
 * If value is empty/null, removes the field.
 */
export function updateFrontmatterField(filePath: string, field: string, value: string | null): void {
  const raw = readFileSync(filePath, 'utf-8');
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith('---')) {
    // No frontmatter — add one with the field
    if (!value) return; // nothing to remove
    const newContent = `---\n${field}: ${value}\n---\n${raw}`;
    writeFileSync(filePath, newContent, 'utf-8');
    return;
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    if (!value) return;
    const newContent = `---\n${field}: ${value}\n---\n${raw}`;
    writeFileSync(filePath, newContent, 'utf-8');
    return;
  }

  const fmBlock = trimmed.slice(4, endIdx);
  const body = trimmed.slice(endIdx + 4);
  const lines = fmBlock.split('\n');
  let found = false;

  const updatedLines = lines.filter((line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return true;
    const key = line.slice(0, colonIdx).trim();
    if (key === field) {
      found = true;
      return !!value; // keep line only if we have a new value
    }
    return true;
  }).map((line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return line;
    const key = line.slice(0, colonIdx).trim();
    if (key === field && value) return `${field}: ${value}`;
    return line;
  });

  if (!found && value) {
    updatedLines.push(`${field}: ${value}`);
  }

  const newContent = `---\n${updatedLines.join('\n')}\n---${body}`;
  writeFileSync(filePath, newContent, 'utf-8');
}

/**
 * Compose the full system prompt for an agent.
 * Combines persona + messaging instructions + orchestrator rules.
 */
export function composeSystemPrompt(opts: {
  agentName: string;
  personaContent?: string | null;
  orchestratorHost: string;
  peers?: string[];
}): string {
  const parts: string[] = [];

  // Persona content
  if (opts.personaContent) {
    parts.push(opts.personaContent);
    parts.push('\n---\n');
  }

  // Messaging instructions — collab CLI (standalone binary, not a pnpm script)
  parts.push(`Messages from other agents arrive as text in your tmux pane
formatted as: [from: <sender>, reply with collab send operator --topic <topic>]: '<message>'

You have the \`collab\` CLI on your PATH. It is a standalone binary — run it directly (e.g. \`collab send ...\`), NOT via pnpm or any repo skill.
IMPORTANT: Do NOT use \`pnpm collaboration\` or any other wrapper. Always use the bare \`collab\` command.
It auto-discovers auth and the orchestrator.
Your agent name is set via COLLAB_AGENT=${opts.agentName}.

Send a message to the operator (dashboard):
  collab send operator --topic <topic> <message>

Send a message to another agent:
  collab send <agent> --topic <topic> <message>

List all agents:
  collab list-agents

Create an agent from a persona file:
  collab create-agent <persona-file>

Constrained tmux passthrough:
  collab tmux <agent> -- <tmux-subcommand> [args...]

Run \`collab help\` for full usage.`);

  if (opts.peers && opts.peers.length > 0) {
    parts.push(`\n\nKnown peers: ${opts.peers.join(', ')}`);
  }

  parts.push(`

Use /compact proactively when your context grows large.
Keep context light — delegate to sub-agents when appropriate.
When you finish a task or have results, report back to the orchestrator.`);

  return parts.join('\n');
}

// ── Hook Serialization ──

/**
 * Serialize a hook value for database storage.
 * Strings pass through as-is. Structured objects become JSON.
 * null/undefined → null.
 */
export function serializeHookValue(value: HookValue | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Deserialize a hook value from database storage.
 * Attempts JSON parse; falls back to plain string.
 */
export function deserializeHookValue(value: string | null): HookValue {
  if (value == null) return null;
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value) as StructuredHook | PipelineStep[];
    } catch {
      return value;
    }
  }
  return value;
}

// ── Startup Sync ──

import type { Database } from './database.ts';
import type { EngineType } from '../shared/types.ts';

const VALID_ENGINES = new Set<string>(['claude', 'codex', 'opencode']);

/**
 * Re-sync a single agent's persona from disk.
 * Call before spawn/resume to pick up config changes (engine, model, etc.).
 * Returns true if the persona was found and synced.
 */
export function syncSinglePersona(db: Database, name: string, personasDir?: string): boolean {
  const dir = personasDir ?? getPersonasDir();
  const filePath = join(dir, `${name}.md`);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return false; // no persona file
  }
  if (!raw.trim()) return false;

  const { frontmatter } = parseFrontmatter(raw);
  const fm = frontmatter as PersonaFrontmatter;
  const engine = fm.engine;
  const cwd = fm.cwd;
  if (!engine || !VALID_ENGINES.has(engine) || !cwd) return false;

  db.upsertAgentFromPersona({
    name,
    engine: engine as EngineType,
    model: fm.model as string | undefined,
    thinking: fm.thinking as string | undefined,
    cwd,
    persona: name,
    permissions: fm.permissions as string | undefined,
    proxyHost: fm.proxy_host as string | undefined,
    agentGroup: fm.group as string | undefined,
    launchEnv: normalizeLaunchEnv(fm.env),
    hookStart: serializeHookValue(fm.start ?? fm.spawn),
    hookResume: serializeHookValue(fm.resume),
    hookCompact: serializeHookValue(fm.compact),
    hookExit: serializeHookValue(fm.exit),
    hookInterrupt: serializeHookValue(fm.interrupt),
    hookSubmit: serializeHookValue(fm.submit),
    hookDetectSession: serializeHookValue(fm.detect_session),
    detectSessionRegex: fm.detect_session_regex as string | undefined,
  });
  return true;
}

/**
 * Scan persona files and idempotently merge into SQLite.
 * Creates new agents, updates config fields on existing ones.
 * Preserves runtime state (active/idle/suspended, session, proxy, etc.).
 * Returns count of agents synced.
 */
export function syncPersonasToDb(db: Database, personasDir?: string): number {
  const personas = scanPersonas(personasDir);
  let synced = 0;

  for (const persona of personas) {
    const { name, frontmatter } = persona;
    const engine = frontmatter.engine;
    const cwd = frontmatter.cwd;

    // engine and cwd are required for an agent to be valid
    if (!engine || !VALID_ENGINES.has(engine) || !cwd) {
      console.warn(`[persona-sync] Skipping "${name}.md": engine and cwd are required (got engine=${engine ?? 'undefined'}, cwd=${cwd ?? 'undefined'})`);
      continue;
    }

    db.upsertAgentFromPersona({
      name,
      engine: engine as EngineType,
      model: frontmatter.model as string | undefined,
      thinking: frontmatter.thinking as string | undefined,
      cwd,
      persona: name,
      permissions: frontmatter.permissions as string | undefined,
      proxyHost: frontmatter.proxy_host as string | undefined,
      agentGroup: frontmatter.group as string | undefined,
      launchEnv: normalizeLaunchEnv(frontmatter.env),
      hookStart: serializeHookValue(frontmatter.start ?? frontmatter.spawn),
      hookResume: serializeHookValue(frontmatter.resume),
      hookCompact: serializeHookValue(frontmatter.compact),
      hookExit: serializeHookValue(frontmatter.exit),
      hookInterrupt: serializeHookValue(frontmatter.interrupt),
      hookSubmit: serializeHookValue(frontmatter.submit),
      hookDetectSession: serializeHookValue(frontmatter.detect_session),
      detectSessionRegex: frontmatter.detect_session_regex as string | undefined,
    });

    synced++;
  }

  return synced;
}

// ── Sync with Diff ──

export type SyncDiffResult = {
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
};

/**
 * Sync persona files to DB and return a diff of what changed.
 * - NEW: file exists, no DB record → created
 * - UPDATED: file exists, DB record differs → updated
 * - UNCHANGED: file exists, DB record matches → unchanged
 * - SKIPPED: file missing engine/cwd → skipped
 * - DELETED personas (DB record, no file) are intentionally ignored.
 */
export function syncPersonasWithDiff(db: Database, personasDir?: string): SyncDiffResult {
  const personas = scanPersonas(personasDir);
  const result: SyncDiffResult = { created: [], updated: [], unchanged: [], skipped: [] };

  for (const persona of personas) {
    const { name, frontmatter } = persona;
    const engine = frontmatter.engine;
    const cwd = frontmatter.cwd;

    if (!engine || !VALID_ENGINES.has(engine) || !cwd) {
      result.skipped.push(name);
      continue;
    }

    const existing = db.getAgent(name);
    const upsertOpts = {
      name,
      engine: engine as EngineType,
      model: frontmatter.model as string | undefined,
      thinking: frontmatter.thinking as string | undefined,
      cwd,
      persona: name,
      permissions: frontmatter.permissions as string | undefined,
      proxyHost: frontmatter.proxy_host as string | undefined,
      agentGroup: frontmatter.group as string | undefined,
      launchEnv: normalizeLaunchEnv(frontmatter.env),
      hookStart: serializeHookValue(frontmatter.start ?? frontmatter.spawn),
      hookResume: serializeHookValue(frontmatter.resume),
      hookCompact: serializeHookValue(frontmatter.compact),
      hookExit: serializeHookValue(frontmatter.exit),
      hookInterrupt: serializeHookValue(frontmatter.interrupt),
      hookSubmit: serializeHookValue(frontmatter.submit),
      hookDetectSession: serializeHookValue(frontmatter.detect_session),
      detectSessionRegex: frontmatter.detect_session_regex as string | undefined,
    };

    if (!existing) {
      db.upsertAgentFromPersona(upsertOpts);
      result.created.push(name);
    } else {
      // Check if any config fields differ
      const changed =
        existing.engine !== upsertOpts.engine ||
        !optionalScalarEquals(existing.model, upsertOpts.model) ||
        !optionalScalarEquals(existing.thinking, upsertOpts.thinking) ||
        existing.cwd !== upsertOpts.cwd ||
        !optionalScalarEquals(existing.permissions, upsertOpts.permissions) ||
        !optionalScalarEquals(existing.proxyHost, upsertOpts.proxyHost) ||
        !optionalScalarEquals(existing.agentGroup, upsertOpts.agentGroup) ||
        !launchEnvEquals(existing.launchEnv, upsertOpts.launchEnv) ||
        !optionalScalarEquals(existing.hookStart, upsertOpts.hookStart) ||
        !optionalScalarEquals(existing.hookResume, upsertOpts.hookResume) ||
        !optionalScalarEquals(existing.hookCompact, upsertOpts.hookCompact) ||
        !optionalScalarEquals(existing.hookExit, upsertOpts.hookExit) ||
        !optionalScalarEquals(existing.hookInterrupt, upsertOpts.hookInterrupt) ||
        !optionalScalarEquals(existing.hookSubmit, upsertOpts.hookSubmit) ||
        !optionalScalarEquals(existing.hookDetectSession, upsertOpts.hookDetectSession) ||
        !optionalScalarEquals(existing.detectSessionRegex, upsertOpts.detectSessionRegex);

      if (changed) {
        db.upsertAgentFromPersona(upsertOpts);
        result.updated.push(name);
      } else {
        result.unchanged.push(name);
      }
    }
  }

  return result;
}

// ── Atomic Persona Creation ──

/**
 * Write a persona file to persistent-agents/<name>.md and upsert the agent
 * into the database in one atomic operation.
 * Returns the parsed persona on success.
 */
export function createPersonaAndAgent(
  db: Database,
  name: string,
  content: string,
  personasDir?: string,
): ParsedPersona {
  const dir = personasDir ?? getPersonasDir();
  const { frontmatter, body } = parseFrontmatter(content);
  const fm = frontmatter as PersonaFrontmatter;

  const engine = fm.engine;
  const cwd = fm.cwd;
  if (!engine || !VALID_ENGINES.has(engine) || !cwd) {
    throw new Error(`engine and cwd are required in frontmatter (got engine=${engine ?? 'undefined'}, cwd=${cwd ?? 'undefined'})`);
  }

  // Write file
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8');

  // Upsert agent
  db.upsertAgentFromPersona({
    name,
    engine: engine as EngineType,
    model: fm.model as string | undefined,
    thinking: fm.thinking as string | undefined,
    cwd,
    persona: name,
    permissions: fm.permissions as string | undefined,
    proxyHost: fm.proxy_host as string | undefined,
    agentGroup: fm.group as string | undefined,
    launchEnv: normalizeLaunchEnv(fm.env),
    hookStart: serializeHookValue(fm.start ?? fm.spawn),
    hookResume: serializeHookValue(fm.resume),
    hookCompact: serializeHookValue(fm.compact),
    hookExit: serializeHookValue(fm.exit),
    hookInterrupt: serializeHookValue(fm.interrupt),
    hookSubmit: serializeHookValue(fm.submit),
    hookDetectSession: serializeHookValue(fm.detect_session),
    detectSessionRegex: fm.detect_session_regex as string | undefined,
  });

  return { name, frontmatter: fm, body };
}
