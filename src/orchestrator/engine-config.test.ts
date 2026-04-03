import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('EngineConfig CRUD', () => {
  let db: Database;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-collab-ec-test-'));
    db = new Database(join(tmpDir, 'test.db'));
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createEngineConfig with all fields', () => {
    const ec = db.createEngineConfig({
      name: 'full-config',
      engine: 'claude',
      model: 'opus',
      thinking: 'high',
      permissions: 'skip',
      hookStart: 'start-cmd',
      hookResume: 'resume-cmd',
      hookCompact: 'compact-cmd',
      hookExit: 'exit-cmd',
      hookInterrupt: 'interrupt-cmd',
      hookSubmit: 'submit-cmd',
      launchEnv: { FOO: 'bar', BAZ: 'qux' },
    });

    assert.equal(ec.name, 'full-config');
    assert.equal(ec.engine, 'claude');
    assert.equal(ec.model, 'opus');
    assert.equal(ec.thinking, 'high');
    assert.equal(ec.permissions, 'skip');
    assert.equal(ec.hookStart, 'start-cmd');
    assert.equal(ec.hookResume, 'resume-cmd');
    assert.equal(ec.hookCompact, 'compact-cmd');
    assert.equal(ec.hookExit, 'exit-cmd');
    assert.equal(ec.hookInterrupt, 'interrupt-cmd');
    assert.equal(ec.hookSubmit, 'submit-cmd');
    assert.deepEqual(ec.launchEnv, { FOO: 'bar', BAZ: 'qux' });
    assert.ok(ec.createdAt);
  });

  it('createEngineConfig with minimal fields (just name + engine)', () => {
    const ec = db.createEngineConfig({
      name: 'minimal-config',
      engine: 'codex',
    });

    assert.equal(ec.name, 'minimal-config');
    assert.equal(ec.engine, 'codex');
    assert.equal(ec.model, null);
    assert.equal(ec.thinking, null);
    assert.equal(ec.permissions, null);
    assert.equal(ec.hookStart, null);
    assert.equal(ec.hookResume, null);
    assert.equal(ec.hookCompact, null);
    assert.equal(ec.hookExit, null);
    assert.equal(ec.hookInterrupt, null);
    assert.equal(ec.hookSubmit, null);
    assert.equal(ec.launchEnv, null);
    assert.ok(ec.createdAt);
  });

  it('getEngineConfig returns null for nonexistent', () => {
    const ec = db.getEngineConfig('does-not-exist');
    assert.equal(ec, null);
  });

  it('getEngineConfig returns the record', () => {
    const ec = db.getEngineConfig('full-config');
    assert.ok(ec);
    assert.equal(ec!.name, 'full-config');
    assert.equal(ec!.engine, 'claude');
    assert.equal(ec!.model, 'opus');
    assert.deepEqual(ec!.launchEnv, { FOO: 'bar', BAZ: 'qux' });
  });

  it('listEngineConfigs returns empty then populated', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'agentic-collab-ec-list-'));
    const freshDb = new Database(join(freshDir, 'list.db'));
    try {
      assert.deepEqual(freshDb.listEngineConfigs(), []);

      freshDb.createEngineConfig({ name: 'b-config', engine: 'codex' });
      freshDb.createEngineConfig({ name: 'a-config', engine: 'claude' });

      const list = freshDb.listEngineConfigs();
      assert.equal(list.length, 2);
      assert.equal(list[0]!.name, 'a-config');
      assert.equal(list[1]!.name, 'b-config');
    } finally {
      freshDb.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('updateEngineConfig updates specific fields', () => {
    const updated = db.updateEngineConfig('full-config', {
      model: 'sonnet',
      thinking: 'low',
      launchEnv: { NEW_KEY: 'new_val' },
    });

    assert.ok(updated);
    assert.equal(updated!.model, 'sonnet');
    assert.equal(updated!.thinking, 'low');
    assert.deepEqual(updated!.launchEnv, { NEW_KEY: 'new_val' });
    // Unchanged fields preserved
    assert.equal(updated!.engine, 'claude');
    assert.equal(updated!.permissions, 'skip');
    assert.equal(updated!.hookStart, 'start-cmd');
  });

  it('deleteEngineConfig removes it', () => {
    db.createEngineConfig({ name: 'delete-me', engine: 'opencode' });
    assert.ok(db.getEngineConfig('delete-me'));
    assert.equal(db.deleteEngineConfig('delete-me'), true);
    assert.equal(db.getEngineConfig('delete-me'), null);
  });

  it('deleteEngineConfig returns false for nonexistent', () => {
    assert.equal(db.deleteEngineConfig('nope'), false);
  });
});
