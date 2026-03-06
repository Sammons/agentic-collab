import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from './claude.ts';
import { CodexAdapter } from './codex.ts';
import { OpenCodeAdapter } from './opencode.ts';
import { getAdapter } from './index.ts';

describe('Engine Adapters', () => {
  describe('getAdapter', () => {
    it('returns ClaudeAdapter for claude', () => {
      const adapter = getAdapter('claude');
      assert.equal(adapter.engine, 'claude');
    });

    it('returns CodexAdapter for codex', () => {
      const adapter = getAdapter('codex');
      assert.equal(adapter.engine, 'codex');
    });

    it('returns OpenCodeAdapter for opencode', () => {
      const adapter = getAdapter('opencode');
      assert.equal(adapter.engine, 'opencode');
    });

    it('throws for unknown engine', () => {
      assert.throws(() => getAdapter('unknown' as 'claude'), /Unknown engine/);
    });
  });

  describe('ClaudeAdapter', () => {
    const adapter = new ClaudeAdapter();

    it('builds spawn command with all options', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        model: 'opus',
        thinking: 'high',
        task: 'fix the bug',
        appendSystemPrompt: 'You are helpful',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('claude'));
      assert.ok(cmd.includes('--dangerously-skip-permissions'));
      assert.ok(cmd.includes('--model opus'));
      assert.ok(cmd.includes('--append-system-prompt'));
      assert.ok(cmd.includes('fix the bug'));
    });

    it('builds spawn command with minimal options (no skip-permissions by default)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
      });
      assert.ok(cmd.includes('claude'));
      assert.ok(!cmd.includes('--model'));
      assert.ok(!cmd.includes('--dangerously-skip-permissions'));
    });

    it('builds spawn command with skip-permissions when explicitly enabled', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('--dangerously-skip-permissions'));
    });

    it('builds resume command with session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'test-agent',
        sessionId: 'abc-123',
        cwd: '/tmp/test',
      });
      assert.ok(cmd.includes('--resume'));
      assert.ok(cmd.includes('abc-123'));
    });

    it('builds exit command', () => {
      assert.equal(adapter.buildExitCommand(), '/exit');
    });

    it('builds compact command', () => {
      assert.equal(adapter.buildCompactCommand(), '/compact');
    });

    it('builds rename command', () => {
      const cmd = adapter.buildRenameCommand('my-agent');
      assert.equal(cmd, '/rename my-agent');
    });

    it('returns interrupt keys', () => {
      const keys = adapter.interruptKeys();
      assert.ok(keys.length > 0);
      assert.ok(keys.every(k => k === 'Escape'));
    });

    it('detects idle state from prompt', () => {
      assert.equal(adapter.detectIdleState('some output\n> '), 'waiting_for_input');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('some output\n⠋ Running task...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('some random text'), 'unknown');
    });

    it('parses context percent', () => {
      const result = adapter.parseContextPercent('some output\n45% context remaining\nmore text');
      assert.equal(result.contextPct, 45);
      assert.equal(result.confident, true);
    });

    it('returns null context for no match', () => {
      const result = adapter.parseContextPercent('no context info here');
      assert.equal(result.contextPct, null);
      assert.equal(result.confident, false);
    });
  });

  describe('CodexAdapter', () => {
    const adapter = new CodexAdapter();

    it('builds spawn command', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        model: 'gpt-4',
        task: 'hello world',
      });
      assert.ok(cmd.includes('codex'));
      assert.ok(cmd.includes('--model'));
      assert.ok(cmd.includes('gpt-4'));
    });

    it('builds resume as new spawn (no native resume)', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz',
        cwd: '/tmp',
        task: 'continue',
      });
      assert.ok(cmd.includes('codex'));
      assert.ok(!cmd.includes('xyz')); // no session resume support
    });

    it('returns null for rename', () => {
      assert.equal(adapter.buildRenameCommand('test'), null);
    });

    it('returns null context percent', () => {
      const result = adapter.parseContextPercent('anything');
      assert.equal(result.contextPct, null);
    });

    it('builds exit command', () => {
      assert.equal(adapter.buildExitCommand(), '/exit');
    });

    it('builds compact command', () => {
      assert.equal(adapter.buildCompactCommand(), '/compact');
    });

    it('returns interrupt keys', () => {
      const keys = adapter.interruptKeys();
      assert.ok(keys.length > 0);
      assert.ok(keys.every(k => k === 'Escape'));
    });

    it('detects idle state from prompt', () => {
      assert.equal(adapter.detectIdleState('output\n> '), 'waiting_for_input');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('output\n⠋ Running...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('random text'), 'unknown');
    });
  });

  describe('OpenCodeAdapter', () => {
    const adapter = new OpenCodeAdapter();

    it('builds spawn command', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        model: 'claude-3.5',
      });
      assert.ok(cmd.includes('opencode'));
      assert.ok(cmd.includes('--model'));
    });

    it('builds resume with session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        sessionId: 'sess-1',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('--session'));
      assert.ok(cmd.includes('sess-1'));
    });

    it('returns null for rename', () => {
      assert.equal(adapter.buildRenameCommand('test'), null);
    });

    it('builds exit command', () => {
      assert.equal(adapter.buildExitCommand(), '/exit');
    });

    it('builds compact command', () => {
      assert.equal(adapter.buildCompactCommand(), '/compact');
    });

    it('returns interrupt keys', () => {
      const keys = adapter.interruptKeys();
      assert.ok(keys.length > 0);
      assert.ok(keys.every(k => k === 'Escape'));
    });

    it('detects idle state from prompt', () => {
      assert.equal(adapter.detectIdleState('output\n> '), 'waiting_for_input');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('output\n⠋ Running...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('random text'), 'unknown');
    });

    it('returns null context percent', () => {
      const result = adapter.parseContextPercent('anything');
      assert.equal(result.contextPct, null);
    });
  });
});
