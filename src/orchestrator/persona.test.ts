import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolvePersonaPath, loadPersona, composeSystemPrompt, parseFrontmatter, scanPersonas, syncSinglePersona, syncPersonasToDb, syncPersonasWithDiff, createPersonaAndAgent, toHostPath, serializeHookValue, deserializeHookValue } from './persona.ts';
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
      assert.ok(prompt.includes('collab list-agents'));
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
      const raw = '---\nengine: claude\nmodel: opus\nthinking: high\ncwd: /project\nproxy_host: myhost\npermissions: skip\n---\nBody';
      const { frontmatter } = parseFrontmatter(raw);
      assert.equal(frontmatter['engine'], 'claude');
      assert.equal(frontmatter['model'], 'opus');
      assert.equal(frontmatter['thinking'], 'high');
      assert.equal(frontmatter['cwd'], '/project');
      assert.equal(frontmatter['proxy_host'], 'myhost');
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
        'proxy_host: myhost',
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
      assert.equal(alpha.proxyHost, 'myhost');
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

    it('throws for invalid engine', () => {
      const personasDir = join(createDir, 'personas');
      assert.throws(
        () => createPersonaAndAgent(createDb, 'bad-agent', '---\nengine: gpt\ncwd: /tmp\n---\nBody', personasDir),
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
        '---', 'engine: claude', 'model: opus', 'cwd: /tmp', 'proxy_host: crankshaft',
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
  });
});
