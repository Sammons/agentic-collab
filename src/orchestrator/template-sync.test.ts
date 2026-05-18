/**
 * Tests for template-sync (v3 ephemeral-agent template loader).
 *
 * Goals:
 *  - Persistent personas (no `persistent` field, or `persistent: true`) still
 *    produce an `agents` row identical to 2.x AND now also produce an
 *    `agent_templates` row marked persistent=1.
 *  - Ephemeral personas (`persistent: false`) populate `agent_templates` and
 *    `topics` and do NOT touch the `agents` table.
 *  - Reloading replaces the topic set (removes old, adds new).
 *  - Malformed topics throw; no partial insert.
 *  - Missing cwd_base on ephemeral templates throws.
 *  - `field-registry.buildMigrationStatements()` is identical pre- and post-
 *    `syncTemplate` (the registry is untouched).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Database } from './database.ts';
import { syncTemplate } from './template-sync.ts';
import { syncPersonasToDb } from './persona.ts';
import type { PersonaFrontmatter } from './persona.ts';
import { buildMigrationStatements } from './field-registry.ts';

function makeDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'template-sync-test-'));
  const db = new Database(join(dir, 'test.db'));
  return { db, dir };
}

describe('template-sync', () => {
  describe('persistent personas', () => {
    let db: Database;
    let dir: string;

    before(() => {
      const made = makeDb();
      db = made.db;
      dir = made.dir;
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('default persona (no `persistent` field) produces a persistent template row + agents row', () => {
      const personasDir = join(dir, 'personas');
      mkdirSync(personasDir);
      writeFileSync(
        join(personasDir, 'classic.md'),
        '---\nengine: claude\nmodel: opus\ncwd: /classic\n---\n# classic',
      );

      const synced = syncPersonasToDb(db, personasDir);
      assert.equal(synced, 1);

      // agents row preserved (BC)
      const agent = db.getAgent('classic')!;
      assert.equal(agent.engine, 'claude');
      assert.equal(agent.cwd, '/classic');
      assert.equal(agent.model, 'opus');

      // agent_templates row created
      const tpl = db.getAgentTemplate('classic')!;
      assert.equal(tpl.id, 'classic');
      assert.equal(tpl.engine, 'claude');
      assert.equal(tpl.model, 'opus');
      assert.equal(tpl.persistent, true);
      assert.equal(tpl.cwdBase, null);
      assert.equal(tpl.cwdTemplate, null);
      assert.equal(tpl.repoRoot, null);
      assert.equal(tpl.hookPrepare, null);
      assert.equal(tpl.hookCleanup, null);

      // No topics for persistent
      const topics = db.getTopicsForTemplate('classic');
      assert.equal(topics.length, 0);
    });

    it('persistent template with topics declared logs warning and ignores them', () => {
      // Direct syncTemplate call so we can observe the warning path
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warns.push(String(msg));
      try {
        const fm: PersonaFrontmatter = {
          engine: 'claude',
          persistent: true,
          topics: [{ name: 'ignored', concurrency: 1 }],
        };
        syncTemplate(db, 'persistent-with-topics', fm, null);
      } finally {
        console.warn = origWarn;
      }
      assert.ok(warns.some((w) => w.includes('persistent-with-topics') && w.includes('ignored')));
      const topics = db.getTopicsForTemplate('persistent-with-topics');
      assert.equal(topics.length, 0);
    });
  });

  describe('ephemeral templates', () => {
    let db: Database;
    let dir: string;

    before(() => {
      const made = makeDb();
      db = made.db;
      dir = made.dir;
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('persistent: false + cwd_base + prepare + cleanup + 2 topics writes template and topics, no agents row', () => {
      const personasDir = join(dir, 'personas');
      mkdirSync(personasDir);
      writeFileSync(
        join(personasDir, 'aws-account-lead.md'),
        [
          '---',
          'id: aws-account-lead',
          'persistent: false',
          'engine: claude',
          'model: opus',
          'cwd_base: /var/agentic/work/aws-account-lead',
          'cwd_template: /var/agentic/work/aws-account-lead/wt-{{message_id}}',
          'repo_root: /var/agentic/work/aws-account-lead',
          'prepare: |',
          '  git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" main',
          'cleanup: |',
          '  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH"',
          'start: |',
          '  bash "$WORKTREE_PATH/start.sh"',
          'topics:',
          '  - name: provision',
          '    schema: ./schemas/provision.json',
          '    reply_schema: ./schemas/provision-reply.json',
          '    concurrency: 1',
          '    monitor_template: aws-account-monitor',
          '  - name: teardown',
          '    schema: ./schemas/teardown.json',
          '    concurrency: 2',
          '---',
          '# aws-account-lead',
        ].join('\n'),
      );

      const synced = syncPersonasToDb(db, personasDir);
      assert.equal(synced, 1);

      // No agents row for ephemeral templates.
      assert.equal(db.getAgent('aws-account-lead'), undefined);

      // agent_templates row
      const tpl = db.getAgentTemplate('aws-account-lead')!;
      assert.ok(tpl);
      assert.equal(tpl.persistent, false);
      assert.equal(tpl.engine, 'claude');
      assert.equal(tpl.model, 'opus');
      assert.equal(tpl.cwdBase, '/var/agentic/work/aws-account-lead');
      assert.equal(tpl.cwdTemplate, '/var/agentic/work/aws-account-lead/wt-{{message_id}}');
      assert.equal(tpl.repoRoot, '/var/agentic/work/aws-account-lead');
      assert.ok(tpl.hookPrepare && tpl.hookPrepare.includes('git'));
      assert.ok(tpl.hookCleanup && tpl.hookCleanup.includes('git'));
      assert.ok(tpl.hookStart && tpl.hookStart.includes('start.sh'));

      // topics rows
      const topics = db.getTopicsForTemplate('aws-account-lead');
      assert.equal(topics.length, 2);
      const byName = Object.fromEntries(topics.map((t) => [t.name, t]));
      assert.equal(byName['provision']!.concurrency, 1);
      assert.equal(byName['provision']!.monitorTemplate, 'aws-account-monitor');
      assert.equal(byName['provision']!.schemaPath, './schemas/provision.json');
      assert.equal(byName['provision']!.replySchemaPath, './schemas/provision-reply.json');
      assert.equal(byName['teardown']!.concurrency, 2);
    });

    it('reload removes deleted topics and adds new ones', () => {
      const personasDir = join(dir, 'personas');
      writeFileSync(
        join(personasDir, 'reload-template.md'),
        [
          '---',
          'persistent: false',
          'engine: claude',
          'cwd_base: /tmp/reload',
          'topics:',
          '  - name: alpha',
          '    concurrency: 1',
          '  - name: beta',
          '    concurrency: 1',
          '---',
          '# reload',
        ].join('\n'),
      );
      syncPersonasToDb(db, personasDir);

      let topics = db.getTopicsForTemplate('reload-template').map((t) => t.name).sort();
      assert.deepEqual(topics, ['alpha', 'beta']);

      // Drop beta, add gamma.
      writeFileSync(
        join(personasDir, 'reload-template.md'),
        [
          '---',
          'persistent: false',
          'engine: claude',
          'cwd_base: /tmp/reload',
          'topics:',
          '  - name: alpha',
          '    concurrency: 3',
          '  - name: gamma',
          '    concurrency: 1',
          '---',
          '# reload',
        ].join('\n'),
      );
      syncPersonasToDb(db, personasDir);

      topics = db.getTopicsForTemplate('reload-template').map((t) => t.name).sort();
      assert.deepEqual(topics, ['alpha', 'gamma']);
      const alpha = db.getTopicsForTemplate('reload-template').find((t) => t.name === 'alpha')!;
      assert.equal(alpha.concurrency, 3);
    });

    it('malformed topic (missing name) throws and writes no rows', () => {
      const fm: PersonaFrontmatter = {
        engine: 'claude',
        persistent: false,
        cwd_base: '/tmp/malformed',
        topics: [{ name: '' }, { name: 'ok' }],
      };
      assert.throws(() => syncTemplate(db, 'malformed', fm, null), /invalid or missing topic name/);
      const topics = db.getTopicsForTemplate('malformed');
      assert.equal(topics.length, 0);
      assert.equal(db.getAgentTemplate('malformed'), null);
    });

    it('persistent: false without cwd_base throws (caller catches)', () => {
      const fm: PersonaFrontmatter = {
        engine: 'claude',
        persistent: false,
      };
      assert.throws(() => syncTemplate(db, 'no-cwd-base', fm, null), /cwd_base/);
      assert.equal(db.getAgentTemplate('no-cwd-base'), null);
    });

    it('duplicate topic names within one template are rejected', () => {
      const fm: PersonaFrontmatter = {
        engine: 'claude',
        persistent: false,
        cwd_base: '/tmp/dup',
        topics: [{ name: 'twice' }, { name: 'twice' }],
      };
      assert.throws(() => syncTemplate(db, 'dup', fm, null), /duplicate topic/);
    });

    it('zero or negative concurrency is rejected', () => {
      const fmZero: PersonaFrontmatter = {
        engine: 'claude',
        persistent: false,
        cwd_base: '/tmp/c',
        topics: [{ name: 'tz', concurrency: 0 }],
      };
      assert.throws(() => syncTemplate(db, 'cz', fmZero, null), /concurrency must be a positive integer/);

      const fmNeg: PersonaFrontmatter = {
        engine: 'claude',
        persistent: false,
        cwd_base: '/tmp/c',
        topics: [{ name: 'tn', concurrency: -1 }],
      };
      assert.throws(() => syncTemplate(db, 'cn', fmNeg, null), /concurrency must be a positive integer/);
    });

    it('persona-sync warn-and-skip path: ephemeral persona missing cwd_base does not produce an agents row', () => {
      const personasDir = join(dir, 'personas-warn');
      mkdirSync(personasDir);
      writeFileSync(
        join(personasDir, 'bad-eph.md'),
        '---\npersistent: false\nengine: claude\n---\n# bad',
      );
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warns.push(String(msg));
      try {
        syncPersonasToDb(db, personasDir);
      } finally {
        console.warn = origWarn;
      }
      assert.ok(warns.some((w) => w.includes('bad-eph') && w.includes('cwd_base')));
      assert.equal(db.getAgent('bad-eph'), undefined);
      assert.equal(db.getAgentTemplate('bad-eph'), null);
    });
  });

  describe('backwards compatibility — field-registry untouched', () => {
    it('buildMigrationStatements() for agents is byte-identical pre- and post-syncTemplate', () => {
      // Snapshot the migration output BEFORE any template sync.
      const existing = new Set<string>([
        'name', 'engine', 'cwd', 'state', 'version', 'spawn_count', 'created_at',
      ]);
      const beforeStmts = buildMigrationStatements(existing).slice();

      // Run a template sync — both persistent and ephemeral variants.
      const { db, dir } = makeDb();
      try {
        syncTemplate(db, 'bc-persistent', {
          engine: 'claude',
        }, null);
        syncTemplate(db, 'bc-ephemeral', {
          engine: 'claude',
          persistent: false,
          cwd_base: '/tmp/bc',
          topics: [{ name: 'one' }],
        }, null);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }

      const afterStmts = buildMigrationStatements(existing).slice();
      assert.deepEqual(afterStmts, beforeStmts);
    });

    it('fresh DB has agent_templates and topics tables created', () => {
      const { db, dir } = makeDb();
      try {
        const tplCols = db.rawDb.prepare("PRAGMA table_info(agent_templates)").all() as Array<Record<string, unknown>>;
        const topicCols = db.rawDb.prepare("PRAGMA table_info(topics)").all() as Array<Record<string, unknown>>;
        assert.ok(tplCols.length > 0, 'agent_templates table missing');
        assert.ok(topicCols.length > 0, 'topics table missing');

        const tplNames = tplCols.map((c) => c['name']).sort();
        for (const expected of [
          'cwd_base', 'cwd_template', 'engine', 'hook_cleanup', 'hook_exit',
          'hook_prepare', 'hook_start', 'id', 'model', 'persistent',
          'persona_path', 'repo_root',
        ]) {
          assert.ok(tplNames.includes(expected), `agent_templates missing column: ${expected}`);
        }

        const topicNames = topicCols.map((c) => c['name']).sort();
        for (const expected of [
          'agent_template', 'concurrency', 'hook_cleanup_override',
          'hook_prepare_override', 'hook_start_override', 'monitor_template',
          'name', 'reply_schema_path', 'schema_path',
        ]) {
          assert.ok(topicNames.includes(expected), `topics missing column: ${expected}`);
        }
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
