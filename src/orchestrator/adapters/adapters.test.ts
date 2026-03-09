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

    it('builds spawn command with skip-permissions using granular flags', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('-a never'), 'should include -a never');
      assert.ok(cmd.includes('-s danger-full-access'), 'should include -s danger-full-access');
      assert.ok(!cmd.includes('--dangerously-bypass-approvals-and-sandbox'), 'should not use monolithic bypass flag');
    });

    it('supports resume prompt', () => {
      assert.equal(adapter.supportsResumePrompt, true);
    });

    it('builds spawn command with -p profile when appendSystemPrompt is set', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        appendSystemPrompt: 'You are a helpful assistant',
      });
      // Profile-based injection: -p <agent-name>, NOT -c developer_instructions
      assert.ok(cmd.includes('-p codex-agent'));
      assert.ok(!cmd.includes('-c'));
      assert.ok(!cmd.includes('developer_instructions'));
    });

    it('omits -p flag when appendSystemPrompt is undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(!cmd.includes('-p'));
      assert.ok(!cmd.includes('-c'));
    });

    it('has usesConfigProfile set to true', () => {
      assert.equal(adapter.usesConfigProfile, true);
    });

    it('omits optional flags when undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        model: undefined,
        task: undefined,
        thinking: undefined,
      });
      assert.equal(cmd, 'codex --no-alt-screen');
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
      assert.ok(cmd.includes('codex --no-alt-screen resume'));
      assert.ok(cmd.includes('xyz-123'));
    });

    it('builds resume with --last when no session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('--last'));
    });

    it('builds resume command with -p profile when appendSystemPrompt is set', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
        appendSystemPrompt: 'You are a code reviewer',
      });
      assert.ok(cmd.includes('codex --no-alt-screen resume'));
      assert.ok(cmd.includes('xyz-123'));
      assert.ok(cmd.includes('-p codex-agent'));
      assert.ok(!cmd.includes('-c'));
    });

    it('omits -p flag on resume when appendSystemPrompt is undefined', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
      });
      assert.ok(!cmd.includes('-p'));
      assert.ok(!cmd.includes('-c'));
    });

    it('returns null for rename', () => {
      assert.equal(adapter.buildRenameCommand('test'), null);
    });

    it('builds exit command', () => {
      assert.equal(adapter.buildExitCommand(), '/exit');
    });

    it('returns null for compact (Codex has no compaction support)', () => {
      assert.equal(adapter.buildCompactCommand(), null);
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

    it('detects idle state from Unicode ❯ prompt', () => {
      assert.equal(adapter.detectIdleState('output\n❯ '), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('output\n❯'), 'waiting_for_input');
    });

    it('detects idle from ❯ prompt with tokens/version status bar', () => {
      const pane = [
        '● Status sent to dashboard. Standing by.',
        '',
        '────────────────────────────────────────────────────────────────────────── ▪▪▪ ─',
        '❯ ',
        '────────────────────────────────────────────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cyc…                     44091 tokens',
        '                                               current: 2.1.71 · latest: 2.1.…',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('extractSessionId returns null (Codex falls back to --last)', () => {
      assert.equal(adapter.extractSessionId('any codex output'), null);
    });
  });

  describe('OpenCodeAdapter', () => {
    const adapter = new OpenCodeAdapter();

    it('builds spawn command for TUI mode (no run subcommand)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        model: 'claude-3.5',
      });
      assert.equal(cmd, 'opencode -m claude-3.5');
      assert.ok(!cmd.includes('run'));
    });

    it('builds spawn command without task (TUI launches empty)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
      });
      assert.equal(cmd, 'opencode');
    });

    it('builds spawn command with variant for thinking', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        thinking: 'high',
      });
      assert.equal(cmd, 'opencode --variant high');
    });

    it('builds resume with -s for session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        sessionId: 'ses_abc123',
        cwd: '/tmp',
      });
      assert.equal(cmd, 'opencode -s ses_abc123');
    });

    it('falls back to plain opencode when no session ID (no -c in TUI mode)', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        cwd: '/tmp',
      });
      assert.equal(cmd, 'opencode');
      assert.ok(!cmd.includes('-c'));
    });

    it('returns null for rename', () => {
      assert.equal(adapter.buildRenameCommand('test'), null);
    });

    it('provides exit keys (Ctrl-C)', () => {
      const keys = adapter.exitKeys!();
      assert.deepStrictEqual(keys, ['C-c']);
    });

    it('provides compact keys (Ctrl-X C)', () => {
      const keys = adapter.compactKeys!();
      assert.deepStrictEqual(keys, ['C-x', 'c']);
    });

    it('returns interrupt keys (single Escape)', () => {
      const keys = adapter.interruptKeys();
      assert.deepStrictEqual(keys, ['Escape']);
    });

    it('detects idle from TUI status bar', () => {
      const pane = 'some output\n  ctrl+t variants  tab agents  ctrl+p commands';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle from Ask anything placeholder', () => {
      const pane = 'output\n  Ask anything... "Fix a TODO in the codebase"';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects running from esc interrupt indicator', () => {
      const pane = 'output\n  esc interrupt                    ctrl+t variants';
      assert.equal(adapter.detectIdleState(pane), 'running_tool');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('output\n⠋ Running...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('random text'), 'unknown');
    });

    it('parses context percent from TUI sidebar', () => {
      const pane = 'Context\n  11,371 tokens\n  6% used\n  $0.00 spent';
      const result = adapter.parseContextPercent(pane);
      assert.equal(result.contextPct, 6);
      assert.equal(result.confident, true);
    });

    it('returns null context when no percentage visible', () => {
      const result = adapter.parseContextPercent('anything');
      assert.equal(result.contextPct, null);
    });

    it('extracts session ID from exit output', () => {
      const pane = 'Session   TUICHECK\n  Continue  opencode -s ses_32f35bf21ffeHDy7IvecACDwDY\nsammons@host:~$';
      assert.equal(adapter.extractSessionId(pane), 'ses_32f35bf21ffeHDy7IvecACDwDY');
    });

    it('returns null session ID when not present', () => {
      assert.equal(adapter.extractSessionId('any opencode output'), null);
    });
  });
});
