/**
 * Agent persona loading.
 * Resolves persona files from persistent-agents/<name>.md by convention.
 * Composes system prompt: persona + messaging instructions + orchestrator rules.
 * Parses YAML-like frontmatter for agent configuration.
 */

import { readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

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
  /** Hook value for starting the agent (preset:<engine>, file:<path>, or inline command). */
  start?: string;
  /** Hook value for resuming the agent. */
  resume?: string;
  /** Hook value for compacting the agent. */
  compact?: string;
  /** Hook value for exiting the agent. */
  exit?: string;
  /** Hook value for interrupting the agent. */
  interrupt?: string;
  /** Hook value for submitting messages to the agent. */
  submit?: string;
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
formatted as: [from: <sender>, reply with collab reply]: '<message>'

You have the \`collab\` CLI on your PATH. It is a standalone binary — run it directly (e.g. \`collab send ...\`), NOT via pnpm or any repo skill.
IMPORTANT: Do NOT use \`pnpm collaboration\` or any other wrapper. Always use the bare \`collab\` command.
It auto-discovers auth and the orchestrator.
Your agent name is set via COLLAB_AGENT=${opts.agentName}.

Send a message to another agent:
  collab send <to> <message>

Reply to the dashboard (human operator):
  collab reply <message> [--topic <topic>]

List all agents:
  collab agents

Check orchestrator status:
  collab status

Spawn a new agent:
  collab spawn <name> [task...]

Agent lifecycle:
  collab exit <name>
  collab resume <name> [task...]
  collab interrupt <name>
  collab compact <name>
  collab kill <name>
  collab reload <name> [task...]

View message queue:
  collab queue [--agent <name>]

View agent events:
  collab events <name> [--limit N]

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
    model: fm.model,
    thinking: fm.thinking,
    cwd,
    persona: name,
    permissions: fm.permissions,
    proxyHost: fm.proxy_host,
    agentGroup: fm.group,
    hookStart: fm.start ?? fm.spawn,
    hookResume: fm.resume,
    hookCompact: fm.compact,
    hookExit: fm.exit,
    hookInterrupt: fm.interrupt,
    hookSubmit: fm.submit,
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
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      cwd,
      persona: name,
      permissions: frontmatter.permissions,
      proxyHost: frontmatter.proxy_host,
      agentGroup: frontmatter.group,
      hookStart: frontmatter.start ?? frontmatter.spawn,
      hookResume: frontmatter.resume,
      hookCompact: frontmatter.compact,
      hookExit: frontmatter.exit,
      hookInterrupt: frontmatter.interrupt,
      hookSubmit: frontmatter.submit,
    });

    synced++;
  }

  return synced;
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
    model: fm.model,
    thinking: fm.thinking,
    cwd,
    persona: name,
    permissions: fm.permissions,
    proxyHost: fm.proxy_host,
    agentGroup: fm.group,
    hookStart: fm.start ?? fm.spawn,
    hookResume: fm.resume,
    hookCompact: fm.compact,
    hookExit: fm.exit,
    hookInterrupt: fm.interrupt,
    hookSubmit: fm.submit,
  });

  return { name, frontmatter: fm, body };
}
