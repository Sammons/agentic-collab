import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveHook, resolveAgentHook, interpolateTemplateVars } from './hook-resolver.ts';
import type { AgentRecord } from '../shared/types.ts';

// ── Helpers ──

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'test-agent',
    engine: 'claude',
    model: null,
    thinking: null,
    cwd: '/tmp/test',
    persona: null,
    permissions: null,
    proxyHost: null,
    agentGroup: null,
    sortOrder: 0,
    hookStart: null,
    hookResume: null,
    hookCompact: null,
    hookExit: null,
    hookInterrupt: null,
    hookSubmit: null,
    state: 'idle',
    stateBeforeShutdown: null,
    currentSessionId: null,
    tmuxSession: null,
    proxyId: null,
    lastActivity: null,
    lastContextPct: null,
    reloadQueued: 0,
    reloadTask: null,
    failedAt: null,
    failureReason: null,
    version: 0,
    spawnCount: 0,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ──

describe('hook-resolver', () => {
  describe('null value → preset behavior', () => {
    it('start: returns adapter buildSpawnCommand', () => {
      const agent = makeAgent();
      const result = resolveHook('start', null, agent, {
        spawnOpts: { name: 'test-agent', cwd: '/tmp/test', model: 'sonnet' },
      });
      assert.equal(result.mode, 'paste');
      assert.ok((result as { text: string }).text.includes('claude'));
      assert.ok((result as { text: string }).text.includes('sonnet'));
    });

    it('resume: returns adapter buildResumeCommand', () => {
      const agent = makeAgent();
      const result = resolveHook('resume', null, agent, {
        resumeOpts: { name: 'test-agent', sessionId: 'sess-123', cwd: '/tmp/test' },
      });
      assert.equal(result.mode, 'paste');
      assert.ok((result as { text: string }).text.includes('--resume'));
      assert.ok((result as { text: string }).text.includes('sess-123'));
    });

    it('exit: returns adapter exit command (Claude uses paste)', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', null, agent);
      // Claude doesn't define exitKeys(), so it should paste /exit
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/exit');
    });

    it('exit: returns keys for engines with exitKeys()', () => {
      const agent = makeAgent({ engine: 'opencode' });
      const result = resolveHook('exit', null, agent);
      // OpenCode defines exitKeys, so should return keys
      assert.equal(result.mode, 'keys');
    });

    it('compact: returns adapter compact command (Claude uses paste)', () => {
      const agent = makeAgent();
      const result = resolveHook('compact', null, agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/compact');
    });

    it('interrupt: returns adapter interruptKeys', () => {
      const agent = makeAgent();
      const result = resolveHook('interrupt', null, agent);
      assert.equal(result.mode, 'keys');
      assert.ok((result as { keys: string[] }).keys.length > 0);
    });

    it('submit: returns skip when no task provided', () => {
      const agent = makeAgent();
      const result = resolveHook('submit', null, agent);
      assert.equal(result.mode, 'skip');
    });

    it('submit: returns paste with task text', () => {
      const agent = makeAgent();
      const result = resolveHook('submit', null, agent, { task: 'do the thing' });
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, 'do the thing');
    });

    it('start: throws without spawnOpts', () => {
      const agent = makeAgent();
      assert.throws(() => resolveHook('start', null, agent), /spawnOpts required/);
    });

    it('resume: throws without resumeOpts', () => {
      const agent = makeAgent();
      assert.throws(() => resolveHook('resume', null, agent), /resumeOpts required/);
    });
  });

  describe('preset: prefix', () => {
    it('preset:claude resolves to Claude adapter', () => {
      const agent = makeAgent({ engine: 'codex' }); // agent is codex but hook says preset:claude
      const result = resolveHook('exit', 'preset:claude', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/exit');
    });

    it('preset: with empty engine falls back to agent engine', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', 'preset:', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/exit');
    });
  });

  describe('inline string', () => {
    it('bare string returns paste', () => {
      const agent = makeAgent();
      const result = resolveHook('start', 'my-custom-cmd --flag', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, 'my-custom-cmd --flag');
    });

    it('works for exit hook', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', '/quit', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/quit');
    });

    it('works for compact hook', () => {
      const agent = makeAgent();
      const result = resolveHook('compact', 'echo compact-noop', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, 'echo compact-noop');
    });
  });

  describe('file: prefix', () => {
    const testDir = join(tmpdir(), 'hook-resolver-test-' + process.pid);

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
    });

    it('reads file content and returns paste', () => {
      const scriptPath = join(testDir, 'start.sh');
      writeFileSync(scriptPath, '#!/bin/bash\nclaude --model opus\n');

      const agent = makeAgent();
      const result = resolveHook('start', `file:${scriptPath}`, agent);
      assert.equal(result.mode, 'paste');
      assert.ok((result as { text: string }).text.includes('claude --model opus'));
    });

    it('trims whitespace from file content', () => {
      const scriptPath = join(testDir, 'trimmed.sh');
      writeFileSync(scriptPath, '\n  my-cmd --flag  \n\n');

      const agent = makeAgent();
      const result = resolveHook('start', `file:${scriptPath}`, agent);
      assert.equal((result as { text: string }).text, 'my-cmd --flag');
    });

    it('returns skip for empty file', () => {
      const scriptPath = join(testDir, 'empty.sh');
      writeFileSync(scriptPath, '   \n  \n');

      const agent = makeAgent();
      const result = resolveHook('start', `file:${scriptPath}`, agent);
      assert.equal(result.mode, 'skip');
    });

    it('throws for relative path', () => {
      const agent = makeAgent();
      assert.throws(
        () => resolveHook('start', 'file:relative/path.sh', agent),
        /path must be absolute/,
      );
    });

    it('throws for nonexistent file', () => {
      const agent = makeAgent();
      assert.throws(
        () => resolveHook('start', 'file:/nonexistent/path.sh', agent),
        /failed to read/,
      );
    });

    it('throws for path with traversal', () => {
      const agent = makeAgent();
      assert.throws(
        () => resolveHook('start', 'file:/tmp/../etc/passwd', agent),
        /traversal/,
      );
    });

    // Cleanup
    it('cleanup test dir', () => {
      rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe('structured preset hook', () => {
    it('resolves { preset: "claude" } same as "preset:claude"', () => {
      const agent = makeAgent({ engine: 'codex' });
      const result = resolveHook('exit', { preset: 'claude' }, agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/exit');
    });

    it('applies preset options to spawnOpts', () => {
      const agent = makeAgent();
      const result = resolveHook('start', { preset: 'claude', options: { model: 'opus' } }, agent, {
        spawnOpts: { name: 'test-agent', cwd: '/tmp', model: 'sonnet' },
      });
      assert.equal(result.mode, 'paste');
      // The options.model should override spawnOpts.model
      assert.ok((result as { text: string }).text.includes('opus'));
    });

    it('applies permissions skip from preset options', () => {
      const agent = makeAgent();
      const result = resolveHook('start', { preset: 'claude', options: { permissions: 'skip' } }, agent, {
        spawnOpts: { name: 'test-agent', cwd: '/tmp' },
      });
      assert.equal(result.mode, 'paste');
      // Skip permissions should add the --dangerously-skip-permissions flag
      assert.ok((result as { text: string }).text.includes('--dangerously-skip-permissions'));
    });
  });

  describe('structured shell hook', () => {
    it('returns paste with bare command (no COLLAB_AGENT — lifecycle layer handles that)', () => {
      const agent = makeAgent({ name: 'my-agent' });
      const result = resolveHook('start', { shell: './run.sh' }, agent);
      assert.equal(result.mode, 'paste');
      const text = (result as { text: string }).text;
      assert.ok(!text.includes('COLLAB_AGENT='), 'ShellHook should not inject COLLAB_AGENT');
      assert.equal(text, './run.sh', 'bare shell hook without env should return just the command');
    });

    it('includes custom env vars (shell-quoted, no COLLAB_AGENT)', () => {
      const agent = makeAgent({ name: 'my-agent' });
      const result = resolveHook('start', { shell: './run.sh', env: { FOO: 'bar', BAZ: 'hello world' } }, agent);
      const text = (result as { text: string }).text;
      assert.ok(text.includes("FOO='bar'"), 'env values should be shell-quoted');
      assert.ok(text.includes("BAZ='hello world'"), 'env values with spaces should be shell-quoted');
      assert.ok(!text.includes('COLLAB_AGENT='), 'should not include COLLAB_AGENT');
      assert.ok(text.includes('./run.sh'), 'should include the command');
    });
  });

  describe('structured send hook', () => {
    it('returns send mode with actions', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', { send: [{ keystroke: 'Escape' }, { keystroke: 'C-c' }] }, agent);
      assert.equal(result.mode, 'send');
      const actions = (result as { actions: Array<{ keystroke: string }> }).actions;
      assert.equal(actions.length, 2);
      assert.equal(actions[0]!.keystroke, 'Escape');
      assert.equal(actions[1]!.keystroke, 'C-c');
    });

    it('preserves post_wait_ms on actions', () => {
      const agent = makeAgent();
      const result = resolveHook('submit', {
        send: [
          { keystroke: 'Escape', post_wait_ms: 100 },
          { paste: 'hello' },
          { keystroke: 'Enter' },
        ],
      }, agent);
      assert.equal(result.mode, 'send');
      const actions = (result as { actions: Array<Record<string, unknown>> }).actions;
      assert.equal(actions[0]!.post_wait_ms, 100);
    });

    it('returns skip for empty send array', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', { send: [] }, agent);
      assert.equal(result.mode, 'skip');
    });
  });

  describe('structured keystrokes hook', () => {
    it('returns send mode with actions from keystrokes key', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', { keystrokes: [{ keystroke: 'Escape' }, { keystroke: 'Enter' }] }, agent);
      assert.equal(result.mode, 'send');
      const actions = (result as { actions: Array<{ keystroke: string }> }).actions;
      assert.equal(actions.length, 2);
      assert.equal(actions[0]!.keystroke, 'Escape');
      assert.equal(actions[1]!.keystroke, 'Enter');
    });

    it('preserves post_wait_ms on keystrokes actions', () => {
      const agent = makeAgent();
      const result = resolveHook('compact', {
        keystrokes: [
          { keystroke: 'Escape', post_wait_ms: 200 },
          { paste: '/compact' },
          { keystroke: 'Enter' },
        ],
      }, agent);
      assert.equal(result.mode, 'send');
      const actions = (result as { actions: Array<Record<string, unknown>> }).actions;
      assert.equal(actions[0]!.post_wait_ms, 200);
    });

    it('returns skip for empty keystrokes array', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', { keystrokes: [] }, agent);
      assert.equal(result.mode, 'skip');
    });

    it('deserializes JSON keystrokes hook from string', () => {
      const agent = makeAgent();
      const jsonValue = JSON.stringify({ keystrokes: [{ keystroke: 'Escape' }] });
      const result = resolveHook('exit', jsonValue, agent);
      assert.equal(result.mode, 'send');
      const actions = (result as { actions: Array<{ keystroke: string }> }).actions;
      assert.equal(actions[0]!.keystroke, 'Escape');
    });
  });

  describe('pipeline hooks', () => {
    it('resolves array of steps to pipeline mode', () => {
      const agent = makeAgent();
      const steps = [
        { type: 'keystrokes' as const, actions: [{ keystroke: 'Escape' }] },
        { type: 'shell' as const, command: '/exit' },
      ];
      const result = resolveHook('exit', steps, agent);
      assert.equal(result.mode, 'pipeline');
      const pipeline = (result as { steps: Array<{ type: string }> }).steps;
      assert.equal(pipeline.length, 2);
      assert.equal(pipeline[0]!.type, 'keystrokes');
      assert.equal(pipeline[1]!.type, 'shell');
    });

    it('interpolates template vars in shell steps', () => {
      const agent = makeAgent();
      const steps = [
        { type: 'shell' as const, command: 'codex resume $SESSION_ID' },
      ];
      const result = resolveHook('resume', steps, agent, {
        templateVars: { SESSION_ID: 'abc-123' },
      });
      assert.equal(result.mode, 'pipeline');
      const pipeline = (result as { steps: Array<{ type: string; command: string }> }).steps;
      assert.equal(pipeline[0]!.command, 'codex resume abc-123');
    });

    it('returns skip for empty pipeline', () => {
      const agent = makeAgent();
      const result = resolveHook('exit', [], agent);
      assert.equal(result.mode, 'skip');
    });

    it('deserializes JSON pipeline from DB string', () => {
      const agent = makeAgent();
      const jsonValue = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 50, regex: 'session ([a-f0-9]+)', var: 'SID' },
      ]);
      const result = resolveHook('exit', jsonValue, agent);
      assert.equal(result.mode, 'pipeline');
      const pipeline = (result as { steps: Array<{ type: string }> }).steps;
      assert.equal(pipeline.length, 2);
      assert.equal(pipeline[1]!.type, 'capture');
    });
  });

  describe('JSON-serialized structured hooks (from DB)', () => {
    it('deserializes JSON preset hook from string', () => {
      const agent = makeAgent({ engine: 'codex' });
      const jsonValue = JSON.stringify({ preset: 'claude' });
      const result = resolveHook('exit', jsonValue, agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/exit');
    });

    it('deserializes JSON shell hook from string', () => {
      const agent = makeAgent({ name: 'db-agent' });
      const jsonValue = JSON.stringify({ shell: './run.sh' });
      const result = resolveHook('start', jsonValue, agent);
      assert.equal(result.mode, 'paste');
      const text = (result as { text: string }).text;
      assert.ok(!text.includes('COLLAB_AGENT='), 'deserialized shell hook should not inject COLLAB_AGENT');
      assert.equal(text, './run.sh');
    });

    it('deserializes JSON send hook from string', () => {
      const agent = makeAgent();
      const jsonValue = JSON.stringify({ send: [{ keystroke: 'Escape' }] });
      const result = resolveHook('exit', jsonValue, agent);
      assert.equal(result.mode, 'send');
    });
  });

  describe('resolveAgentHook convenience', () => {
    it('reads hookStart from agent record', () => {
      const agent = makeAgent({ hookStart: 'my-start-cmd' });
      const result = resolveAgentHook('start', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, 'my-start-cmd');
    });

    it('reads hookExit from agent record', () => {
      const agent = makeAgent({ hookExit: '/bye' });
      const result = resolveAgentHook('exit', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/bye');
    });

    it('falls back to preset when hook is null', () => {
      const agent = makeAgent();
      const result = resolveAgentHook('exit', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, '/exit');
    });

    it('reads hookInterrupt from agent record', () => {
      const agent = makeAgent({ hookInterrupt: 'Escape' });
      const result = resolveAgentHook('interrupt', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, 'Escape');
    });

    it('reads hookSubmit from agent record', () => {
      const agent = makeAgent({ hookSubmit: 'custom-submit-cmd' });
      const result = resolveAgentHook('submit', agent);
      assert.equal(result.mode, 'paste');
      assert.equal((result as { text: string }).text, 'custom-submit-cmd');
    });
  });

  describe('template variable interpolation', () => {
    it('replaces all known template variables', () => {
      const result = interpolateTemplateVars(
        'claude --session-id $SESSION_ID --append-system-prompt $PERSONA_PROMPT',
        {
          AGENT_NAME: 'sysadmin',
          AGENT_CWD: '/home/user/project',
          SESSION_ID: 'abc-123',
          PERSONA_PROMPT: 'You are a sysadmin',
          PERSONA_PROMPT_FILEPATH: '/tmp/persona.md',
        },
      );
      // PERSONA_PROMPT is shell-quoted
      assert.equal(result, "claude --session-id abc-123 --append-system-prompt 'You are a sysadmin'");
    });

    it('shell-quotes PERSONA_PROMPT with special characters and newlines', () => {
      const multiLinePrompt = "You are a helper.\nDon't break things.\nUse `collab send` for reports.";
      const result = interpolateTemplateVars(
        'claude --append-system-prompt $PERSONA_PROMPT',
        { PERSONA_PROMPT: multiLinePrompt },
      );
      // shellQuote wraps in single quotes, escaping internal single quotes
      assert.equal(result, "claude --append-system-prompt 'You are a helper.\nDon'\\''t break things.\nUse `collab send` for reports.'");
    });

    it('shell-quotes PERSONA_PROMPT_FILEPATH with spaces', () => {
      const result = interpolateTemplateVars(
        'cat $PERSONA_PROMPT_FILEPATH',
        { PERSONA_PROMPT_FILEPATH: '/home/user/my personas/agent.md' },
      );
      assert.equal(result, "cat '/home/user/my personas/agent.md'");
    });

    it('replaces undefined variables with empty string', () => {
      const result = interpolateTemplateVars(
        'claude --resume $SESSION_ID',
        { AGENT_NAME: 'test' },
      );
      assert.equal(result, 'claude --resume ');
    });

    it('returns command unchanged when no vars provided', () => {
      const result = interpolateTemplateVars('claude --help');
      assert.equal(result, 'claude --help');
    });

    it('replaces $AGENT_NAME and $AGENT_CWD', () => {
      const result = interpolateTemplateVars(
        'echo $AGENT_NAME in $AGENT_CWD',
        { AGENT_NAME: 'test-bot', AGENT_CWD: '/workspace' },
      );
      assert.equal(result, 'echo test-bot in /workspace');
    });

    it('does not replace non-template vars like $HOME', () => {
      // $HOME has no match in TemplateVars, so it becomes empty string
      // This is expected — shell hooks should use actual shell env vars via export
      const result = interpolateTemplateVars('echo $HOME $AGENT_NAME', { AGENT_NAME: 'bot' });
      assert.equal(result, 'echo  bot');
    });
  });

  describe('shell hook with template vars', () => {
    it('interpolates template vars in shell hook command', () => {
      const agent = makeAgent({ name: 'my-agent' });
      const result = resolveHook('start', { shell: 'claude --session-id $SESSION_ID' }, agent, {
        templateVars: { SESSION_ID: 'uuid-123', AGENT_NAME: 'my-agent' },
      });
      assert.equal(result.mode, 'paste');
      const text = (result as { text: string }).text;
      assert.ok(text.includes('claude --session-id uuid-123'), `Expected interpolated command, got: ${text}`);
      assert.ok(!text.includes('COLLAB_AGENT='), 'ShellHook should not inject COLLAB_AGENT (lifecycle handles it)');
    });

    it('shell hook without templateVars passes command through unchanged', () => {
      const agent = makeAgent({ name: 'my-agent' });
      const result = resolveHook('start', { shell: 'claude --session-id $SESSION_ID' }, agent);
      assert.equal(result.mode, 'paste');
      const text = (result as { text: string }).text;
      assert.ok(text.includes('$SESSION_ID'), `Expected uninterpolated var, got: ${text}`);
    });

    it('shell-quotes $PERSONA_PROMPT in shell hook to prevent tmux paste breakage', () => {
      const agent = makeAgent({ name: 'hoa-helper' });
      const prompt = "You are my HOA helper.\nUse gsuite skills.\nDon't break things.";
      const result = resolveHook('resume', { shell: 'claude --resume $AGENT_NAME --append-system-prompt $PERSONA_PROMPT' }, agent, {
        templateVars: { AGENT_NAME: 'hoa-helper', PERSONA_PROMPT: prompt },
      });
      assert.equal(result.mode, 'paste');
      const text = (result as { text: string }).text;
      // The command should contain the agent name unquoted and the prompt shell-quoted
      assert.ok(text.includes('--resume hoa-helper'), `Expected unquoted agent name, got: ${text}`);
      assert.ok(text.includes("--append-system-prompt '"), `Expected shell-quoted prompt, got: ${text}`);
      // The quoted prompt should be a single argument — no unquoted newlines breaking the command
      assert.ok(!text.includes('--append-system-prompt You'), `Prompt should be quoted, not raw, got: ${text}`);
    });
  });

  describe('captured vars in template interpolation', () => {
    it('interpolates captured vars as fallback', () => {
      const result = interpolateTemplateVars(
        'codex resume $SESSION_ID',
        { AGENT_NAME: 'test', capturedVars: { SESSION_ID: 'abc-123' } },
      );
      assert.equal(result, 'codex resume abc-123');
    });

    it('built-in vars take precedence over captured vars', () => {
      const result = interpolateTemplateVars(
        'resume $SESSION_ID',
        { SESSION_ID: 'builtin-id', capturedVars: { SESSION_ID: 'captured-id' } },
      );
      assert.equal(result, 'resume builtin-id');
    });

    it('captured vars work in pipeline shell steps', () => {
      const agent = makeAgent();
      const pipeline = [
        { type: 'shell' as const, command: 'codex resume $SESSION_ID' },
      ];
      const result = resolveHook('resume', pipeline, agent, {
        templateVars: { capturedVars: { SESSION_ID: 'sess-456' } },
      });
      assert.equal(result.mode, 'pipeline');
      const steps = (result as { steps: Array<{ type: string; command: string }> }).steps;
      assert.equal(steps[0]!.command, 'codex resume sess-456');
    });

    it('returns empty string for unknown vars not in captured vars', () => {
      const result = interpolateTemplateVars(
        'echo $UNKNOWN_VAR',
        { AGENT_NAME: 'test', capturedVars: {} },
      );
      assert.equal(result, 'echo ');
    });
  });
});
