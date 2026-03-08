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
      assert.ok(cmd.includes('--effort high'));
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
      assert.ok(!cmd.includes('--effort'));
      assert.ok(!cmd.includes('--dangerously-skip-permissions'));
      assert.ok(!cmd.includes('-p'));
    });

    it('builds spawn command with skip-permissions when explicitly enabled', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('--dangerously-skip-permissions'));
    });

    it('omits optional flags when undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        model: undefined,
        thinking: undefined,
        task: undefined,
        appendSystemPrompt: undefined,
      });
      assert.equal(cmd, 'claude');
    });

    it('builds spawn command with pre-set session ID', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      assert.ok(cmd.includes('--session-id'));
      assert.ok(cmd.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    });

    it('omits --session-id when not provided', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
      });
      assert.ok(!cmd.includes('--session-id'));
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

    it('extractSessionId returns null (Claude uses --session-id at spawn)', () => {
      assert.equal(adapter.extractSessionId('any pane output'), null);
    });

    it('detects idle state from ASCII > prompt', () => {
      assert.equal(adapter.detectIdleState('some output\n> '), 'waiting_for_input');
    });

    it('detects idle state from Unicode ❯ prompt', () => {
      assert.equal(adapter.detectIdleState('some output\n❯ '), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('some output\n❯'), 'waiting_for_input');
    });

    it('detects idle state skipping context-left and Remote Control status bar', () => {
      const pane = [
        '  Standing by for new tasks.',
        '',
        '──────────── ▪▪▪ ─',
        '❯ ',
        '────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cyc…      155377 tokens Remote Control reconnecting',
        '                                                       Context left until auto-compact: 7%',
        '                                                          current: 2.1.70 · latest: 2.1.71',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle state skipping status bar lines', () => {
      // Real Claude Code v2.x output: status bar at bottom, prompt above it
      const pane = [
        '  What would you like to work on?',
        '',
        '──────────────────────────── ▪▪▪ ─',
        '❯ ',
        '────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cyc…      /ide for Visual Studio Code',
        '                                                                  15048 tokens',
        '                                               current: 2.1.70 · latest: 2.1.…',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('some output\n⠋ Running task...'), 'running_tool');
    });

    it('detects running state from tool name', () => {
      assert.equal(adapter.detectIdleState('some output\n  Bash git status'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('some random text'), 'unknown');
    });

    it('parses context percent from percentage format', () => {
      const result = adapter.parseContextPercent('some output\n45% context remaining\nmore text');
      assert.equal(result.contextPct, 45);
      assert.equal(result.confident, true);
    });

    it('parses context percent from token count format', () => {
      const result = adapter.parseContextPercent('some output\n                                                                  15048 tokens');
      assert.equal(result.contextPct, 8); // 15048/200000 ≈ 7.5% rounds to 8%
      assert.equal(result.confident, true);
    });

    it('parses context percent from large token count', () => {
      const result = adapter.parseContextPercent('  160000 tokens');
      assert.equal(result.contextPct, 80);
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

    it('builds spawn command with model and task', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        model: 'gpt-4',
        task: 'hello world',
      });
      assert.ok(cmd.includes('codex'));
      assert.ok(cmd.includes('--model gpt-4'));
      assert.ok(cmd.includes('hello world'));
    });

    it('builds spawn command with skip-permissions', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
    });

    it('builds spawn command with appendSystemPrompt', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        appendSystemPrompt: 'You are a helpful assistant',
      });
      assert.ok(cmd.includes('-c developer_instructions='));
      assert.ok(cmd.includes('You are a helpful assistant'));
    });

    it('escapes double quotes in appendSystemPrompt for TOML', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        appendSystemPrompt: 'Say "hello" to the user',
      });
      assert.ok(cmd.includes('\\"hello\\"'));
      assert.ok(!cmd.includes('""'));
    });

    it('escapes newlines in appendSystemPrompt for TOML', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        appendSystemPrompt: 'Line one\nLine two',
      });
      assert.ok(cmd.includes('Line one\\nLine two'));
    });

    it('omits -c flag when appendSystemPrompt is undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(!cmd.includes('-c'));
      assert.ok(!cmd.includes('developer_instructions'));
    });

    it('omits optional flags when undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        model: undefined,
        task: undefined,
        thinking: undefined,
      });
      assert.equal(cmd, 'codex');
    });

    it('ignores thinking (codex has no reasoning effort flag)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        thinking: 'high',
      });
      assert.ok(!cmd.includes('thinking'));
      assert.ok(!cmd.includes('effort'));
      assert.ok(!cmd.includes('variant'));
      assert.ok(!cmd.includes('high'));
    });

    it('builds resume with session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
        task: 'continue',
      });
      assert.ok(cmd.includes('codex resume'));
      assert.ok(cmd.includes('xyz-123'));
    });

    it('builds resume with --last when no session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('--last'));
    });

    it('builds resume command with appendSystemPrompt', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
        appendSystemPrompt: 'You are a code reviewer',
      });
      assert.ok(cmd.includes('codex resume'));
      assert.ok(cmd.includes('xyz-123'));
      assert.ok(cmd.includes('-c developer_instructions='));
      assert.ok(cmd.includes('You are a code reviewer'));
    });

    it('omits -c flag on resume when appendSystemPrompt is undefined', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
      });
      assert.ok(!cmd.includes('-c'));
      assert.ok(!cmd.includes('developer_instructions'));
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

    it('detects idle state from ASCII > prompt', () => {
      assert.equal(adapter.detectIdleState('output\n> '), 'waiting_for_input');
    });

    it('detects idle state from Unicode › prompt', () => {
      assert.equal(adapter.detectIdleState('output\n› Implement {feature}'), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('output\n› '), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('output\n›'), 'waiting_for_input');
    });

    it('detects idle from prompt with status bar below', () => {
      const pane = '› Implement {feature}\n\n  gpt-5.4 xhigh · 81% left · ~/Desktop';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle from prompt with "context left" status bar', () => {
      const pane = '› \n\n  tab to queue message                                                  83% context left';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects running from Working indicator above prompt', () => {
      const pane = [
        '◦ Working (32s • esc to interrupt)',
        '',
        '› [Pasted Content]',
        '',
        '  tab to queue message                                                  79% context left',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'running_tool');
    });

    it('detects running from bullet Working indicator', () => {
      const pane = '• Working (1m 14s • esc to interrupt)\n› queued msg\n  83% context left';
      assert.equal(adapter.detectIdleState(pane), 'running_tool');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('output\n⠋ Running...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('random text'), 'unknown');
    });

    it('parses context percent from status bar', () => {
      const result = adapter.parseContextPercent('gpt-5.4 xhigh · 81% left · ~/Desktop');
      assert.equal(result.contextPct, 19); // 100 - 81 = 19% used
      assert.equal(result.confident, true);
    });

    it('parses context percent from low remaining', () => {
      const result = adapter.parseContextPercent('gpt-5.4 · 15% left · ~/path');
      assert.equal(result.contextPct, 85);
      assert.equal(result.confident, true);
    });

    it('parses context percent from "context left" variant', () => {
      const result = adapter.parseContextPercent('tab to queue message                                                  83% context left');
      assert.equal(result.contextPct, 17);
      assert.equal(result.confident, true);
    });

    it('returns null context when no match', () => {
      const result = adapter.parseContextPercent('no context info');
      assert.equal(result.contextPct, null);
      assert.equal(result.confident, false);
    });

    it('extractSessionId returns null (Codex falls back to --last)', () => {
      assert.equal(adapter.extractSessionId('any codex output'), null);
    });
  });

  describe('OpenCodeAdapter', () => {
    const adapter = new OpenCodeAdapter();

    it('builds spawn command with run subcommand', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        model: 'claude-3.5',
      });
      assert.ok(cmd.startsWith('opencode run'));
      assert.ok(cmd.includes('-m claude-3.5'));
    });

    it('builds spawn command with task as positional arg', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        task: 'fix the bug',
      });
      assert.ok(cmd.startsWith('opencode run'));
      assert.ok(cmd.includes('fix the bug'));
      assert.ok(!cmd.includes('--prompt'));
    });

    it('builds spawn command with variant for thinking', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        thinking: 'high',
      });
      assert.ok(cmd.includes('--variant high'));
    });

    it('omits optional flags when undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        model: undefined,
        task: undefined,
        thinking: undefined,
      });
      assert.equal(cmd, 'opencode run');
    });

    it('builds resume with -s for session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        sessionId: 'sess-1',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('opencode run'));
      assert.ok(cmd.includes('-s sess-1'));
    });

    it('builds resume with -c when no session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('-c'));
      assert.ok(!cmd.includes('--continue'));
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

    it('extractSessionId returns null (OpenCode falls back to -c)', () => {
      assert.equal(adapter.extractSessionId('any opencode output'), null);
    });
  });
});
