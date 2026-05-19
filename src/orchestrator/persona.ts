/**
 * Agent persona loading.
 * Resolves persona files from persistent-agents/<name>.md by convention.
 * Composes system prompt: persona + messaging instructions + orchestrator rules.
 * Parses YAML-like frontmatter for agent configuration.
 */

import { readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { StructuredHook, HookValue, SendAction, LaunchEnv, PipelineStep, IndicatorDefinition } from '../shared/types.ts';

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
  permissions?: string;
  group?: string;
  /** Named credential account for per-agent HOME isolation. */
  account?: string;
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
  /** Legacy alias for start (backward compat). */
  spawn?: HookValue;
  /** Custom dashboard buttons — named keys mapping to pipeline step arrays. */
  custom_buttons?: Record<string, PipelineStep[]>;
  /** Indicators — regex patterns matched against tmux pane output. */
  indicators?: IndicatorDefinition[];
  /** Emoji or short text shown on agent cards and in page title. */
  icon?: string;

  // ── v3 template fields (ephemeral-agent only; persistent agents ignore these). ──

  /** When false, persona declares an ephemeral agent template — not a live persistent agent. */
  persistent?: boolean;
  /** Base directory for ephemeral instances; must exist on the proxy host. */
  cwd_base?: string;
  /** Per-message worktree path template (supports {{message_id}} substitution). */
  cwd_template?: string;
  /** Source repository for `git worktree add` (defaults to cwd_base when null). */
  repo_root?: string;
  /** Host-shell hook executed via proxy `exec` before tmux session creation. */
  prepare?: HookValue;
  /** Host-shell hook executed via proxy `exec` after tmux session teardown. */
  cleanup?: HookValue;
  /** Topic declarations — addressable as `topic:<template>/<topic-name>`. */
  topics?: TopicSpec[];
};

/**
 * One entry in an ephemeral template's `topics` array. Each topic is a routable
 * address (`topic:<template>/<name>`) that triggers an ephemeral spawn.
 */
export type TopicSpec = {
  name: string;
  schema?: string;
  reply_schema?: string;
  concurrency?: number;
  monitor_template?: string;
  prepare?: HookValue;
  start?: HookValue;
  cleanup?: HookValue;
};

export type ParsedPersona = {
  name: string;
  frontmatter: PersonaFrontmatter;
  body: string;
};

import { nestedPersonaKeys, configFieldsChanged, buildUpsertOptsFromFrontmatter } from './field-registry.ts';

/** Frontmatter field names that support structured (nested) values.
 *  Note: `prepare` and `cleanup` are v3 host-shell hooks. They are template-only
 *  fields — they never round-trip through the scalar field-registry or the
 *  `agents` table; they live exclusively on `agent_templates` rows.
 */
const NESTED_FIELDS = new Set([...nestedPersonaKeys(), 'env', 'spawn', 'prepare', 'cleanup']);

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

    // custom_buttons has a two-level structure: named keys → pipeline step arrays
    if (key === 'custom_buttons' && trimmedVal === '' && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent > 0) {
        const { value, nextLine: endLine } = parseCustomButtons(lines, i + 1, nextIndent);
        frontmatter[key] = value;
        i = endLine;
        continue;
      }
    }

    // indicators: named keys with regex/badge/style/actions
    if (key === 'indicators' && trimmedVal === '' && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent > 0) {
        const { value, nextLine: endLine } = parseIndicators(lines, i + 1, nextIndent);
        frontmatter[key] = value;
        i = endLine;
        continue;
      }
    }

    // topics: array of objects with name/schema/reply_schema/concurrency/...
    // Follows the indicators precedent — parsed separately, written via the
    // new template-sync routine (NEVER via the scalar field-registry).
    if (key === 'topics' && trimmedVal === '' && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent > 0) {
        const { value, nextLine: endLine } = parseTopics(lines, i + 1, nextIndent);
        frontmatter[key] = value;
        i = endLine;
        continue;
      }
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
      // "keystrokes" and "send" are aliases — both parse the same SendAction sub-array.
      // "keystrokes" is preferred; "send" is kept for backward compat.
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
    } else if (stepKey === 'keystroke') {
      steps.push({ type: 'keystroke', key: stepVal });
      i++;
    } else if (stepKey === 'wait') {
      const ms = typeof coerceScalar(stepVal) === 'number' ? coerceScalar(stepVal) as number : parseInt(stepVal, 10);
      steps.push({ type: 'wait', ms: isNaN(ms) ? 0 : ms });
      i++;
    } else {
      throw new Error(`Unknown pipeline step type: ${stepKey}`);
    }
  }

  return { value: steps, nextLine: i };
}

