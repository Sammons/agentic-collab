import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { syncSinglePersona } from './persona.ts';

const fm = (teamsLine: string) => `---\nengine: claude\ncwd: /tmp\n${teamsLine}---\nbody\n`;

describe('teams ↔ frontmatter sync (RFC-004, file is master)', () => {
  it('reconciles memberships from teams: frontmatter across edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teams-'));
    const file = join(dir, 't1.md');
    try {
      writeFileSync(file, fm('teams: [alpha, beta]\n'));
      const db = new Database(join(dir, 'test.db'));
      try {
        assert.equal(syncSinglePersona(db, 't1', dir), true);
        assert.deepEqual(db.getAgentTeamNames('t1').sort(), ['alpha', 'beta']);

        // drop beta, add gamma → file wins (beta removed)
        writeFileSync(file, fm('teams: [alpha, gamma]\n'));
        syncSinglePersona(db, 't1', dir);
        assert.deepEqual(db.getAgentTeamNames('t1').sort(), ['alpha', 'gamma']);

        // teams: [] clears all memberships
        writeFileSync(file, fm('teams: []\n'));
        syncSinglePersona(db, 't1', dir);
        assert.deepEqual(db.getAgentTeamNames('t1'), []);

        // absent teams: key leaves memberships untouched
        db.setAgentTeams('t1', ['kept']);
        writeFileSync(file, fm(''));
        syncSinglePersona(db, 't1', dir);
        assert.deepEqual(db.getAgentTeamNames('t1'), ['kept']);
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('auto-creates teams by name and shares them across agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teams-'));
    try {
      writeFileSync(join(dir, 'a.md'), fm('teams: [shared]\n'));
      writeFileSync(join(dir, 'b.md'), fm('teams: [shared]\n'));
      const db = new Database(join(dir, 'test.db'));
      try {
        syncSinglePersona(db, 'a', dir);
        syncSinglePersona(db, 'b', dir);
        const shared = db.listTeams().filter((t) => t.name === 'shared');
        assert.equal(shared.length, 1, 'team created once, shared by name');
        assert.deepEqual(shared[0]!.members.sort(), ['a', 'b']);
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
