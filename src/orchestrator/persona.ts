/**
 * Agent persona loading.
 * Resolves persona files from persistent-agents/<name>.md by convention.
 * Composes system prompt: persona + messaging instructions + orchestrator rules.
 * Parses YAML-like frontmatter for agent configuration.
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

export const PERSONAS_DIR = process.env['PERSONAS_DIR'] ?? join(process.env['HOME'] ?? '/data', 'persistent-agents');

export function getPersonasDir(): string {
  return process.env['PERSONAS_DIR'] ?? PERSONAS_DIR;
}

// ── Frontmatter ──

export type PersonaFrontmatter = {
  engine?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  proxy_host?: string;
  permissions?: string;
};

export type ParsedPersona = {
  name: string;
  frontmatter: PersonaFrontmatter;
  body: string;
};

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Expects `---` delimiters. Values are trimmed strings; no nested objects.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
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

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) frontmatter[key] = val;
  }

  return { frontmatter, body };
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

  // Messaging instructions
  parts.push(`Messages from other agents arrive as text in your tmux pane
formatted as: [from: <sender>, reply with /collaboration reply]: '<message>'

When you need to communicate with another agent:
  curl -s -X POST ${opts.orchestratorHost}/api/agents/send \\
    -H 'Content-Type: application/json' \\
    -d '{"from":"${opts.agentName}","to":"TARGET","message":"YOUR MESSAGE"}'

To include reply context:
  -d '{"from":"${opts.agentName}","to":"TARGET","message":"...","re":"topic"}'

To reply to the dashboard (human operator):
  curl -s -X POST ${opts.orchestratorHost}/api/dashboard/reply \\
    -H 'Content-Type: application/json' \\
    -d '{"agent":"${opts.agentName}","message":"YOUR REPLY","topic":"optional-topic"}'

To list active agents:
  curl -s ${opts.orchestratorHost}/api/agents`);

  if (opts.peers && opts.peers.length > 0) {
    parts.push(`\n\nKnown peers: ${opts.peers.join(', ')}`);
  }

  parts.push(`

Use /compact proactively when your context grows large.
Keep context light — delegate to sub-agents when appropriate.
When you finish a task or have results, report back to the orchestrator.`);

  return parts.join('\n');
}

// ── Startup Sync ──

import type { Database } from './database.ts';
import type { EngineType } from '../shared/types.ts';

const VALID_ENGINES = new Set<string>(['claude', 'codex', 'opencode']);

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
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      cwd,
      persona: name,
      permissions: frontmatter.permissions,
      proxyHost: frontmatter.proxy_host,
    });

    synced++;
  }

  return synced;
}