/**
 * Parse a map of named keys → pipeline step arrays.
 * Shared primitive for custom_buttons and indicator actions.
 *
 * Example structure (at baseIndent=2):
 *   compact:
 *     - shell: /compact
 *     - keystrokes:
 *       - keystroke: Enter
 *   clear-context:
 *     - keystrokes:
 *       - keystroke: Escape
 *     - shell: /clear
 */
function parseNamedPipelineMap(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: Record<string, PipelineStep[]>; nextLine: number } {
  const result: Record<string, PipelineStep[]> = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    // Expect a named key at baseIndent level: "  compact:"
    if (lineIndent === baseIndent) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { i++; continue; }
      const name = line.slice(0, colonIdx).trim();
      if (!name) { i++; continue; }

      // Next lines should be pipeline steps at deeper indent
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1]!;
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent > baseIndent && nextLine.trim().startsWith('- ')) {
          const { value: steps, nextLine: endLine } = parsePipelineSteps(lines, i + 1, nextIndent);
          result[name] = steps;
          i = endLine;
          continue;
        }
      }
      // Named key with no steps — skip
      i++;
    } else {
      // Deeper indent line that doesn't belong to us — stop
      break;
    }
  }

  return { value: result, nextLine: i };
}

/** Parse custom_buttons — thin wrapper around parseNamedPipelineMap. */
function parseCustomButtons(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: Record<string, PipelineStep[]>; nextLine: number } {
  return parseNamedPipelineMap(lines, startLine, baseIndent);
}

/**
 * Parse indicators: a two-level structure of named keys → indicator definitions.
 * Each indicator has scalar properties (regex, badge, style) and an optional
 * actions sub-key containing named action keys mapping to pipeline step arrays.
 *
 * indicators:
 *   approval:
 *     regex: '(Yes|No|Always allow)'
 *     badge: Needs Approval
 *     style: warning
 *     actions:
 *       approve:
 *         - keystroke: y
 *       deny:
 *         - keystroke: n
 *   low-context:
 *     regex: 'Context left until'
 *     badge: Low Context
 *     style: danger
 */
