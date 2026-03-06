/**
 * Agent persona loading.
 * Resolves persona files from persistent-agents/<name>.md by convention.
 * Composes system prompt: persona + messaging instructions + orchestrator rules.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PERSONAS_DIR = process.env['PERSONAS_DIR'] ?? join(process.env['HOME'] ?? '/data', 'persistent-agents');

/**
 * Resolve persona file path for an agent.
 * 1. Check persistent-agents/<name>.md (convention)
 * 2. If explicit path provided, use that instead
 * 3. If neither found, return null
 */
export function resolvePersonaPath(agentName: string, explicitPath?: string | null): string | null {
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const conventionPath = join(PERSONAS_DIR, `${agentName}.md`);
  if (existsSync(conventionPath)) {
    return conventionPath;
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
