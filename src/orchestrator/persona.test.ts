import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolvePersonaPath, loadPersona, composeSystemPrompt, parseFrontmatter, scanPersonas, syncPersonasToDb, createPersonaAndAgent, toHostPath, serializeHookValue, deserializeHookValue } from './persona.ts';
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
      assert.ok(prompt.includes('collab send'));
      assert.ok(prompt.includes('collab reply'));
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
      writeFileSync(join(personasDir, 'alpha.md'), '---\nengine: claude\nmodel: opus\nthinking: high\ncwd: /alpha\nproxy_host: myhost\npermissions: skip\n---\n# Alpha agent');
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
      writeFileSync(join(personasDir, 'alpha.md'), '---\nengine: claude\nmodel: sonnet\ncwd: /alpha-v2\n---\n# Alpha v2');

      const synced = syncPersonasToDb(db, personasDir);
      assert.equal(synced, 2);

      const updated = db.getAgent('alpha')!;
      assert.equal(updated.model, 'sonnet');
      assert.equal(updated.cwd, '/alpha-v2');
      assert.equal(updated.state, 'active'); // runtime state preserved
      assert.equal(updated.tmuxSession, 'agent-alpha'); // runtime state preserved
      assert.equal(updated.proxyId, 'proxy-1'); // runtime state preserved
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
      const content = '---\nengine: claude\nmodel: opus\ncwd: /project\n---\n# My Agent\nDoes stuff.';
      const persona = createPersonaAndAgent(createDb, 'my-agent', content, personasDir);

      assert.equal(persona.name, 'my-agent');
      assert.equal(persona.frontmatter.engine, 'claude');
      assert.equal(persona.frontmatter.model, 'opus');
      assert.equal(persona.frontmatter.cwd, '/project');
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
});
