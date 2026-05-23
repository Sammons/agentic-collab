import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';

/**
 * PR 1 — Teams (v3 UI grouping).
 *
 * Teams are a UI-only filter source for the v3 dashboard sidebar. They have no
 * kernel behavior. Many-to-many with agents. Schema:
 *
 *   teams(id PK, name UNIQUE, created_at)
 *   team_members(team_id FK→teams ON DELETE CASCADE, agent_name, added_at)
 *
 * Tests cover:
 *   - CRUD round-trip (create/list/get/rename/delete)
 *   - Member add/remove + idempotency
 *   - Cascade delete (team_members rows go when team is deleted)
 *   - Name uniqueness (constraint violation on duplicate)
 *   - Empty/whitespace name rejection
 *   - Member arrays sorted alphabetically
 */
describe('Teams (PR 1)', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'teams-test-'));
    db = new Database(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with an empty team list', () => {
    assert.deepEqual(db.listTeams(), []);
  });

  it('creates a team and returns it with empty members', () => {
    const team = db.createTeam('infrastructure');
    assert.equal(team.name, 'infrastructure');
    assert.deepEqual(team.members, []);
    assert.equal(typeof team.id, 'number');
    assert.match(team.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates a team with initial members', () => {
    const team = db.createTeam('market reports', ['market-report-lead', 'news-sentinel']);
    assert.deepEqual(team.members, ['market-report-lead', 'news-sentinel']);
  });

  it('trims the team name and dedupes initial members', () => {
    const team = db.createTeam('  reliability  ', ['ci-watcher', 'ci-watcher', 'deploy-watcher']);
    assert.equal(team.name, 'reliability');
    assert.deepEqual(team.members, ['ci-watcher', 'deploy-watcher']);
  });

  it('returns members sorted alphabetically', () => {
    const team = db.createTeam('mixed', ['zeta', 'alpha', 'mu']);
    assert.deepEqual(team.members, ['alpha', 'mu', 'zeta']);
  });

  it('rejects empty or whitespace-only names', () => {
    assert.throws(() => db.createTeam(''), /name is required/i);
    assert.throws(() => db.createTeam('   '), /name is required/i);
  });

  it('rejects names longer than 64 characters', () => {
    const tooLong = 'x'.repeat(65);
    assert.throws(() => db.createTeam(tooLong), /64 characters/);
  });

  it('enforces unique names', () => {
    db.createTeam('infrastructure');
    assert.throws(() => db.createTeam('infrastructure'), /UNIQUE constraint failed/);
  });

  it('lists multiple teams sorted by name', () => {
    db.createTeam('zeta');
    db.createTeam('alpha');
    db.createTeam('mu');
    const teams = db.listTeams();
    assert.deepEqual(teams.map(t => t.name), ['alpha', 'mu', 'zeta']);
  });

  it('looks up a team by id', () => {
    const created = db.createTeam('infrastructure', ['ci-watcher']);
    const fetched = db.getTeam(created.id);
    assert.equal(fetched?.name, 'infrastructure');
    assert.deepEqual(fetched?.members, ['ci-watcher']);
  });

  it('returns undefined for a missing team', () => {
    assert.equal(db.getTeam(999), undefined);
  });

  it('renames a team', () => {
    const team = db.createTeam('infra');
    const renamed = db.updateTeamName(team.id, 'infrastructure');
    assert.equal(renamed?.name, 'infrastructure');
    assert.equal(db.getTeam(team.id)?.name, 'infrastructure');
  });

  it('rename rejects empty names', () => {
    const team = db.createTeam('infra');
    assert.throws(() => db.updateTeamName(team.id, ''), /name is required/i);
  });

  it('rename returns undefined for missing team', () => {
    assert.equal(db.updateTeamName(999, 'new-name'), undefined);
  });

  it('deletes a team and reports change', () => {
    const team = db.createTeam('temp');
    assert.equal(db.deleteTeam(team.id), true);
    assert.equal(db.getTeam(team.id), undefined);
  });

  it('delete returns false for missing team', () => {
    assert.equal(db.deleteTeam(999), false);
  });

  it('cascades member deletion when a team is deleted', () => {
    const team = db.createTeam('infrastructure', ['ci-watcher', 'deploy-watcher']);
    db.deleteTeam(team.id);
    // Verify orphaned membership rows are gone by attempting to add to a fresh team
    // and checking total member count via listTeams.
    const fresh = db.createTeam('rebuild');
    assert.deepEqual(fresh.members, []);
    assert.equal(db.listTeams().length, 1);
  });

  it('adds a member', () => {
    const team = db.createTeam('infrastructure');
    const updated = db.addTeamMember(team.id, 'ci-watcher');
    assert.deepEqual(updated?.members, ['ci-watcher']);
  });

  it('add member is idempotent', () => {
    const team = db.createTeam('infrastructure');
    db.addTeamMember(team.id, 'ci-watcher');
    const second = db.addTeamMember(team.id, 'ci-watcher');
    assert.deepEqual(second?.members, ['ci-watcher']);
  });

  it('add member returns undefined for missing team', () => {
    assert.equal(db.addTeamMember(999, 'ci-watcher'), undefined);
  });

  it('add member rejects empty agent name', () => {
    const team = db.createTeam('t');
    assert.throws(() => db.addTeamMember(team.id, ''), /agentName is required/);
  });

  it('removes a member', () => {
    const team = db.createTeam('infrastructure', ['ci-watcher', 'deploy-watcher']);
    const updated = db.removeTeamMember(team.id, 'ci-watcher');
    assert.deepEqual(updated?.members, ['deploy-watcher']);
  });

  it('remove member is idempotent when agent not in team', () => {
    const team = db.createTeam('infrastructure', ['ci-watcher']);
    const updated = db.removeTeamMember(team.id, 'never-added');
    assert.deepEqual(updated?.members, ['ci-watcher']);
  });

  it('remove member returns undefined for missing team', () => {
    assert.equal(db.removeTeamMember(999, 'ci-watcher'), undefined);
  });

  it('round-trips a full membership flow', () => {
    const team = db.createTeam('reliability');
    db.addTeamMember(team.id, 'ci-watcher');
    db.addTeamMember(team.id, 'deploy-watcher');
    db.addTeamMember(team.id, 'orchestrator-watch');
    let listed = db.listTeams();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]!.members, ['ci-watcher', 'deploy-watcher', 'orchestrator-watch']);

    db.removeTeamMember(team.id, 'deploy-watcher');
    listed = db.listTeams();
    assert.deepEqual(listed[0]!.members, ['ci-watcher', 'orchestrator-watch']);

    const renamed = db.updateTeamName(team.id, 'reliability-v2');
    assert.equal(renamed?.name, 'reliability-v2');
    assert.deepEqual(renamed?.members, ['ci-watcher', 'orchestrator-watch']);

    assert.equal(db.deleteTeam(team.id), true);
    assert.deepEqual(db.listTeams(), []);
  });

  it('keeps teams isolated — operations on one do not affect another', () => {
    const a = db.createTeam('alpha', ['agent-1', 'agent-2']);
    const b = db.createTeam('beta', ['agent-3']);
    db.addTeamMember(a.id, 'agent-3');
    db.removeTeamMember(b.id, 'agent-3');
    assert.deepEqual(db.getTeam(a.id)?.members, ['agent-1', 'agent-2', 'agent-3']);
    assert.deepEqual(db.getTeam(b.id)?.members, []);
  });
});
