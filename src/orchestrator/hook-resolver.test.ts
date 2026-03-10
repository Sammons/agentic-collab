import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveHook, resolveAgentHook } from './hook-resolver.ts';
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
});
