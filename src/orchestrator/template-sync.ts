/**
 * Template-sync — populates the `agent_templates` and `topics` tables from
 * persona frontmatter.
 *
 * This is the v3 sibling of `syncPersonasToDb`. Every persona loaded from
 * disk produces an `agent_templates` row regardless of `persistent` value,
 * so Q3+ can address templates uniformly. Ephemeral templates
 * (`persistent: false`) additionally populate the `topics` table.
 *
 * **Hard rule:** the new fields (`persistent`, `cwd_base`, `cwd_template`,
 * `repo_root`, `prepare`, `cleanup`, `topics`) NEVER flow through the
 * scalar field-registry that targets the `agents` table. They live
 * exclusively in `agent_templates` and `topics`.
 */

import type { AgentTemplateRow, TopicRow } from '../shared/types.ts';
import type { Database } from './database.ts';
import type { PersonaFrontmatter, TopicSpec } from './persona.ts';
import { serializeHookValue } from './persona.ts';

/** Topic names follow the same shape as agent identifiers. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Idempotently sync one persona to the template tables.
 *
 * - Persistent templates (default when `persistent` is absent or true): only
 *   engine, model, hook_start, hook_exit are stored. Topics are ignored (a
 *   warning is logged if any are present alongside `persistent: true`).
 * - Ephemeral templates (`persistent: false`): require `cwd_base`. Stores all
 *   template fields and replaces the topics table contents for this template.
 *
 * Throws on validation failure; callers (persona.ts sync routines) catch
 * and downgrade to a `console.warn` + skip.
 */
export function syncTemplate(
  db: Database,
  name: string,
  fm: PersonaFrontmatter,
  personaPath: string | null,
): void {
  const engine = fm.engine;
  if (!engine || typeof engine !== 'string' || engine.length === 0) {
    throw new Error(`template "${name}": engine is required`);
  }

  // Spec: `persistent` defaults to true when absent (backwards compatibility
  // with today's persona files). The frontmatter parser leaves flat top-level
  // scalars as raw strings (it does not coerce booleans), so accept both
  // boolean and string forms here.
  const rawPersistent = (fm as Record<string, unknown>)['persistent'];
  const persistent = !(rawPersistent === false || rawPersistent === 'false');

  if (persistent) {
    // Persistent templates: ignore the v3 ephemeral-only fields.
    if (fm.topics && fm.topics.length > 0) {
      console.warn(`[template-sync] "${name}": topics declared on a persistent template are ignored.`);
    }
    const row: AgentTemplateRow = {
      id: name,
      personaPath,
      engine,
      model: fm.model ?? null,
      persistent: true,
      cwdBase: null,
      cwdTemplate: null,
      repoRoot: null,
      hookStart: serializeHookValue(fm.start ?? fm.spawn),
      hookExit: serializeHookValue(fm.exit),
      hookPrepare: null,
      hookCleanup: null,
      createdAt: '',
      updatedAt: '',
    };
    db.upsertAgentTemplate(row);
    // Persistent templates: clear any stale topics rows from a prior
    // ephemeral lifetime of the same template id.
    db.replaceTopicsForTemplate(name, []);
    return;
  }

  // Ephemeral template path.
  if (!fm.cwd_base || typeof fm.cwd_base !== 'string') {
    throw new Error(`template "${name}": persistent: false template requires cwd_base`);
  }

  const topics = validateTopics(name, fm.topics ?? []);

  const row: AgentTemplateRow = {
    id: name,
    personaPath,
    engine,
    model: fm.model ?? null,
    persistent: false,
    cwdBase: fm.cwd_base,
    cwdTemplate: fm.cwd_template ?? null,
    repoRoot: fm.repo_root ?? null,
    hookStart: serializeHookValue(fm.start ?? fm.spawn),
    hookExit: serializeHookValue(fm.exit),
    hookPrepare: serializeHookValue(fm.prepare),
    hookCleanup: serializeHookValue(fm.cleanup),
    createdAt: '',
    updatedAt: '',
  };
  db.upsertAgentTemplate(row);

  const topicRows: TopicRow[] = topics.map((t) => ({
    agentTemplate: name,
    name: t.name,
    hookPrepareOverride: serializeHookValue(t.prepare ?? null),
    hookStartOverride: serializeHookValue(t.start ?? null),
    hookCleanupOverride: serializeHookValue(t.cleanup ?? null),
    monitorTemplate: t.monitor_template ?? null,
    concurrency: t.concurrency ?? 1,
    schemaPath: t.schema ?? null,
    replySchemaPath: t.reply_schema ?? null,
  }));
  db.replaceTopicsForTemplate(name, topicRows);
}

/** Validate parsed TopicSpec entries; throws on the first failure to avoid
 *  partial inserts. */
function validateTopics(templateName: string, specs: TopicSpec[]): TopicSpec[] {
  const seen = new Set<string>();
  for (const t of specs) {
    if (!t.name || typeof t.name !== 'string' || !NAME_RE.test(t.name)) {
      throw new Error(`template "${templateName}": invalid or missing topic name: ${JSON.stringify(t.name)}`);
    }
    if (seen.has(t.name)) {
      throw new Error(`template "${templateName}": duplicate topic "${t.name}"`);
    }
    seen.add(t.name);

    if (t.concurrency !== undefined) {
      if (!Number.isInteger(t.concurrency) || t.concurrency < 1) {
        throw new Error(
          `template "${templateName}" topic "${t.name}": concurrency must be a positive integer (got ${t.concurrency})`,
        );
      }
    }
  }
  return specs;
}
