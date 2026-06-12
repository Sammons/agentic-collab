import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineProfileStore } from './engine-profiles.ts';

describe('EngineProfileStore', () => {
  let homeDir: string;
  let store: EngineProfileStore;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'engine-profiles-test-'));
    store = new EngineProfileStore(homeDir);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe('codex profiles', () => {
    const configPath = () => join(homeDir, '.codex', 'config.toml');

    it('writes a profile section with triple-quoted developer_instructions', () => {
      store.writeCodexProfile('codex-agent', 'You are agent codex-agent.\nUse `backticks` and $vars freely!');
      const config = readFileSync(configPath(), 'utf-8');
      assert.ok(config.includes('[profiles.codex-agent]'));
      assert.ok(config.includes('developer_instructions = """'));
      assert.ok(config.includes('Use `backticks` and $vars freely!'));
    });

    it('replaces an existing profile section instead of duplicating it', () => {
      store.writeCodexProfile('codex-agent', 'first prompt');
      store.writeCodexProfile('codex-agent', 'second prompt');
      const config = readFileSync(configPath(), 'utf-8');
      assert.equal(config.split('[profiles.codex-agent]').length - 1, 1);
      assert.ok(config.includes('second prompt'));
      assert.ok(!config.includes('first prompt'));
    });

    it('preserves other config sections when writing a profile', () => {
      store.writeCodexProfile('agent-a', 'prompt a');
      store.writeCodexProfile('agent-b', 'prompt b');
      const config = readFileSync(configPath(), 'utf-8');
      assert.ok(config.includes('[profiles.agent-a]'));
      assert.ok(config.includes('[profiles.agent-b]'));
    });

    it('escapes triple double quotes in instructions', () => {
      store.writeCodexProfile('codex-agent', 'before """ after');
      const config = readFileSync(configPath(), 'utf-8');
      assert.ok(!config.includes('before """ after'));
      assert.ok(config.includes('before ""\\u0022 after'));
    });

    it('removes a profile section', () => {
      store.writeCodexProfile('agent-a', 'prompt a');
      store.writeCodexProfile('agent-b', 'prompt b');
      store.removeCodexProfile('agent-a');
      const config = readFileSync(configPath(), 'utf-8');
      assert.ok(!config.includes('[profiles.agent-a]'));
      assert.ok(config.includes('[profiles.agent-b]'));
    });

    it('remove is a no-op when the config file does not exist', () => {
      store.removeCodexProfile('codex-agent');
      assert.equal(existsSync(configPath()), false);
    });

    it('rejects invalid profile names', () => {
      assert.throws(() => store.writeCodexProfile('bad name!', 'prompt'), /Invalid profile name/);
      assert.throws(() => store.removeCodexProfile('../escape'), /Invalid profile name/);
    });
  });

  describe('opencode instructions', () => {
    const instructionsPath = (name: string) => join(homeDir, '.config', 'opencode', 'collab', `${name}.md`);

    it('writes the prompt verbatim to ~/.config/opencode/collab/<name>.md', () => {
      const prompt = '# Persona\n\nYou are oc-agent. Use `backticks`, $vars, "quotes", and \'\'\'everything\'\'\' freely!';
      store.writeOpencodeInstructions('oc-agent', prompt);
      assert.equal(readFileSync(instructionsPath('oc-agent'), 'utf-8'), prompt);
    });

    it('overwrites an existing instructions file', () => {
      store.writeOpencodeInstructions('oc-agent', 'first prompt');
      store.writeOpencodeInstructions('oc-agent', 'second prompt');
      assert.equal(readFileSync(instructionsPath('oc-agent'), 'utf-8'), 'second prompt');
    });

    it('keeps sibling agents independent', () => {
      store.writeOpencodeInstructions('agent-a', 'prompt a');
      store.writeOpencodeInstructions('agent-b', 'prompt b');
      assert.equal(readFileSync(instructionsPath('agent-a'), 'utf-8'), 'prompt a');
      assert.equal(readFileSync(instructionsPath('agent-b'), 'utf-8'), 'prompt b');
    });

    it('removes the instructions file', () => {
      store.writeOpencodeInstructions('oc-agent', 'prompt');
      store.removeOpencodeInstructions('oc-agent');
      assert.equal(existsSync(instructionsPath('oc-agent')), false);
    });

    it('remove is a no-op when the file does not exist', () => {
      store.removeOpencodeInstructions('oc-agent');
      assert.equal(existsSync(instructionsPath('oc-agent')), false);
    });

    it('rejects invalid agent names (path traversal)', () => {
      assert.throws(() => store.writeOpencodeInstructions('../../etc/passwd', 'x'), /Invalid profile name/);
      assert.throws(() => store.removeOpencodeInstructions('a/b'), /Invalid profile name/);
    });
  });
});
