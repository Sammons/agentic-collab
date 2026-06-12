import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolvePersonaPath, loadPersona, composeSystemPrompt, parseFrontmatter, scanPersonas, syncSinglePersona, syncPersonasToDb, syncPersonasWithDiff, createPersonaAndAgent, toHostPath, serializeHookValue, deserializeHookValue, splitFrontmatter, serializeCore, structuredRenderable } from './persona.ts';
import { CONFIG_FIELDS } from './field-registry.ts';
import { Database } from './database.ts';

describe('Persona', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'persona-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolvePersonaPath', () => {
    it('returns explicit path if it exists within personasDir', () => {
      const path = join(tmpDir, 'custom.md');
      writeFileSync(path, '# Custom persona');
      assert.equal(resolvePersonaPath('agent-1', path, tmpDir), path);
    });

    it('rejects explicit path outside personasDir', () => {
      const path = join(tmpDir, 'custom.md');
      writeFileSync(path, '# Custom persona');
      assert.equal(resolvePersonaPath('agent-1', path, '/some/other/dir'), null);
    });

    it('returns null if explicit path does not exist', () => {
      assert.equal(resolvePersonaPath('agent-1', '/nonexistent/path.md'), null);
    });

    it('returns convention path when <name>.md exists in personasDir', () => {
      const path = join(tmpDir, 'conv-agent.md');
      writeFileSync(path, '# Convention persona');
      const result = resolvePersonaPath('conv-agent', null, tmpDir);
      assert.ok(result);
      assert.ok(result.endsWith('conv-agent.md'));
    });

    it('returns null when no persona found', () => {
      assert.equal(resolvePersonaPath('nonexistent-agent'), null);
    });

    it('rejects path traversal via symlink outside personasDir', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'persona-outside-'));
      const outsideFile = join(outsideDir, 'secret.md');
      writeFileSync(outsideFile, 'secret persona');

      const link = join(tmpDir, 'symlink-escape.md');
      try { symlinkSync(outsideFile, link); } catch { /* skip if symlinks unsupported */ }

      const result = resolvePersonaPath('agent-1', link, tmpDir);
      assert.equal(result, null);
      rmSync(outsideDir, { recursive: true, force: true });
    });

    it('rejects prefix-matching path traversal (base=/data/p, real=/data/persistent)', () => {
      // Create two sibling dirs where one is a prefix of the other
      const parent = mkdtempSync(join(tmpdir(), 'persona-prefix-'));
      const baseDir = join(parent, 'p');
      const siblingDir = join(parent, 'persistent');
      mkdirSync(baseDir, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });

      const outsideFile = join(siblingDir, 'escape.md');
      writeFileSync(outsideFile, 'escaped content');

      // The old startsWith check would incorrectly pass for /tmp/xxx/p -> /tmp/xxx/persistent
      const result = resolvePersonaPath('agent-1', outsideFile, baseDir);
      assert.equal(result, null);
      rmSync(parent, { recursive: true, force: true });
    });

    it('handles convention path within personasDir correctly', () => {
      const subDir = join(tmpDir, 'sub');
      mkdirSync(subDir, { recursive: true });
      const nested = join(subDir, 'deep-agent.md');
      writeFileSync(nested, '# Deep agent');

      // Convention uses <name>.md directly — subdirectory access isn't reachable by convention
      const result = resolvePersonaPath('deep-agent', null, tmpDir);
      // deep-agent.md doesn't exist in tmpDir root
      assert.equal(result, null);
    });
  });

  describe('loadPersona', () => {
    it('loads file content', () => {
      const path = join(tmpDir, 'test-persona.md');
      writeFileSync(path, 'You are a test agent');
      assert.equal(loadPersona(path), 'You are a test agent');
    });

    it('returns null for missing file', () => {
      assert.equal(loadPersona('/nonexistent/persona.md'), null);
    });

    it('returns null for empty file', () => {
      const path = join(tmpDir, 'empty-persona.md');
      writeFileSync(path, '');
      assert.equal(loadPersona(path), null);
    });

    it('returns null for directory path', () => {
      const dir = join(tmpDir, 'dir-persona');
      mkdirSync(dir, { recursive: true });
      // readFileSync on a directory throws, loadPersona should catch and return null
      const result = loadPersona(dir);
      assert.equal(result, null);
    });
  });

  describe('composeSystemPrompt', () => {
    it('includes messaging instructions', () => {
      const prompt = composeSystemPrompt({
        agentName: 'test-agent',
        orchestratorHost: 'http://localhost:3000',
      });
      assert.ok(prompt.includes('test-agent'));
      assert.ok(prompt.includes('collab send operator'));
      assert.ok(prompt.includes('collab send <agent>'));
      assert.ok(prompt.includes('collab agents'));
      assert.ok(prompt.includes('COLLAB_AGENT=test-agent'));
    });

    it('includes persona content when provided', () => {
      const prompt = composeSystemPrompt({
        agentName: 'agent-1',
        personaContent: '# Custom Agent\nYou are specialized in testing.',
        orchestratorHost: 'http://localhost:3000',
      });
      assert.ok(prompt.includes('Custom Agent'));
      assert.ok(prompt.includes('specialized in testing'));
    });

    it('includes peers when provided', () => {
      const prompt = composeSystemPrompt({
        agentName: 'agent-1',
        orchestratorHost: 'http://localhost:3000',
        peers: ['agent-2', 'agent-3'],
      });
      assert.ok(prompt.includes('agent-2'));
      assert.ok(prompt.includes('agent-3'));
      assert.ok(prompt.includes('Known peers'));
    });

    it('omits peers section when empty', () => {
      const prompt = composeSystemPrompt({
        agentName: 'agent-1',
        orchestratorHost: 'http://localhost:3000',
        peers: [],
      });
      assert.ok(!prompt.includes('Known peers'));
    });

    it('includes compact and context conservation tips', () => {
      const prompt = composeSystemPrompt({
        agentName: 'agent-1',
        orchestratorHost: 'http://localhost:3000',
      });
      assert.ok(prompt.includes('/compact'));
      assert.ok(prompt.includes('context'));
    });

    it('appends the persistent-inbox addendum', () => {
      const prompt = composeSystemPrompt({
        agentName: 'agent-1',
        orchestratorHost: 'http://localhost:3000',
      });
      assert.ok(prompt.includes('## Persistent inbox'));
      assert.ok(prompt.includes('delivered via tmux paste'));
      // The prompt must NOT instruct the agent to call complete/fail
      // (removed by RFC-009).
      assert.ok(!prompt.includes('collab complete --reply'));
    });
  });

  describe('parseFrontmatter', () => {
    it('parses frontmatter and body', () => {
      const raw = '---\nengine: claude\nmodel: opus\ncwd: /tmp\n---\n# Agent\nBody text.';
      const { frontmatter, body } = parseFrontmatter(raw);
      assert.equal(frontmatter['engine'], 'claude');
      assert.equal(frontmatter['model'], 'opus');
      assert.equal(frontmatter['cwd'], '/tmp');
      assert.ok(body.includes('# Agent'));
      assert.ok(body.includes('Body text.'));
    });

    it('returns empty frontmatter for files without delimiters', () => {
      const raw = '# Just a heading\nSome content.';
      const { frontmatter, body } = parseFrontmatter(raw);
      assert.deepEqual(frontmatter, {});
      assert.equal(body, raw);
    });

    it('handles frontmatter with no body', () => {
      const raw = '---\nengine: claude\n---\n';
      const { frontmatter, body } = parseFrontmatter(raw);
      assert.equal(frontmatter['engine'], 'claude');
      assert.equal(body, '');
    });

    it('ignores lines without colons in frontmatter', () => {
      const raw = '---\nengine: claude\nbadline\nmodel: opus\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter['engine'], 'claude');
      assert.equal(frontmatter['model'], 'opus');
      assert.equal(Object.keys(frontmatter).length, 2);
    });

    it('handles all persona frontmatter fields', () => {
      const raw = '---\nengine: claude\nmodel: opus\nthinking: high\ncwd: /project\npermissions: skip\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter['engine'], 'claude');
      assert.equal(frontmatter['model'], 'opus');
      assert.equal(frontmatter['thinking'], 'high');
      assert.equal(frontmatter['cwd'], '/project');
      assert.equal(frontmatter['permissions'], 'skip');
    });

    it('parses top-level env block', () => {
      const raw = [
        '---',
        'engine: claude',
        'cwd: /tmp',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/agent-x.config',
        '  GIT_AUTHOR_NAME: agent-x',
        '---',
        'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const env = frontmatter['env'] as Record<string, string>;
      assert.equal(env.GIT_CONFIG_GLOBAL, '$PWD/agent-x.config');
      assert.equal(env.GIT_AUTHOR_NAME, 'agent-x');
    });

    it('parses lifecycle hook fields (spawn, resume, compact)', () => {
      const raw = '---\nengine: codex\ncwd: /tmp\nspawn: codex --model o4-mini -a never -s danger-full-access\nresume: codex resume --last\ncompact: echo no-op\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter['spawn'], 'codex --model o4-mini -a never -s danger-full-access');
      assert.equal(frontmatter['resume'], 'codex resume --last');
      assert.equal(frontmatter['compact'], 'echo no-op');
    });

    it('returns undefined for missing hook fields', () => {
      const raw = '---\nengine: claude\ncwd: /tmp\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter['spawn'], undefined);
      assert.equal(frontmatter['resume'], undefined);
      assert.equal(frontmatter['compact'], undefined);
    });
  });

  describe('scanPersonas', () => {
    it('scans persona files with frontmatter', () => {
      const scanDir = mkdtempSync(join(tmpdir(), 'persona-scan-'));
      writeFileSync(join(scanDir, 'researcher.md'), '---\nengine: claude\ncwd: /tmp\n---\n# Researcher');
      writeFileSync(join(scanDir, 'builder.md'), '---\nengine: codex\ncwd: /work\n---\n# Builder');
      const personas = scanPersonas(scanDir);
      assert.equal(personas.length, 2);
      assert.equal(personas[0]!.name, 'builder');
      assert.equal(personas[0]!.frontmatter.engine, 'codex');
      assert.equal(personas[1]!.name, 'researcher');
      assert.equal(personas[1]!.frontmatter.engine, 'claude');
      rmSync(scanDir, { recursive: true, force: true });
    });

    it('returns empty array for missing directory', () => {
      const personas = scanPersonas('/nonexistent/dir');
      assert.deepEqual(personas, []);
    });
  });

  describe('syncPersonasToDb', () => {
    let db: Database;
    let syncDir: string;

    before(() => {
      syncDir = mkdtempSync(join(tmpdir(), 'persona-sync-test-'));
      db = new Database(join(syncDir, 'test.db'));
    });

    after(() => {
      db.close();
      rmSync(syncDir, { recursive: true, force: true });
    });

    it('creates agents from persona files', () => {
      const personasDir = join(syncDir, 'personas');
      mkdirSync(personasDir);
      writeFileSync(join(personasDir, 'alpha.md'), [
        '---',
        'engine: claude',
        'model: opus',
        'thinking: high',
        'cwd: /alpha',
        'permissions: skip',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/alpha.gitconfig',
        '  GIT_AUTHOR_NAME: alpha-agent',
        '---',
        '# Alpha agent',
      ].join('\n'));
      writeFileSync(join(personasDir, 'beta.md'), '---\nengine: codex\ncwd: /beta\n---\n# Beta agent');

      const synced = syncPersonasToDb(db, personasDir);
      assert.equal(synced, 2);

      const alpha = db.getAgent('alpha');
      assert.ok(alpha);
      assert.equal(alpha.engine, 'claude');
      assert.equal(alpha.model, 'opus');
      assert.equal(alpha.thinking, 'high');
      assert.equal(alpha.cwd, '/alpha');
      assert.equal(alpha.permissions, 'skip');
      assert.equal(alpha.persona, 'alpha');
      assert.deepEqual(alpha.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/alpha.gitconfig',
        GIT_AUTHOR_NAME: 'alpha-agent',
      });
      assert.equal(alpha.state, 'void');

      const beta = db.getAgent('beta');
      assert.ok(beta);
      assert.equal(beta.engine, 'codex');
      assert.equal(beta.cwd, '/beta');
      assert.equal(beta.model, null);
    });

    it('updates config but preserves runtime state on re-sync', () => {
      const personasDir = join(syncDir, 'personas');
      // Simulate agent being active
      const alpha = db.getAgent('alpha')!;
      db.updateAgentState('alpha', 'active', alpha.version, {
        tmuxSession: 'agent-alpha',
        proxyId: 'proxy-1',
      });

      // Update the persona file
      writeFileSync(join(personasDir, 'alpha.md'), [
        '---',
        'engine: claude',
        'model: sonnet',
        'cwd: /alpha-v2',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/alpha-v2.gitconfig',
        '---',
        '# Alpha v2',
      ].join('\n'));

      const synced = syncPersonasToDb(db, personasDir);
      assert.equal(synced, 2);

      const updated = db.getAgent('alpha')!;
      assert.equal(updated.model, 'sonnet');
      assert.equal(updated.cwd, '/alpha-v2');
      assert.equal(updated.state, 'active'); // runtime state preserved
      assert.equal(updated.tmuxSession, 'agent-alpha'); // runtime state preserved
      assert.equal(updated.proxyId, 'proxy-1'); // runtime state preserved
      assert.deepEqual(updated.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/alpha-v2.gitconfig',
      });
    });

    it('syncs lifecycle hook fields to database', () => {
      const personasDir = join(syncDir, 'personas');
      writeFileSync(join(personasDir, 'gamma.md'), '---\nengine: claude\ncwd: /gamma\nspawn: claude --model sonnet\nresume: claude --resume $SESSION_ID\ncompact: /compact\n---\n# Gamma');

      syncPersonasToDb(db, personasDir);

      const gamma = db.getAgent('gamma');
      assert.ok(gamma);
      assert.equal(gamma.hookStart, 'claude --model sonnet');
      assert.equal(gamma.hookResume, 'claude --resume $SESSION_ID');
      assert.equal(gamma.hookCompact, '/compact');
    });

    it('clears hook fields when removed from frontmatter', () => {
      const personasDir = join(syncDir, 'personas');
      // Re-write gamma without hooks
      writeFileSync(join(personasDir, 'gamma.md'), '---\nengine: claude\ncwd: /gamma\n---\n# Gamma no hooks');

      syncPersonasToDb(db, personasDir);

      const gamma = db.getAgent('gamma');
      assert.ok(gamma);
      assert.equal(gamma.hookStart, null);
      assert.equal(gamma.hookResume, null);
      assert.equal(gamma.hookCompact, null);
    });

    it('skips persona files missing required fields', () => {
      const personasDir = join(syncDir, 'personas');
      writeFileSync(join(personasDir, 'invalid.md'), '---\nmodel: opus\n---\n# No engine or cwd');

      const beforeCount = db.listAgents().length;
      syncPersonasToDb(db, personasDir);
      const afterCount = db.listAgents().length;
      assert.equal(afterCount, beforeCount); // no new agent created
    });
  });

  describe('syncSinglePersona', () => {
    let db: Database;
    let personasDir: string;

    before(() => {
      personasDir = mkdtempSync(join(tmpdir(), 'persona-single-sync-'));
      db = new Database(join(personasDir, 'single.db'));
    });

    after(() => {
      db.close();
      rmSync(personasDir, { recursive: true, force: true });
    });

    it('persists and clears launch env for one persona file', () => {
      writeFileSync(join(personasDir, 'solo.md'), [
        '---',
        'engine: claude',
        'cwd: /solo',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/solo.gitconfig',
        '---',
        '# Solo',
      ].join('\n'));

      assert.equal(syncSinglePersona(db, 'solo', personasDir), true);
      let solo = db.getAgent('solo');
      assert.ok(solo);
      assert.deepEqual(solo.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/solo.gitconfig',
      });

      writeFileSync(join(personasDir, 'solo.md'), '---\nengine: claude\ncwd: /solo-v2\n---\n# Solo v2');
      assert.equal(syncSinglePersona(db, 'solo', personasDir), true);
      solo = db.getAgent('solo');
      assert.ok(solo);
      assert.equal(solo.cwd, '/solo-v2');
      assert.equal(solo.launchEnv, null);
    });
  });

  describe('syncPersonasWithDiff', () => {
    let db: Database;
    let personasDir: string;

    before(() => {
      personasDir = mkdtempSync(join(tmpdir(), 'persona-diff-sync-'));
      db = new Database(join(personasDir, 'diff.db'));
    });

    after(() => {
      db.close();
      rmSync(personasDir, { recursive: true, force: true });
    });

    it('tracks launch env changes in diff output', () => {
      writeFileSync(join(personasDir, 'delta.md'), [
        '---',
        'engine: claude',
        'cwd: /delta',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/delta.gitconfig',
        '---',
        '# Delta',
      ].join('\n'));

      const created = syncPersonasWithDiff(db, personasDir);
      assert.deepEqual(created, {
        created: ['delta'],
        updated: [],
        unchanged: [],
        skipped: [],
      });
      let delta = db.getAgent('delta');
      assert.ok(delta);
      assert.deepEqual(delta.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/delta.gitconfig',
      });

      const unchanged = syncPersonasWithDiff(db, personasDir);
      assert.deepEqual(unchanged, {
        created: [],
        updated: [],
        unchanged: ['delta'],
        skipped: [],
      });

      writeFileSync(join(personasDir, 'delta.md'), [
        '---',
        'engine: claude',
        'cwd: /delta',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/delta-v2.gitconfig',
        '  GIT_AUTHOR_NAME: delta-agent',
        '---',
        '# Delta v2',
      ].join('\n'));

      const updated = syncPersonasWithDiff(db, personasDir);
      assert.deepEqual(updated, {
        created: [],
        updated: ['delta'],
        unchanged: [],
        skipped: [],
      });
      delta = db.getAgent('delta');
      assert.ok(delta);
      assert.deepEqual(delta.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/delta-v2.gitconfig',
        GIT_AUTHOR_NAME: 'delta-agent',
      });
    });
  });

  describe('loadPersona strips frontmatter', () => {
    it('returns body only, not frontmatter', () => {
      const path = join(tmpDir, 'fm-agent.md');
      writeFileSync(path, '---\nengine: claude\ncwd: /tmp\n---\n# The Agent\nDoes things.');
      const content = loadPersona(path);
      assert.ok(content);
      assert.ok(content.includes('# The Agent'));
      assert.ok(!content.includes('engine: claude'));
    });
  });

  describe('createPersonaAndAgent', () => {
    let createDb: Database;
    let createDir: string;

    before(() => {
      createDir = mkdtempSync(join(tmpdir(), 'persona-create-'));
      createDb = new Database(join(createDir, 'create.db'));
    });

    after(() => {
      createDb.close();
      rmSync(createDir, { recursive: true, force: true });
    });

    it('writes persona file and creates agent in DB', () => {
      const personasDir = join(createDir, 'personas');
      const content = [
        '---',
        'engine: claude',
        'model: opus',
        'cwd: /project',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/my-agent.gitconfig',
        '---',
        '# My Agent',
        'Does stuff.',
      ].join('\n');
      const persona = createPersonaAndAgent(createDb, 'my-agent', content, personasDir);

      assert.equal(persona.name, 'my-agent');
      assert.equal(persona.frontmatter.engine, 'claude');
      assert.equal(persona.frontmatter.model, 'opus');
      assert.equal(persona.frontmatter.cwd, '/project');
      assert.deepEqual(persona.frontmatter.env, {
        GIT_CONFIG_GLOBAL: '$PWD/my-agent.gitconfig',
      });
      assert.ok(persona.body.includes('# My Agent'));

      // Verify file was written
      const raw = readFileSync(join(personasDir, 'my-agent.md'), 'utf-8');
      assert.equal(raw, content);

      // Verify agent in DB
      const agent = createDb.getAgent('my-agent');
      assert.ok(agent);
      assert.equal(agent.engine, 'claude');
      assert.equal(agent.model, 'opus');
      assert.equal(agent.cwd, '/project');
      assert.deepEqual(agent.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/my-agent.gitconfig',
      });
      assert.equal(agent.state, 'void');
    });

    it('updates existing agent config on re-create', () => {
      const personasDir = join(createDir, 'personas');
      const updated = '---\nengine: claude\nmodel: sonnet\ncwd: /project-v2\n---\n# My Agent v2';
      createPersonaAndAgent(createDb, 'my-agent', updated, personasDir);

      const agent = createDb.getAgent('my-agent')!;
      assert.equal(agent.model, 'sonnet');
      assert.equal(agent.cwd, '/project-v2');
    });

    it('throws when engine is missing', () => {
      const personasDir = join(createDir, 'personas');
      assert.throws(
        () => createPersonaAndAgent(createDb, 'bad-agent', '---\ncwd: /tmp\n---\nBody', personasDir),
        /engine and cwd are required/,
      );
    });

    it('throws when cwd is missing', () => {
      const personasDir = join(createDir, 'personas');
      assert.throws(
        () => createPersonaAndAgent(createDb, 'bad-agent', '---\nengine: claude\n---\nBody', personasDir),
        /engine and cwd are required/,
      );
    });

    it('persists lifecycle hooks from frontmatter', () => {
      const personasDir = join(createDir, 'personas');
      const content = '---\nengine: codex\ncwd: /project\nspawn: codex --model o4-mini -a never\ncompact: echo noop\n---\n# Hooked Agent';
      createPersonaAndAgent(createDb, 'hooked-agent', content, personasDir);

      const agent = createDb.getAgent('hooked-agent');
      assert.ok(agent);
      assert.equal(agent.hookStart, 'codex --model o4-mini -a never');
      assert.equal(agent.hookResume, null);
      assert.equal(agent.hookCompact, 'echo noop');
    });

    it('throws for missing engine', () => {
      const personasDir = join(createDir, 'personas');
      assert.throws(
        () => createPersonaAndAgent(createDb, 'bad-agent', '---\ncwd: /tmp\n---\nBody', personasDir),
        /engine and cwd are required/,
      );
    });
  });

  describe('parseFrontmatter nested YAML', () => {
    it('parses nested preset hook with no options', () => {
      const raw = '---\nengine: claude\ncwd: /tmp\nstart:\n  preset: claude\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      const start = frontmatter.start as { preset: string };
      assert.equal(start.preset, 'claude');
    });

    it('parses nested preset hook with options', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'start:', '  preset: claude', '  options:', '    model: opus', '    thinking: high',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const start = frontmatter.start as { preset: string; options: Record<string, string> };
      assert.equal(start.preset, 'claude');
      assert.equal(start.options.model, 'opus');
      assert.equal(start.options.thinking, 'high');
    });

    it('parses nested shell hook with env', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'start:', '  shell: ./run.sh', '  env:', '    MY_VAR: hello', '    OTHER: world',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const start = frontmatter.start as { shell: string; env: Record<string, string> };
      assert.equal(start.shell, './run.sh');
      assert.equal(start.env.MY_VAR, 'hello');
      assert.equal(start.env.OTHER, 'world');
    });

    it('parses top-level env alongside hook env without collisions', () => {
      const raw = [
        '---',
        'engine: claude',
        'cwd: /tmp',
        'env:',
        '  GIT_CONFIG_GLOBAL: $PWD/agent-x.config',
        'start:',
        '  shell: ./run.sh',
        '  env:',
        '    MY_VAR: hello',
        '---',
        'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const env = frontmatter.env as Record<string, string>;
      const start = frontmatter.start as { shell: string; env: Record<string, string> };
      assert.equal(env.GIT_CONFIG_GLOBAL, '$PWD/agent-x.config');
      assert.equal(start.shell, './run.sh');
      assert.equal(start.env.MY_VAR, 'hello');
    });

    it('parses nested send hook with keystroke actions', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'exit:', '  send:', '    - keystroke: Escape', '    - keystroke: C-c',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const exit = frontmatter.exit as { send: Array<{ keystroke: string }> };
      assert.equal(exit.send.length, 2);
      assert.equal(exit.send[0]!.keystroke, 'Escape');
      assert.equal(exit.send[1]!.keystroke, 'C-c');
    });

    it('parses send hook with mixed action types and post_wait_ms', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'submit:', '  send:',
        '    - keystroke: Escape', '      post_wait_ms: 100',
        '    - paste: hello world',
        '    - keystroke: Enter',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const submit = frontmatter.submit as { send: Array<Record<string, unknown>> };
      assert.equal(submit.send.length, 3);
      assert.equal(submit.send[0]!.keystroke, 'Escape');
      assert.equal(submit.send[0]!.post_wait_ms, 100);
      assert.equal(submit.send[1]!.paste, 'hello world');
      assert.equal(submit.send[2]!.keystroke, 'Enter');
    });

    it('parses nested keystrokes hook (preferred name for send)', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'exit:', '  keystrokes:', '    - keystroke: Escape', '    - keystroke: Enter',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const exit = frontmatter.exit as { keystrokes: Array<{ keystroke: string }> };
      assert.equal(exit.keystrokes.length, 2);
      assert.equal(exit.keystrokes[0]!.keystroke, 'Escape');
      assert.equal(exit.keystrokes[1]!.keystroke, 'Enter');
    });

    it('parses pipeline with mixed step types', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'exit:',
        '  - keystrokes:',
        '    - keystroke: Escape',
        '  - shell: /exit',
        '  - keystrokes:',
        '    - keystroke: Enter',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const exit = frontmatter.exit as Array<{ type: string }>;
      assert.ok(Array.isArray(exit), 'exit should be a pipeline array');
      assert.equal(exit.length, 3);
      assert.equal(exit[0]!.type, 'keystrokes');
      assert.equal(exit[1]!.type, 'shell');
      assert.equal((exit[1] as { type: string; command: string }).command, '/exit');
      assert.equal(exit[2]!.type, 'keystrokes');
    });

    it('parses pipeline with capture step', () => {
      const raw = [
        '---', 'engine: codex', 'cwd: /tmp',
        'exit:',
        '  - shell: /exit',
        '  - capture:',
        '      lines: 50',
        '      regex: codex resume ([0-9a-f-]+)',
        '      var: SESSION_ID',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const exit = frontmatter.exit as Array<{ type: string }>;
      assert.ok(Array.isArray(exit), 'exit should be a pipeline array');
      assert.equal(exit.length, 2);
      assert.equal(exit[0]!.type, 'shell');
      assert.equal(exit[1]!.type, 'capture');
      const capture = exit[1] as { type: string; lines: number; regex: string; var: string };
      assert.equal(capture.lines, 50);
      assert.equal(capture.regex, 'codex resume ([0-9a-f-]+)');
      assert.equal(capture.var, 'SESSION_ID');
    });

    it('falls back to legacy parser for non-pipeline arrays', () => {
      const raw = [
        '---', 'engine: claude', 'cwd: /tmp',
        'exit:', '  send:', '    - keystroke: Escape', '    - keystroke: C-c',
        '---', 'Body',
      ].join('\n');
      const { frontmatter } = parseFrontmatter(raw);
      const exit = frontmatter.exit as { send: Array<{ keystroke: string }> };
      assert.ok(!Array.isArray(exit), 'legacy send should not be an array');
      assert.equal(exit.send.length, 2);
    });

    it('handles flat and nested hooks in same frontmatter', () => {
      const raw = [
        '---', 'engine: claude', 'model: opus', 'cwd: /tmp',
        'start:', '  preset: claude', '  options:', '    model: sonnet',
        'resume:', '  preset: claude',
        'exit: /exit',
        '---', '# Body',
      ].join('\n');
      const { frontmatter, body } = parseFrontmatter(raw);
      assert.equal(frontmatter.engine, 'claude');
      assert.equal(frontmatter.model, 'opus');
      const start = frontmatter.start as { preset: string; options: Record<string, string> };
      assert.equal(start.preset, 'claude');
      assert.equal(start.options.model, 'sonnet');
      const resume = frontmatter.resume as { preset: string };
      assert.equal(resume.preset, 'claude');
      assert.equal(frontmatter.exit, '/exit');
      assert.equal(body, '# Body');
    });

    it('parses block scalar with pipe', () => {
      const raw = '---\nengine: claude\ncwd: /tmp\nstart: |\n  line one\n  line two\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter.start, 'line one\nline two');
    });

    it('non-hook fields with empty value stay as empty string', () => {
      const raw = '---\nengine: claude\nmodel:\ncwd: /tmp\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter.model, '');
    });
  });

  describe('splitFrontmatter / serializeCore (RFC-005)', () => {
    // Mirror the PUT /api/personas save path: core widgets + verbatim passthrough.
    const save = (core: Record<string, unknown>, passthroughRaw: string, body = 'Body.'): string => {
      const fm = [serializeCore(core).trim(), passthroughRaw.trim()].filter(Boolean).join('\n');
      return fm ? `---\n${fm}\n---\n\n${body}` : body;
    };

    it('extracts core single-line fields; group rides the passthrough (RFC-004 teams superseded it)', () => {
      const raw = '---\nengine: claude\ngroup: agentic-collab\ncwd: /x\nicon: 🎛️\nmodel: claude-opus-4-7\n---\n\nBody.';
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude');
      assert.equal(core['model'], 'claude-opus-4-7');
      assert.equal(core['cwd'], '/x');
      assert.equal(core['group'], undefined);                  // no longer a core widget
      assert.equal(passthroughRaw, 'group: agentic-collab');   // ...carried verbatim instead
    });

    it('preserves `group` via passthrough when re-saving after a core edit', () => {
      const raw = '---\nengine: claude\ngroup: agentic-collab\nmodel: claude-opus-4-7\n---\n\nBody.';
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['group'], undefined);                       // not a core widget anymore
      assert.ok(passthroughRaw.includes('group: agentic-collab'));  // rides passthrough
      core['model'] = 'claude-opus-4-8'; // simulate a widget edit
      const fm = parseFrontmatter(save(core, passthroughRaw)).frontmatter;
      assert.equal(fm['group'], 'agentic-collab'); // STILL not dropped — RFC-005 passthrough preserves it
      assert.equal(fm['model'], 'claude-opus-4-8');
      assert.equal(fm['engine'], 'claude');
    });

    it('a persona with group: stays structured-renderable (no raw-editor fallback regression)', () => {
      // group stays in SERIALIZE_SCALARS so structuredRenderable still round-trips it;
      // only its core-widget classification was dropped.
      const raw = '---\nengine: claude\ngroup: agentic-collab\nmodel: claude-opus-4-7\n---\n\nBody.';
      assert.equal(structuredRenderable(raw), true);
    });

    it('preserves an arbitrary engine value (claude-with-home)', () => {
      const raw = '---\nengine: claude-with-home\nmodel: claude-opus-4-7\n---\n\nBody.';
      const { core } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude-with-home');
      assert.equal(parseFrontmatter(save(core, '')).frontmatter['engine'], 'claude-with-home');
    });

    it('carries unknown keys through the passthrough verbatim', () => {
      const raw = '---\nengine: claude\npoke:\n - shell: ok\nflagged: true\n---\n\nBody.';
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude');
      assert.ok(passthroughRaw.includes('poke:'));
      assert.ok(passthroughRaw.includes(' - shell: ok'));
      assert.ok(passthroughRaw.includes('flagged: true'));
      const saved = save(core, passthroughRaw);
      assert.ok(saved.includes('poke:\n - shell: ok')); // indentation intact
      assert.ok(saved.includes('flagged: true'));
    });

    it('preserves a frontmatter comment in place (ios-recipe-lead case, B1)', () => {
      const raw = '---\nicon: 🍳\nengine: codex\n# engine: codex — chosen for Swift codegen; revisit later\ncwd: /x\ngroup: ios-recipe\n---\n\nBody.';
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'codex');
      assert.ok(passthroughRaw.includes('# engine: codex — chosen for Swift codegen'));
      assert.ok(save(core, passthroughRaw).includes('# engine: codex — chosen for Swift codegen'));
    });

    it('preserves a block-scalar hook verbatim (shell + template vars)', () => {
      const raw = [
        '---', 'engine: claude-with-home', 'group: agentic-collab',
        'hook_prepare:', '  shell: |',
        '    mkdir -p "$(dirname "$WORKTREE_PATH")"',
        '    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" HEAD',
        '---', '', 'Body.',
      ].join('\n');
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude-with-home'); // group now rides passthrough (own test)
      assert.ok(passthroughRaw.includes('hook_prepare:'));
      assert.ok(passthroughRaw.includes('  shell: |'));
      assert.ok(passthroughRaw.includes('    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" HEAD'));
      assert.ok(save(core, passthroughRaw).includes('  shell: |\n    mkdir -p'));
    });

    it('preserves map-shaped indicators verbatim', () => {
      const raw = [
        '---', 'engine: claude-with-home', 'indicators:', '  approval:',
        '    regex: yes', '    badge: Needs Approval', '    style: warning',
        '---', '', 'Body.',
      ].join('\n');
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude-with-home');
      assert.ok(passthroughRaw.includes('indicators:'));
      assert.ok(passthroughRaw.includes('  approval:'));
      assert.ok(passthroughRaw.includes('    badge: Needs Approval'));
    });

    it('round-trips teams as an inline list', () => {
      const raw = '---\nengine: claude\nteams: [alpha, beta]\n---\n\nBody.';
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.deepEqual(core['teams'], ['alpha', 'beta']);
      assert.equal(passthroughRaw, '');
      assert.deepEqual(parseFrontmatter(save(core, passthroughRaw)).frontmatter['teams'], ['alpha', 'beta']);
    });

    it('preserves everything when editing one core field on a complex persona', () => {
      const raw = [
        '---', 'icon: 🎛️', 'engine: claude-with-home', 'model: claude-opus-4-7',
        'group: agentic-collab', '# rationale: opus for reasoning depth',
        'poke:', ' - shell: ok',
        'hook_prepare:', '  shell: |', '    git worktree add "$WORKTREE_PATH" HEAD',
        'indicators:', '  approval:', '    regex: yes', '    badge: Approve', '    style: warning',
        '---', '', 'System prompt body.',
      ].join('\n');
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude-with-home');
      assert.equal(core['group'], undefined); // group rides passthrough now, not a core widget
      core['model'] = 'claude-opus-4-8'; // edit one core field
      const saved = save(core, passthroughRaw, 'System prompt body.');
      const fm = parseFrontmatter(saved).frontmatter;
      assert.equal(fm['model'], 'claude-opus-4-8');
      assert.equal(fm['group'], 'agentic-collab'); // preserved via passthrough
      assert.equal(fm['engine'], 'claude-with-home');
      for (const needle of ['# rationale: opus for reasoning depth', 'poke:', ' - shell: ok', 'hook_prepare:', '  shell: |', '    git worktree add "$WORKTREE_PATH" HEAD', 'indicators:', '  approval:', '    badge: Approve']) {
        assert.ok(saved.includes(needle), `missing from passthrough: ${needle}`);
      }
      assert.ok(saved.includes('System prompt body.'));
    });

    it('leaves a block-scalar-valued core key in passthrough (no body split)', () => {
      const raw = '---\nengine: claude\ncwd: |\n  /multi/line/cwd\n---\n\nBody.';
      const { core, passthroughRaw } = splitFrontmatter(raw);
      assert.equal(core['engine'], 'claude');
      assert.equal(core['cwd'], undefined); // not pulled into a widget
      assert.ok(passthroughRaw.includes('cwd: |'));
      assert.ok(passthroughRaw.includes('  /multi/line/cwd'));
    });

    it('serializeCore emits scalars in order, teams last, skips empties, and ignores the dropped group', () => {
      const out = serializeCore({ engine: 'claude', model: '', icon: '🎛️', group: 'g', teams: ['a', 'b'] });
      assert.equal(out, 'icon: 🎛️\nengine: claude\nteams: [a, b]'); // no `group:` — no longer a core scalar
    });
  });

  describe('serializeHookValue', () => {
    it('returns null for null/undefined', () => {
      assert.equal(serializeHookValue(null), null);
      assert.equal(serializeHookValue(undefined), null);
    });

    it('returns strings as-is', () => {
      assert.equal(serializeHookValue('preset:claude'), 'preset:claude');
    });

    it('serializes structured objects to JSON', () => {
      const hook = { preset: 'claude', options: { model: 'opus' } };
      assert.equal(serializeHookValue(hook), JSON.stringify(hook));
    });

    it('serializes send hooks to JSON', () => {
      const hook = { send: [{ keystroke: 'Escape' }, { paste: 'hello' }] };
      const parsed = JSON.parse(serializeHookValue(hook)!);
      assert.equal(parsed.send.length, 2);
    });
  });

  describe('deserializeHookValue', () => {
    it('returns null for null', () => {
      assert.equal(deserializeHookValue(null), null);
    });

    it('returns plain strings as-is', () => {
      assert.equal(deserializeHookValue('preset:claude'), 'preset:claude');
    });

    it('deserializes JSON objects', () => {
      const hook = { preset: 'claude', options: { model: 'opus' } };
      assert.deepEqual(deserializeHookValue(JSON.stringify(hook)), hook);
    });

    it('returns invalid JSON starting with { as string', () => {
      assert.equal(deserializeHookValue('{not json'), '{not json');
    });
  });

  describe('toHostPath', () => {
    it('maps container path to host path when PERSONAS_HOST_DIR is set', () => {
      const prev = process.env['PERSONAS_HOST_DIR'];
      const prevDir = process.env['PERSONAS_DIR'];
      try {
        process.env['PERSONAS_DIR'] = '/app/persistent-personas';
        process.env['PERSONAS_HOST_DIR'] = '/home/user/persistent-agents';
        assert.equal(
          toHostPath('/app/persistent-personas/agent.md'),
          '/home/user/persistent-agents/agent.md',
        );
      } finally {
        if (prev === undefined) delete process.env['PERSONAS_HOST_DIR'];
        else process.env['PERSONAS_HOST_DIR'] = prev;
        if (prevDir === undefined) delete process.env['PERSONAS_DIR'];
        else process.env['PERSONAS_DIR'] = prevDir;
      }
    });

    it('returns original path when PERSONAS_HOST_DIR is not set', () => {
      const prev = process.env['PERSONAS_HOST_DIR'];
      try {
        delete process.env['PERSONAS_HOST_DIR'];
        assert.equal(
          toHostPath('/app/persistent-personas/agent.md'),
          '/app/persistent-personas/agent.md',
        );
      } finally {
        if (prev !== undefined) process.env['PERSONAS_HOST_DIR'] = prev;
      }
    });

    it('returns original path when it does not match PERSONAS_DIR prefix', () => {
      const prev = process.env['PERSONAS_HOST_DIR'];
      const prevDir = process.env['PERSONAS_DIR'];
      try {
        process.env['PERSONAS_DIR'] = '/app/persistent-personas';
        process.env['PERSONAS_HOST_DIR'] = '/home/user/persistent-agents';
        assert.equal(
          toHostPath('/some/other/path/agent.md'),
          '/some/other/path/agent.md',
        );
      } finally {
        if (prev === undefined) delete process.env['PERSONAS_HOST_DIR'];
        else process.env['PERSONAS_HOST_DIR'] = prev;
        if (prevDir === undefined) delete process.env['PERSONAS_DIR'];
        else process.env['PERSONAS_DIR'] = prevDir;
      }
    });
  });

  describe('custom_buttons frontmatter', () => {
    it('parses custom_buttons with pipeline steps', () => {
      const raw = `---
engine: claude
cwd: /tmp
custom_buttons:
  compact:
    - shell: /compact
    - keystrokes:
      - keystroke: Enter
  clear:
    - keystrokes:
      - keystroke: Escape
    - shell: /clear
---
Persona body
`;
      const { frontmatter } = parseFrontmatter(raw);
      const fm = frontmatter as { custom_buttons?: Record<string, unknown[]> };
      assert.ok(fm.custom_buttons, 'custom_buttons should be parsed');
      assert.ok(fm.custom_buttons['compact'], 'should have compact button');
      assert.ok(fm.custom_buttons['clear'], 'should have clear button');

      const compact = fm.custom_buttons['compact']!;
      assert.equal(compact.length, 2);
      assert.deepEqual(compact[0], { type: 'shell', command: '/compact' });
      assert.equal((compact[1] as { type: string }).type, 'keystrokes');

      const clear = fm.custom_buttons['clear']!;
      assert.equal(clear.length, 2);
      assert.equal((clear[0] as { type: string }).type, 'keystrokes');
      assert.deepEqual(clear[1], { type: 'shell', command: '/clear' });
    });

    it('syncs custom_buttons to database', () => {
      const personasDir = mkdtempSync(join(tmpdir(), 'persona-buttons-'));
      const dbPath = join(personasDir, 'test.db');
      const db = new Database(dbPath);
      const origDir = process.env['PERSONAS_DIR'];
      process.env['PERSONAS_DIR'] = personasDir;

      try {
        writeFileSync(join(personasDir, 'btn-agent.md'), `---
engine: claude
cwd: /tmp
custom_buttons:
  compact:
    - shell: /compact
---
Agent with buttons
`);
        syncPersonasToDb(db, personasDir);
        const agent = db.getAgent('btn-agent')!;
        assert.ok(agent.customButtons, 'customButtons should be stored');
        const buttons = JSON.parse(agent.customButtons!);
        assert.ok(buttons['compact'], 'should have compact button');
        assert.equal(buttons['compact'].length, 1);
        assert.deepEqual(buttons['compact'][0], { type: 'shell', command: '/compact' });
      } finally {
        db.close();
        if (origDir === undefined) delete process.env['PERSONAS_DIR'];
        else process.env['PERSONAS_DIR'] = origDir;
        rmSync(personasDir, { recursive: true, force: true });
      }
    });

    it('detects custom_buttons changes in syncPersonasWithDiff', () => {
      const personasDir = mkdtempSync(join(tmpdir(), 'persona-btndiff-'));
      const dbPath = join(personasDir, 'test.db');
      const db = new Database(dbPath);
      const origDir = process.env['PERSONAS_DIR'];
      process.env['PERSONAS_DIR'] = personasDir;

      try {
        // First sync — creates agent
        writeFileSync(join(personasDir, 'diff-btn.md'), `---
engine: claude
cwd: /tmp
---
No buttons yet
`);
        const r1 = syncPersonasWithDiff(db, personasDir);
        assert.ok(r1.created.includes('diff-btn'));

        // Second sync — same file, no change
        const r2 = syncPersonasWithDiff(db, personasDir);
        assert.ok(r2.unchanged.includes('diff-btn'));

        // Third sync — add custom_buttons
        writeFileSync(join(personasDir, 'diff-btn.md'), `---
engine: claude
cwd: /tmp
custom_buttons:
  restart:
    - shell: /exit
---
Now with buttons
`);
        const r3 = syncPersonasWithDiff(db, personasDir);
        assert.ok(r3.updated.includes('diff-btn'), 'should detect custom_buttons change');
      } finally {
        db.close();
        if (origDir === undefined) delete process.env['PERSONAS_DIR'];
        else process.env['PERSONAS_DIR'] = origDir;
        rmSync(personasDir, { recursive: true, force: true });
      }
    });
  });

  describe('indicators frontmatter', () => {
    it('parses indicators with regex, badge, style, actions', () => {
      const raw = `---
engine: claude
cwd: /tmp
indicators:
  approval:
    regex: '(Yes|No|Always allow)'
    badge: Needs Approval
    style: warning
    actions:
      approve:
        - keystroke: y
      deny:
        - keystroke: n
  low-context:
    regex: 'Context left until'
    badge: Low Context
    style: danger
---
Persona body
`;
      const { frontmatter } = parseFrontmatter(raw);
      const fm = frontmatter as { indicators?: Array<{ id: string; regex: string; badge: string; style: string; actions?: Record<string, unknown[]> }> };
      assert.ok(fm.indicators, 'indicators should be parsed');
      assert.equal(fm.indicators.length, 2);

      const approval = fm.indicators[0]!;
      assert.equal(approval.id, 'approval');
      assert.equal(approval.regex, '(Yes|No|Always allow)');
      assert.equal(approval.badge, 'Needs Approval');
      assert.equal(approval.style, 'warning');
      assert.ok(approval.actions, 'approval should have actions');
      assert.ok(approval.actions!['approve'], 'should have approve action');
      assert.ok(approval.actions!['deny'], 'should have deny action');
      assert.deepEqual(approval.actions!['approve']![0], { type: 'keystroke', key: 'y' });
      assert.deepEqual(approval.actions!['deny']![0], { type: 'keystroke', key: 'n' });

      const lowCtx = fm.indicators[1]!;
      assert.equal(lowCtx.id, 'low-context');
      assert.equal(lowCtx.regex, 'Context left until');
      assert.equal(lowCtx.badge, 'Low Context');
      assert.equal(lowCtx.style, 'danger');
      assert.equal(lowCtx.actions, undefined);
    });

    it('parses indicators without actions', () => {
      const raw = `---
engine: claude
cwd: /tmp
indicators:
  stalled:
    regex: 'Waiting for input'
    badge: Stalled
    style: info
---
Persona body
`;
      const { frontmatter } = parseFrontmatter(raw);
      const fm = frontmatter as { indicators?: Array<{ id: string; regex: string; badge: string; style: string; actions?: unknown }> };
      assert.ok(fm.indicators, 'indicators should be parsed');
      assert.equal(fm.indicators.length, 1);
      assert.equal(fm.indicators[0]!.id, 'stalled');
      assert.equal(fm.indicators[0]!.badge, 'Stalled');
      assert.equal(fm.indicators[0]!.style, 'info');
      assert.equal(fm.indicators[0]!.actions, undefined);
    });

    it('syncs indicators to database', () => {
      const personasDir = mkdtempSync(join(tmpdir(), 'persona-indicators-'));
      const dbPath = join(personasDir, 'test.db');
      const db = new Database(dbPath);
      const origDir = process.env['PERSONAS_DIR'];
      process.env['PERSONAS_DIR'] = personasDir;

      try {
        writeFileSync(join(personasDir, 'ind-agent.md'), `---
engine: claude
cwd: /tmp
indicators:
  approval:
    regex: '(Yes|No)'
    badge: Needs Approval
    style: warning
    actions:
      approve:
        - keystroke: y
---
Agent with indicators
`);
        syncPersonasToDb(db, personasDir);
        const agent = db.getAgent('ind-agent')!;
        assert.ok(agent.indicators, 'indicators should be stored');
        const indicators = JSON.parse(agent.indicators!);
        assert.equal(indicators.length, 1);
        assert.equal(indicators[0].id, 'approval');
        assert.equal(indicators[0].regex, '(Yes|No)');
        assert.equal(indicators[0].badge, 'Needs Approval');
        assert.ok(indicators[0].actions['approve']);
      } finally {
        db.close();
        if (origDir === undefined) delete process.env['PERSONAS_DIR'];
        else process.env['PERSONAS_DIR'] = origDir;
        rmSync(personasDir, { recursive: true, force: true });
      }
    });
  });

  describe('wait pipeline step', () => {
    it('parses wait step from frontmatter', () => {
      const raw = `---
engine: claude
cwd: /tmp
start:
  - shell: claude --model opus
  - wait: 3000
  - shell: /status
---
Body
`;
      const { frontmatter } = parseFrontmatter(raw);
      const steps = frontmatter['start'] as Array<{ type: string; ms?: number; command?: string }>;
      assert.ok(Array.isArray(steps), 'start should be a pipeline array');
      assert.equal(steps.length, 3);
      assert.deepEqual(steps[0], { type: 'shell', command: 'claude --model opus' });
      assert.deepEqual(steps[1], { type: 'wait', ms: 3000 });
      assert.deepEqual(steps[2], { type: 'shell', command: '/status' });
    });

    it('parses keystroke step from frontmatter', () => {
      const raw = `---
engine: claude
cwd: /tmp
exit:
  - keystroke: Escape
  - shell: /exit
---
Body
`;
      const { frontmatter } = parseFrontmatter(raw);
      const steps = frontmatter['exit'] as Array<{ type: string; key?: string; command?: string }>;
      assert.ok(Array.isArray(steps), 'exit should be a pipeline array');
      assert.equal(steps.length, 2);
      assert.deepEqual(steps[0], { type: 'keystroke', key: 'Escape' });
      assert.deepEqual(steps[1], { type: 'shell', command: '/exit' });
    });
  });

  // ── RFC-008 PR-B: telegram persona frontmatter field ─────────────────────
  // Mirrors the `env` nested-map precedent. The field carries ONLY non-secret
  // binding config (chatId/inbound/routing) — never a token. The nested parser
  // keeps scalar sub-values as STRINGS (so `inbound: true` → "true"); coercion
  // and validation live in the field-registry serialize/deserialize.
  describe('telegram field (RFC-008)', () => {
    let db: Database;
    let personasDir: string;

    before(() => {
      personasDir = mkdtempSync(join(tmpdir(), 'persona-telegram-'));
      db = new Database(join(personasDir, 'tg.db'));
    });

    after(() => {
      db.close();
      rmSync(personasDir, { recursive: true, force: true });
    });

    it('parses the nested telegram block (sub-values are strings, like env)', () => {
      const { frontmatter } = parseFrontmatter([
        '---',
        'engine: claude',
        'cwd: /tg',
        'telegram:',
        '  chatId: "-100123456"',
        '  inbound: true',
        '  routing: self',
        '---',
        '# Body',
      ].join('\n'));
      const tg = frontmatter['telegram'] as Record<string, unknown>;
      assert.equal(tg['chatId'], '"-100123456"');
      // Nested parser keeps scalars as strings — NOT a boolean.
      assert.equal(tg['inbound'], 'true');
      assert.equal(typeof tg['inbound'], 'string');
      assert.equal(tg['routing'], 'self');
    });

    it('syncs telegram to agentTelegram with inbound coerced to a boolean', () => {
      writeFileSync(join(personasDir, 'tg-self.md'), [
        '---',
        'engine: claude',
        'cwd: /tg-self',
        'telegram:',
        '  chatId: -100123456',
        '  inbound: true',
        '  routing: prefix',
        '---',
        '# Self',
      ].join('\n'));

      assert.equal(syncSinglePersona(db, 'tg-self', personasDir), true);
      const agent = db.getAgent('tg-self');
      assert.ok(agent);
      assert.deepEqual(agent.agentTelegram, {
        chatId: '-100123456',
        inbound: true,
        routing: 'prefix',
      });
      // Coerced to a real boolean, not the string "true".
      assert.equal(agent.agentTelegram!.inbound, true);
      assert.equal(typeof agent.agentTelegram!.inbound, 'boolean');
    });

    it('coerces inbound:false (the string-coercion gotcha) to false', () => {
      writeFileSync(join(personasDir, 'tg-out.md'), [
        '---',
        'engine: claude',
        'cwd: /tg-out',
        'telegram:',
        '  chatId: "-100999"',
        '  inbound: false',
        '---',
        '# Outbound-only',
      ].join('\n'));

      assert.equal(syncSinglePersona(db, 'tg-out', personasDir), true);
      const agent = db.getAgent('tg-out');
      assert.ok(agent);
      assert.equal(agent.agentTelegram!.inbound, false);
    });

    it('defaults inbound to true when absent and routing to self when invalid', () => {
      writeFileSync(join(personasDir, 'tg-def.md'), [
        '---',
        'engine: claude',
        'cwd: /tg-def',
        'telegram:',
        '  chatId: "12345"',
        '  routing: bogus',
        '  secretToken: should-be-dropped',
        '---',
        '# Defaults',
      ].join('\n'));

      assert.equal(syncSinglePersona(db, 'tg-def', personasDir), true);
      const agent = db.getAgent('tg-def');
      assert.ok(agent);
      // inbound defaults true; invalid routing falls back to self; unknown
      // sub-keys (incl. anything token-like) are dropped.
      assert.deepEqual(agent.agentTelegram, {
        chatId: '12345',
        inbound: true,
        routing: 'self',
      });
      assert.ok(!('secretToken' in (agent.agentTelegram as Record<string, unknown>)));
    });

    it('leaves agentTelegram null for personas without a telegram block', () => {
      writeFileSync(join(personasDir, 'tg-none.md'), [
        '---',
        'engine: claude',
        'cwd: /tg-none',
        'env:',
        '  FOO: bar',
        '---',
        '# No telegram',
      ].join('\n'));

      assert.equal(syncSinglePersona(db, 'tg-none', personasDir), true);
      const agent = db.getAgent('tg-none');
      assert.ok(agent);
      assert.equal(agent.agentTelegram, null);
      // Regression guard: unrelated config still parses unchanged.
      assert.deepEqual(agent.launchEnv, { FOO: 'bar' });
    });

    it('clears agentTelegram when the block is removed on re-sync', () => {
      writeFileSync(join(personasDir, 'tg-clear.md'), [
        '---',
        'engine: claude',
        'cwd: /tg-clear',
        'telegram:',
        '  chatId: "777"',
        '---',
        '# v1',
      ].join('\n'));
      syncSinglePersona(db, 'tg-clear', personasDir);
      assert.deepEqual(db.getAgent('tg-clear')!.agentTelegram, {
        chatId: '777', inbound: true, routing: 'self',
      });

      writeFileSync(join(personasDir, 'tg-clear.md'), '---\nengine: claude\ncwd: /tg-clear\n---\n# v2');
      syncSinglePersona(db, 'tg-clear', personasDir);
      assert.equal(db.getAgent('tg-clear')!.agentTelegram, null);
    });

    it('round-trips serialize → deserialize stably via the registry descriptor', () => {
      const field = CONFIG_FIELDS.find((f) => f.name === 'agentTelegram')!;
      assert.ok(field);
      assert.equal(field.column, 'agent_telegram');
      assert.equal(field.personaKey, 'telegram');
      assert.equal(field.nested, true);

      // Parsed-frontmatter shape (strings) → JSON → AgentTelegramConfig.
      const json = field.serialize!({ chatId: '-100123456', inbound: 'false', routing: 'passthrough' });
      assert.equal(typeof json, 'string');
      const first = field.deserialize!(json) as Record<string, unknown>;
      assert.deepEqual(first, { chatId: '-100123456', inbound: false, routing: 'passthrough' });

      // Re-serializing the deserialized value yields the identical JSON (stable).
      const json2 = field.serialize!(first);
      assert.equal(json2, json);
      assert.deepEqual(field.deserialize!(json2), first);

      // No usable chatId → null (both directions).
      assert.equal(field.serialize!({ inbound: 'true' }), null);
      assert.equal(field.serialize!(null), null);
      assert.equal(field.deserialize!(null), null);
      assert.equal(field.deserialize!(''), null);
    });

    it('detects telegram changes (deep equals) in syncPersonasWithDiff', () => {
      const diffDir = mkdtempSync(join(tmpdir(), 'persona-tg-diff-'));
      const diffDb = new Database(join(diffDir, 'd.db'));
      try {
        writeFileSync(join(diffDir, 'd.md'), [
          '---', 'engine: claude', 'cwd: /d',
          'telegram:', '  chatId: "1"', '---', '# d',
        ].join('\n'));
        assert.deepEqual(syncPersonasWithDiff(diffDb, diffDir).created, ['d']);
        // Identical re-sync = unchanged (equals deep-compares the parsed object).
        assert.deepEqual(syncPersonasWithDiff(diffDb, diffDir).unchanged, ['d']);

        writeFileSync(join(diffDir, 'd.md'), [
          '---', 'engine: claude', 'cwd: /d',
          'telegram:', '  chatId: "2"', '---', '# d',
        ].join('\n'));
        assert.deepEqual(syncPersonasWithDiff(diffDb, diffDir).updated, ['d']);
      } finally {
        diffDb.close();
        rmSync(diffDir, { recursive: true, force: true });
      }
    });

    it('carries telegram through splitFrontmatter passthrough (RFC-005 editor)', () => {
      const raw = [
        '---',
        'engine: claude',
        'cwd: /tg',
        'telegram:',
        '  chatId: "-100123456"',
        '  inbound: true',
        '---',
        '# Body',
      ].join('\n');
      const { core, passthroughRaw } = splitFrontmatter(raw);
      // telegram is not a CORE widget — it rides verbatim in the passthrough.
      assert.equal(core['telegram'], undefined);
      assert.ok(passthroughRaw.includes('telegram:'));
      assert.ok(passthroughRaw.includes('chatId: "-100123456"'));
    });
  });
});