function parseIndicators(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: IndicatorDefinition[]; nextLine: number } {
  const indicators: IndicatorDefinition[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    // Expect an indicator name at baseIndent level: "  approval:"
    if (lineIndent === baseIndent) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { i++; continue; }
      const indicatorName = line.slice(0, colonIdx).trim();
      if (!indicatorName) { i++; continue; }

      // Parse properties at baseIndent+2
      const propIndent = baseIndent + 2;
      i++;
      let regex = '';
      let badge = '';
      let style: 'warning' | 'danger' | 'info' = 'info';
      let actions: Record<string, PipelineStep[]> | undefined;

      while (i < lines.length) {
        const propLine = lines[i]!;
        if (propLine.trim() === '') { i++; continue; }

        const propLineIndent = propLine.length - propLine.trimStart().length;
        if (propLineIndent < propIndent) break;

        const propContent = propLine.trim();
        const propColonIdx = propContent.indexOf(':');
        if (propColonIdx === -1) { i++; continue; }

        const propKey = propContent.slice(0, propColonIdx).trim();
        const propVal = propContent.slice(propColonIdx + 1).trim();

        if (propKey === 'regex') {
          // Strip surrounding quotes if present
          regex = propVal.replace(/^['"]|['"]$/g, '');
          i++;
        } else if (propKey === 'badge') {
          badge = propVal;
          i++;
        } else if (propKey === 'style') {
          if (propVal === 'warning' || propVal === 'danger' || propVal === 'info') {
            style = propVal;
          }
          i++;
        } else if (propKey === 'actions' && propVal === '') {
          // Parse named action keys → pipeline step arrays (delegates to shared primitive)
          const actionIndent = propIndent + 2;
          const { value: actionMap, nextLine: actionEnd } = parseNamedPipelineMap(lines, i + 1, actionIndent);
          actions = Object.keys(actionMap).length > 0 ? actionMap : undefined;
          i = actionEnd;
        } else {
          i++;
        }
      }

      if (regex && badge) {
        indicators.push({ id: indicatorName, regex, badge, style, ...(actions ? { actions } : {}) });
      }
    } else {
      break;
    }
  }

  return { value: indicators, nextLine: i };
}

/**
 * Parse the `topics:` array. Each item begins with `- name: <name>` and may
 * carry scalar fields (schema, reply_schema, concurrency, monitor_template)
 * plus optional per-topic hook overrides (prepare, start, cleanup) that may be
 * block scalars (`|`).
 *
 * Mirrors the indicators precedent: the result is structured data parsed in
 * persona.ts and written via the new template-sync routine — it does NOT pass
 * through the scalar field-registry that targets the `agents` table.
 *
 * Example YAML:
 *   topics:
 *     - name: provision
 *       schema: ./schemas/provision.json
 *       reply_schema: ./schemas/provision-reply.json
 *       concurrency: 1
 *       monitor_template: aws-account-monitor
 *     - name: teardown
 *       schema: ./schemas/teardown.json
 *       prepare: ./teardown-prepare.sh
 */
function parseTopics(
  lines: string[],
  startLine: number,
  baseIndent: number,
): { value: TopicSpec[]; nextLine: number } {
  const topics: TopicSpec[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < baseIndent) break;

    const content = line.trim();
    if (!content.startsWith('- ')) break;

    // First field on the same line as "- ", e.g. "- name: provision"
    const headField = content.slice(2).trim();
    const headColon = headField.indexOf(':');

    const topic: Record<string, unknown> = {};
    if (headColon !== -1) {
      const k = headField.slice(0, headColon).trim();
      const v = headField.slice(headColon + 1).trim();
      if (k) topic[k] = v === '' ? '' : coerceScalar(v);
    }
    i++;

    // Continuation lines for this topic item — indent must exceed the "-" column.
    const itemIndent = baseIndent + 2; // two chars consumed by "- "
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === '') { i++; continue; }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent < itemIndent) break;
      if (next.trim().startsWith('- ')) break; // next topic

      const propContent = next.trim();
      const propColon = propContent.indexOf(':');
      if (propColon === -1) { i++; continue; }

      const propKey = propContent.slice(0, propColon).trim();
      const propVal = propContent.slice(propColon + 1).trim();

      // Block scalar (| or >) for hook fields
      if (propVal === '|' || propVal === '>') {
        const { value, nextLine: endLine } = parseBlockScalar(lines, i + 1);
        topic[propKey] = value;
        i = endLine;
        continue;
      }

      topic[propKey] = propVal === '' ? '' : coerceScalar(propVal);
      i++;
    }

    topics.push(coerceTopicSpec(topic));
  }

  return { value: topics, nextLine: i };
}

