/**
 * Agent persona loading.
 * Resolves persona files from persistent-agents/<name>.md by convention.
 * Composes system prompt: persona + messaging instructions + orchestrator rules.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

export const PERSONAS_DIR = process.env['PERSONAS_DIR'] ?? join(process.env['HOME'] ?? '/data', 'persistent-agents');

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
 * Load persona content from file.
 */
export function loadPersona(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
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
