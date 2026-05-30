/**
 * RFC-004 boot migration: make persona files the complete source of truth
 * before they become the master agent list.
 *
 * For every agent that already HAS a persona file, write any scalar
 * frontmatter-backed config field (engine, model, thinking, cwd, permissions,
 * group, account, proxy, icon) that the file omits but the DB row has — gaps
 * only, never clobbering a value already declared in the file. The persona
 * file always wins on conflict.
 *
 * Reported, never written:
 *  - fileless agents (in the DB but no persona file) — NOT auto-created;
 *    operator supplies a file or deletes the row.
 *  - DB-only nested config (env / hooks / json) missing from the file — needs
 *    the full frontmatter serializer that arrives with write-through (Stage 3);
 *    surfaced here so nothing is silently dropped.
 *
 * Idempotent, additive, reversible: touches persona files only (gap-fill), never
 * writes the DB and never drops anything. Safe to run on every boot.
 */
import { readFileSync } from 'node:fs';
import type { AgentRecord } from '../shared/types.ts';
import { CONFIG_FIELDS } from './field-registry.ts';
import { getPersonasDir, parseFrontmatter, resolvePersonaPath, updateFrontmatterField, serializeTeams } from './persona.ts';

export interface BackfillReport {
  /** scalar gaps written into files, per agent */
  filled: Array<{ name: string; fields: string[] }>;
  /** DB agents with no persona file — reported, not created */
  fileless: string[];
  /** DB-only nested config (json/hook) not yet mirrored to files — reported, not written */
  nestedGaps: Array<{ name: string; fields: string[] }>;
}

export function backfillFrontmatterFromDb(
  db: { listAgents(): AgentRecord[]; getAgentTeamNames(name: string): string[] },
  personasDir: string = getPersonasDir(),
): BackfillReport {
  const filled: BackfillReport['filled'] = [];
  const fileless: string[] = [];
  const nestedGaps: BackfillReport['nestedGaps'] = [];

  for (const agent of db.listAgents()) {
    const path = resolvePersonaPath(agent.persona ?? agent.name, undefined, personasDir);
    if (!path) { fileless.push(agent.name); continue; }

    let raw: string;
    try { raw = readFileSync(path, 'utf-8'); } catch { fileless.push(agent.name); continue; }
    const { frontmatter } = parseFrontmatter(raw);

    const wrote: string[] = [];
    const nested: string[] = [];
    for (const f of CONFIG_FIELDS) {
      if (!f.personaKey || f.createOnly) continue;          // not a frontmatter-backed config field
      if (f.personaKey in frontmatter) continue;            // file already declares it — never clobber
      const value = (agent as Record<string, unknown>)[f.name];
      if (value === null || value === undefined || value === '') continue; // DB has nothing to contribute
      if (f.kind === 'scalar') {
        updateFrontmatterField(path, f.personaKey, String(value));
        wrote.push(f.personaKey);
      } else {
        nested.push(f.personaKey);                          // json/hook — deferred to write-through serializer
      }
    }
    // teams (RFC-004): a relation, not a CONFIG_FIELDS column — backfill from
    // current memberships if the file omits the key entirely (gaps only).
    if (!('teams' in frontmatter)) {
      const teamNames = db.getAgentTeamNames(agent.name);
      if (teamNames.length) {
        updateFrontmatterField(path, 'teams', serializeTeams(teamNames));
        wrote.push('teams');
      }
    }

    if (wrote.length) filled.push({ name: agent.name, fields: wrote });
    if (nested.length) nestedGaps.push({ name: agent.name, fields: nested });
  }

  return { filled, fileless, nestedGaps };
}
