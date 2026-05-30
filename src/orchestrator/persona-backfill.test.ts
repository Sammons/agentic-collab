import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRecord } from '../shared/types.ts';
import { backfillFrontmatterFromDb } from './persona-backfill.ts';

function fakeDb(
  agents: Array<Partial<AgentRecord>>,
  teams: Record<string, string[]> = {},
): { listAgents(): AgentRecord[]; getAgentTeamNames(name: string): string[] } {
  return { listAgents: () => agents as AgentRecord[], getAgentTeamNames: (name) => teams[name] ?? [] };
}
function tmp(): string { return mkdtempSync(join(tmpdir(), 'bf-')); }

describe('backfillFrontmatterFromDb', () => {
  it('fills missing scalar fields from the DB and never clobbers present ones', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a1.md'), '---\nengine: claude\ncwd: /tmp\ngroup: keep-me\n---\nbody\n');
      const report = backfillFrontmatterFromDb(fakeDb([
        { name: 'a1', persona: 'a1', engine: 'claude', cwd: '/tmp', agentGroup: 'SHOULD-NOT-WIN', proxyPin: 'bladerunner', model: 'opus' },
      ]), dir);
      const raw = readFileSync(join(dir, 'a1.md'), 'utf-8');
      assert.match(raw, /^proxy: bladerunner$/m, 'gap filled: proxy');
      assert.match(raw, /^model: opus$/m, 'gap filled: model');
      assert.match(raw, /^group: keep-me$/m, 'present value preserved');
      assert.doesNotMatch(raw, /SHOULD-NOT-WIN/, 'never clobbers a value already in the file');
      assert.ok(report.filled.some((f) => f.name === 'a1' && f.fields.includes('proxy') && f.fields.includes('model')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports fileless agents and does NOT create files', () => {
    const dir = tmp();
    try {
      const report = backfillFrontmatterFromDb(fakeDb([{ name: 'ghost', persona: 'ghost', engine: 'claude', cwd: '/tmp' }]), dir);
      assert.deepEqual(report.fileless, ['ghost']);
      assert.equal(existsSync(join(dir, 'ghost.md')), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is idempotent — a second run fills nothing', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.md'), '---\nengine: claude\ncwd: /tmp\n---\nb\n');
      const db = fakeDb([{ name: 'a', persona: 'a', engine: 'claude', cwd: '/tmp', proxyPin: 'p1' }]);
      const r1 = backfillFrontmatterFromDb(db, dir);
      const r2 = backfillFrontmatterFromDb(db, dir);
      assert.equal(r1.filled.length, 1);
      assert.equal(r2.filled.length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports DB-only nested config (env/hooks) without writing it', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.md'), '---\nengine: claude\ncwd: /tmp\n---\nb\n');
      const report = backfillFrontmatterFromDb(fakeDb([
        { name: 'a', persona: 'a', engine: 'claude', cwd: '/tmp', launchEnv: { vars: { FOO: 'bar' } } as AgentRecord['launchEnv'] },
      ]), dir);
      const raw = readFileSync(join(dir, 'a.md'), 'utf-8');
      assert.doesNotMatch(raw, /env:|FOO/, 'nested config not written by Stage 1');
      assert.ok(report.nestedGaps.some((n) => n.name === 'a' && n.fields.includes('env')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('backfills teams: from DB memberships when the file omits the key', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.md'), '---\nengine: claude\ncwd: /tmp\n---\nb\n');
      const report = backfillFrontmatterFromDb(
        fakeDb([{ name: 'a', persona: 'a', engine: 'claude', cwd: '/tmp' }], { a: ['advisors', 'infra'] }),
        dir,
      );
      const raw = readFileSync(join(dir, 'a.md'), 'utf-8');
      assert.match(raw, /^teams: \[advisors, infra\]$/m);
      assert.ok(report.filled.some((f) => f.name === 'a' && f.fields.includes('teams')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not clobber an existing teams: in the file', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.md'), '---\nengine: claude\ncwd: /tmp\nteams: [keep]\n---\nb\n');
      backfillFrontmatterFromDb(
        fakeDb([{ name: 'a', persona: 'a', engine: 'claude', cwd: '/tmp' }], { a: ['advisors'] }),
        dir,
      );
      const raw = readFileSync(join(dir, 'a.md'), 'utf-8');
      assert.match(raw, /^teams: \[keep\]$/m);
      assert.doesNotMatch(raw, /advisors/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('skips null/empty DB values', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.md'), '---\nengine: claude\ncwd: /tmp\n---\nb\n');
      const report = backfillFrontmatterFromDb(fakeDb([
        { name: 'a', persona: 'a', engine: 'claude', cwd: '/tmp', proxyPin: null, model: '' },
      ]), dir);
      const raw = readFileSync(join(dir, 'a.md'), 'utf-8');
      assert.doesNotMatch(raw, /^proxy:|^model:/m);
      assert.equal(report.filled.length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