/** Coerce a raw parsed topic object into a TopicSpec, keeping only known keys. */
function coerceTopicSpec(raw: Record<string, unknown>): TopicSpec {
  const out: TopicSpec = {
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
  };
  if (typeof raw['schema'] === 'string' && raw['schema']) out.schema = raw['schema'];
  if (typeof raw['reply_schema'] === 'string' && raw['reply_schema']) out.reply_schema = raw['reply_schema'];
  if (typeof raw['concurrency'] === 'number') {
    out.concurrency = raw['concurrency'];
  } else if (typeof raw['concurrency'] === 'string' && raw['concurrency'] !== '') {
    const n = Number(raw['concurrency']);
    if (Number.isFinite(n)) out.concurrency = n;
  }
  if (typeof raw['monitor_template'] === 'string' && raw['monitor_template']) {
    out.monitor_template = raw['monitor_template'];
  }
  if (typeof raw['prepare'] === 'string' && raw['prepare']) out.prepare = raw['prepare'];
  if (typeof raw['start'] === 'string' && raw['start']) out.start = raw['start'];
  if (typeof raw['cleanup'] === 'string' && raw['cleanup']) out.cleanup = raw['cleanup'];
  return out;
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
    const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort();
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
  parts.push(`You have the \`collab\` CLI on your PATH (standalone binary, not a pnpm script).
Your agent name: COLLAB_AGENT=${opts.agentName}

Incoming messages appear as: [from: <sender>, reply with collab send <sender> --topic <topic>]: '<message>'

Core commands:
  collab send operator --topic <t> <msg>      # message the human operator
  collab send <agent> --topic <t> <msg>       # message a peer agent
  collab agents                               # list all agents + status
  collab queue [--agent X] [--status S] [--limit N]  # message history

Tmux (routed through orchestrator to the correct proxy):
  collab tmux <agent> -- capture-pane         # read agent's terminal output
  collab tmux <agent> -- send-keys '/compact' Enter  # type /compact and press Enter
  collab tmux <agent> -- send-keys Enter      # press Enter
  collab tmux <agent> -- display-message -p '#{pane_pid}'  # query tmux variables

Reminders:
  collab reminder add <agent> "prompt" --cadence 30m
  collab reminder list
  collab reminder done <id>

Run \`collab help\` for full command reference.`);

  if (opts.peers && opts.peers.length > 0) {
    parts.push(`\n\nKnown peers: ${opts.peers.join(', ')}`);
  }

  parts.push(`

Your terminal output, tool calls, and reasoning are invisible to the operator — only messages you send via \`collab send operator\` appear on the dashboard.

Use /compact proactively when your context grows large.
Keep context light — delegate to sub-agents when appropriate.`);

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

/** Serialize custom_buttons for database storage. */
function serializeCustomButtons(value?: Record<string, PipelineStep[]>): string | null {
  if (value == null || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

/** Serialize indicators for database storage. */
function serializeIndicators(value?: IndicatorDefinition[]): string | null {
  if (value == null || value.length === 0) return null;
  return JSON.stringify(value);
}

// ── Startup Sync ──

import type { Database } from './database.ts';
import { syncTemplate, type TemplateSyncEventSink } from './template-sync.ts';

/** Any non-empty engine string is valid. Engine configs provide defaults but are not required. */
function isValidEngine(engine: string | undefined | null): engine is string {
  return typeof engine === 'string' && engine.length > 0;
}

function buildUpsertOpts(name: string, fm: PersonaFrontmatter): Parameters<Database['upsertAgentFromPersona']>[0] {
  return buildUpsertOptsFromFrontmatter(name, fm) as Parameters<Database['upsertAgentFromPersona']>[0];
}

/** True if this persona declares an ephemeral template (`persistent: false`).
 *  Persistent is the default — absent means true. The frontmatter parser keeps
 *  flat top-level scalars as raw strings (it doesn't coerce booleans), so we
 *  accept either the boolean `false` or the literal string `'false'`.
 */
function isEphemeralTemplate(fm: PersonaFrontmatter): boolean {
  const raw = (fm as Record<string, unknown>)['persistent'];
  return raw === false || raw === 'false';
}

/** Run syncTemplate against the persona, downgrading exceptions to warnings.
 *  Returns true if a template row was written, false if validation failed.
 *  `onTemplateEvent` is forwarded to syncTemplate so callers can wire the
 *  orchestrator's `wss.broadcastEvent` for Q4 `template_updated` events. */
function trySyncTemplate(
  db: Database,
  name: string,
  fm: PersonaFrontmatter,
  personaPath: string | null,
  onTemplateEvent?: TemplateSyncEventSink,
): boolean {
  try {
    syncTemplate(db, name, fm, personaPath, onTemplateEvent);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[template-sync] Skipping template "${name}": ${msg}`);
    return false;
  }
}

/**
 * Re-sync a single agent's persona from disk.
 * Call before spawn/resume to pick up config changes (engine, model, etc.).
 * Returns true if the persona was found and synced.
 */
export function syncSinglePersona(
  db: Database,
  name: string,
  personasDir?: string,
  onTemplateEvent?: TemplateSyncEventSink,
): boolean {
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

  const resolvedEngine = fm.engine;
  if (!resolvedEngine || !isValidEngine(resolvedEngine)) return false;

  // v3: every loaded persona produces an `agent_templates` row (persistent
  // or ephemeral). Failures here are logged but don't block persistent-agent
  // sync for backwards compatibility.
  trySyncTemplate(db, name, fm, filePath, onTemplateEvent);

  // Ephemeral templates do NOT populate the `agents` table — they have no
  // cwd, and the `agents` schema is intentionally untouched in v3.
  if (isEphemeralTemplate(fm)) {
    return true;
  }

  // Persistent path — unchanged from 2.x.
  const cwd = fm.cwd;
  if (!cwd) return false;

  const upsertOpts = buildUpsertOpts(name, fm);
  db.upsertAgentFromPersona(upsertOpts);
  return true;
}

/**
 * Scan persona files and idempotently merge into SQLite.
 * Creates new agents, updates config fields on existing ones.
 * Preserves runtime state (active/idle/suspended, session, proxy, etc.).
 * Returns count of agents synced.
 */
export function syncPersonasToDb(
  db: Database,
  personasDir?: string,
  onTemplateEvent?: TemplateSyncEventSink,
): number {
  const personas = scanPersonas(personasDir);
  const dir = personasDir ?? getPersonasDir();
  let synced = 0;

  for (const persona of personas) {
    const { name, frontmatter } = persona;
    const resolvedEngine = frontmatter.engine;

    // engine is required for both persistent and ephemeral paths.
    if (!resolvedEngine || !isValidEngine(resolvedEngine)) {
      console.warn(`[persona-sync] Skipping "${name}.md": engine is required (got ${resolvedEngine ?? 'undefined'})`);
      continue;
    }

    // v3: every persona produces an `agent_templates` row. Ephemeral templates
    // are validated by template-sync (which throws on missing cwd_base, etc.).
    const personaPath = join(dir, `${name}.md`);
    const templated = trySyncTemplate(db, name, frontmatter, personaPath, onTemplateEvent);

    if (isEphemeralTemplate(frontmatter)) {
      // Ephemeral templates skip the `agents` table entirely. The `cwd`-required
      // gate stays for persistent personas only.
      if (templated) synced++;
      continue;
    }

    // Persistent path — unchanged 2.x behavior, including the cwd-required gate.
    const cwd = frontmatter.cwd;
    if (!cwd) {
      console.warn(`[persona-sync] Skipping "${name}.md": engine and cwd are required (got engine=${resolvedEngine}, cwd=${cwd ?? 'undefined'})`);
      continue;
    }

    const upsertOpts = buildUpsertOpts(name, frontmatter);
    db.upsertAgentFromPersona(upsertOpts);

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

/** Validate cwd, logging warnings for invalid values. */
function validateFrontmatter(name: string, fm: PersonaFrontmatter): string[] {
  const warnings: string[] = [];
  if (fm.cwd && !existsSync(fm.cwd)) {
    warnings.push(`cwd "${fm.cwd}" does not exist`);
  }
  for (const w of warnings) {
    console.warn(`[persona] ${name}: ${w}`);
  }
  return warnings;
}

export function syncPersonasWithDiff(
  db: Database,
  personasDir?: string,
  onTemplateEvent?: TemplateSyncEventSink,
): SyncDiffResult {
  const personas = scanPersonas(personasDir);
  const dir = personasDir ?? getPersonasDir();
  const result: SyncDiffResult = { created: [], updated: [], unchanged: [], skipped: [] };

  for (const persona of personas) {
    const { name, frontmatter } = persona;
    const resolvedEngine = frontmatter.engine;

    if (!resolvedEngine || !isValidEngine(resolvedEngine)) {
      result.skipped.push(name);
      continue;
    }

    // v3: every persona produces an `agent_templates` row. Persistent rows
    // get a minimal template; ephemeral ones additionally populate `topics`.
    const personaPath = join(dir, `${name}.md`);
    const templated = trySyncTemplate(db, name, frontmatter, personaPath, onTemplateEvent);

    if (isEphemeralTemplate(frontmatter)) {
      // Ephemeral templates do not appear in the `agents` table. They are
      // tracked exclusively in `agent_templates` (and `topics`) — the
      // template-sync routine is the source of truth.
      if (templated) {
        // Treat first-time template install as "created", subsequent calls
        // as "unchanged" for diff reporting. We don't deep-diff templates
        // here — Q3 will add proper template diffing if needed.
        result.unchanged.push(name);
      } else {
        result.skipped.push(name);
      }
      continue;
    }

    // Persistent path — unchanged 2.x behavior.
    const cwd = frontmatter.cwd;
    if (!cwd) {
      result.skipped.push(name);
      continue;
    }

    validateFrontmatter(name, frontmatter);

    const existing = db.getAgent(name);
    const upsertOpts = buildUpsertOpts(name, frontmatter);

    if (!existing) {
      db.upsertAgentFromPersona(upsertOpts);
      result.created.push(name);
    } else {
      // Check if any config fields differ (registry-driven comparison)
      if (configFieldsChanged(existing, upsertOpts)) {
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

  const cwd = fm.cwd;

  const resolvedEngine = fm.engine;
  if (!resolvedEngine || !isValidEngine(resolvedEngine) || !cwd) {
    throw new Error(`engine and cwd are required in frontmatter (got engine=${resolvedEngine ?? 'undefined'}, cwd=${cwd ?? 'undefined'})`);
  }
  validateFrontmatter(name, fm);

  // Write file
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8');

  // Upsert agent
  const upsertOpts = buildUpsertOpts(name, fm);
  db.upsertAgentFromPersona(upsertOpts);

  return { name, frontmatter: fm, body };
}
