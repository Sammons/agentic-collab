import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePersonaPath, loadPersona, composeSystemPrompt } from './persona.ts';

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

    it('loads empty file content', () => {
      const path = join(tmpDir, 'empty-persona.md');
      writeFileSync(path, '');
      assert.equal(loadPersona(path), '');
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
      assert.ok(prompt.includes('http://localhost:3000'));
      assert.ok(prompt.includes('curl'));
      assert.ok(prompt.includes('/api/agents/send'));
      assert.ok(prompt.includes('/api/dashboard/reply'));
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
});
