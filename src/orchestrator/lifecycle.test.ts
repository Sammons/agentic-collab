import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { shellQuote } from '../shared/utils.ts';
import {
  spawnAgent, resumeAgent, suspendAgent, destroyAgent,
  reloadAgent, interruptAgent, compactAgent, killAgent, startWatchdog,
  executeCustomButton, type LifecycleContext,
} from './lifecycle.ts';

describe('Lifecycle', () => {
  let db: Database;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];
  let ctx: LifecycleContext;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
    db = new Database(join(tmpDir, 'test.db'));
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    proxyCommands = [];
    ctx = {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'has_session') {
          return { ok: true, data: true };
        }
        if (command.action === 'capture') {
          return { ok: true, data: '> \n' };
        }
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
    };
  });

  describe('spawnAgent', () => {
    it('spawns a void agent through to active state', async () => {
      db.createAgent({ name: 'spawn-test', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      db.registerProxy('p1', 'tok', 'localhost:3100');

      const result = await spawnAgent(ctx, {
        name: 'spawn-test',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      assert.equal(result.state, 'active');
      assert.equal(result.spawnCount, 1);
      assert.ok(proxyCommands.some(c => c.action === 'create_session'));
      assert.ok(proxyCommands.some(c => c.action === 'paste'));
    });

    it('rejects spawning active agent', async () => {
      await assert.rejects(
        spawnAgent(ctx, {
          name: 'spawn-test',
          engine: 'claude',
          cwd: '/tmp',
          proxyId: 'p1',
        }),
        /expected void or failed/,
      );
    });

    it('rejects agent with no proxy', async () => {
      db.createAgent({ name: 'no-proxy-spawn', engine: 'claude', cwd: '/tmp' });
      await assert.rejects(
        spawnAgent(ctx, {
          name: 'no-proxy-spawn',
          engine: 'claude',
          cwd: '/tmp',
          proxyId: '',
        }),
        /no proxy/,
      );
    });

    it('marks agent failed on tmux creation failure', async () => {
      db.createAgent({ name: 'fail-spawn', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const failCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async () => ({ ok: false, error: 'tmux error' }),
      };

      await assert.rejects(spawnAgent(failCtx, {
        name: 'fail-spawn',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      }), /Spawn failed/);

      const agent = db.getAgent('fail-spawn');
      assert.equal(agent?.state, 'failed');
    });
  });

  describe('spawnAgent — paste command verification', () => {
    it('claude spawn includes --model, --effort, and -p flags', async () => {
      db.createAgent({ name: 'cmd-claude', engine: 'claude', cwd: '/tmp', proxyId: 'p1', permissions: 'skip' });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'cmd-claude',
        engine: 'claude',
        model: 'opus',
        thinking: 'high',
        task: 'fix the bug',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('claude'), 'should start with claude');
      assert.ok(paste.text.includes('--model opus'), 'should include --model');
      assert.ok(paste.text.includes('--effort high'), 'should include --effort');
      assert.ok(paste.text.includes('fix the bug'), 'should include task');
      assert.ok(paste.text.includes('--dangerously-skip-permissions'), 'should include skip-permissions');
    });

    it('codex spawn includes --model and positional task', async () => {
      db.createAgent({ name: 'cmd-codex', engine: 'codex', cwd: '/tmp', proxyId: 'p1', permissions: 'skip' });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'cmd-codex',
        engine: 'codex',
        model: 'o3',
        task: 'refactor auth',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('codex'), 'should start with codex');
      assert.ok(paste.text.includes('--model o3'), 'should include --model');
      assert.ok(paste.text.includes('refactor auth'), 'should include task');
      assert.ok(paste.text.includes('--dangerously-bypass-approvals-and-sandbox'), 'should include bypass flag');
      assert.ok(paste.text.includes('--no-alt-screen'), 'should include --no-alt-screen');
    });

    it('opencode spawn launches TUI with -m flag (no run subcommand)', async () => {
      db.createAgent({ name: 'cmd-opencode', engine: 'opencode', cwd: '/tmp', proxyId: 'p1' });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'cmd-opencode',
        engine: 'opencode',
        model: 'claude-3.5',
        thinking: 'high',
        task: 'write tests',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      // TUI mode: spawn command is `opencode -m <model> --variant <thinking>`
      // Task is NOT in the spawn command — it's delivered separately via paste
      assert.ok(paste.text.includes('opencode'), 'should include opencode');
      assert.ok(!paste.text.includes('opencode run'), 'should NOT use run subcommand (TUI mode)');
      assert.ok(paste.text.includes('-m claude-3.5'), 'should include -m flag');
      assert.ok(paste.text.includes('--variant high'), 'should include --variant for thinking');
    });

    it('claude spawn omits optional flags when not provided', async () => {
      db.createAgent({ name: 'cmd-minimal', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'cmd-minimal',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(!paste.text.includes('--model'), 'should not include --model');
      assert.ok(!paste.text.includes('--effort'), 'should not include --effort');
      // System prompt is always present (--append-system-prompt), but task flag (-p 'xxx') should not
      assert.ok(paste.text.includes('--append-system-prompt'), 'should include system prompt');
      assert.ok(!paste.text.includes('--dangerously-skip-permissions'), 'should not include skip-permissions without permissions=skip');
      assert.ok(paste.text.startsWith("export COLLAB_AGENT='cmd-minimal' COLLAB_PERSONA_FILE='"), 'should have quoted launch env prefix');
      assert.ok(paste.text.includes("COLLAB_PERSONA_FILE='"), 'should export COLLAB_PERSONA_FILE during launch');
      assert.ok(paste.text.includes(' && claude'), 'should prefix the claude command with exports');
    });

    it('injects launchEnv with shell-quoted values during spawn', async () => {
      db.createAgent({
        name: 'cmd-env-spawn',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        launchEnv: {
          GIT_AUTHOR_NAME: "O'Brian",
          GIT_CONFIG_GLOBAL: '$PWD/agent config.gitconfig',
          COLLAB_AGENT: 'should-not-win',
          COLLAB_PERSONA_FILE: '/tmp/should-not-win.md',
        },
      });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'cmd-env-spawn',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes(`COLLAB_AGENT=${shellQuote('cmd-env-spawn')}`), 'base COLLAB_AGENT should win');
      assert.ok(!paste.text.includes(`COLLAB_AGENT=${shellQuote('should-not-win')}`), 'launchEnv must not override base COLLAB_AGENT');
      assert.ok(!paste.text.includes(shellQuote('/tmp/should-not-win.md')), 'launchEnv must not override base COLLAB_PERSONA_FILE');
      assert.ok(paste.text.includes(`GIT_AUTHOR_NAME=${shellQuote("O'Brian")}`), 'should shell-quote single quotes');
      assert.ok(paste.text.includes(`GIT_CONFIG_GLOBAL=${shellQuote('$PWD/agent config.gitconfig')}`), 'should shell-quote launch env values');
    });
  });

  describe('suspendAgent', () => {
    it('suspends an active agent', async () => {
      db.createAgent({ name: 'suspend-test', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('suspend-test')!;
      db.updateAgentState('suspend-test', 'active', a.version, {
        tmuxSession: 'agent-suspend-test',
        proxyId: 'p1',
      });

      const result = await suspendAgent(ctx, 'suspend-test');
      assert.equal(result.state, 'suspended');
      assert.ok(proxyCommands.some(c => c.action === 'paste'));
    });

    it('rejects suspending void agent', async () => {
      db.createAgent({ name: 'void-suspend', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      await assert.rejects(
        suspendAgent(ctx, 'void-suspend'),
        /expected active or idle/,
      );
    });
  });

  describe('resumeAgent', () => {
    it('resumes a suspended agent', async () => {
      const a = db.getAgent('suspend-test')!;
      assert.equal(a.state, 'suspended');

      const result = await resumeAgent(ctx, 'suspend-test');
      assert.equal(result.state, 'active');
      assert.ok(proxyCommands.some(c => c.action === 'create_session'));
      assert.ok(proxyCommands.some(c => c.action === 'paste'));
    });

    it('injects launchEnv with shell-quoted values during resume', async () => {
      db.createAgent({
        name: 'resume-env',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        launchEnv: {
          GIT_AUTHOR_EMAIL: 'resume agent@example.com',
        },
      });
      const created = db.getAgent('resume-env')!;
      db.updateAgentState('resume-env', 'suspended', created.version, {
        tmuxSession: 'agent-resume-env',
        proxyId: 'p1',
        currentSessionId: 'resume-session-123',
      });

      proxyCommands = [];
      await resumeAgent(ctx, 'resume-env');

      const paste = proxyCommands.find((c) => c.action === 'paste' && c.text.includes('--resume')) as Extract<ProxyCommand, { action: 'paste' }> | undefined;
      assert.ok(paste, 'should have resume paste command');
      assert.ok(paste.text.includes(`COLLAB_AGENT=${shellQuote('resume-env')}`), 'should include base COLLAB_AGENT');
      assert.ok(paste.text.includes("COLLAB_PERSONA_FILE='"), 'should include COLLAB_PERSONA_FILE during resume');
      assert.ok(paste.text.includes(`GIT_AUTHOR_EMAIL=${shellQuote('resume agent@example.com')}`), 'should shell-quote launch env during resume');
    });

    it('marks agent failed when create_session returns ok:false', async () => {
      db.createAgent({ name: 'resume-fail-session', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('resume-fail-session')!;
      db.updateAgentState('resume-fail-session', 'suspended', a.version, {
        tmuxSession: 'agent-resume-fail-session',
        proxyId: 'p1',
        currentSessionId: 'some-session',
      });

      const failCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async () => ({ ok: false, error: 'session exists' }),
      };

      await assert.rejects(
        resumeAgent(failCtx, 'resume-fail-session'),
        /Resume failed/,
      );

      const agent = db.getAgent('resume-fail-session');
      assert.equal(agent?.state, 'failed');
      assert.ok(agent?.failureReason?.includes('Failed to create tmux session'));
    });
  });

  describe('destroyAgent', () => {
    it('destroys an agent and removes from registry', async () => {
      db.createAgent({ name: 'destroy-test', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('destroy-test')!;
      db.updateAgentState('destroy-test', 'active', a.version, {
        tmuxSession: 'agent-destroy-test',
        proxyId: 'p1',
      });

      await destroyAgent(ctx, 'destroy-test');
      assert.equal(db.getAgent('destroy-test'), undefined);
      assert.ok(proxyCommands.some(c => c.action === 'kill_session'));
    });

    it('throws for unknown agent', async () => {
      await assert.rejects(
        destroyAgent(ctx, 'nonexistent'),
        /not found/,
      );
    });

    it('deletes persona file on destroy', async () => {
      const personasDir = mkdtempSync(join(tmpdir(), 'personas-destroy-'));
      const origDir = process.env['PERSONAS_DIR'];
      process.env['PERSONAS_DIR'] = personasDir;

      try {
        // Create a persona file
        const personaFile = join(personasDir, 'destroy-persona.md');
        writeFileSync(personaFile, '---\nengine: claude\ncwd: /tmp\n---\nTest persona\n');
        assert.ok(existsSync(personaFile), 'persona file should exist before destroy');

        // Create agent with matching persona name
        db.createAgent({ name: 'destroy-persona', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });

        await destroyAgent(ctx, 'destroy-persona');

        assert.equal(db.getAgent('destroy-persona'), undefined, 'agent should be deleted from DB');
        assert.ok(!existsSync(personaFile), 'persona file should be deleted on destroy');
      } finally {
        process.env['PERSONAS_DIR'] = origDir;
        rmSync(personasDir, { recursive: true, force: true });
      }
    });

    it('destroys agent even if no persona file exists', async () => {
      const personasDir = mkdtempSync(join(tmpdir(), 'personas-nopersona-'));
      const origDir = process.env['PERSONAS_DIR'];
      process.env['PERSONAS_DIR'] = personasDir;

      try {
        db.createAgent({ name: 'destroy-nofile', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
        // No persona file — should still destroy without error
        await destroyAgent(ctx, 'destroy-nofile');
        assert.equal(db.getAgent('destroy-nofile'), undefined, 'agent should be deleted from DB');
      } finally {
        process.env['PERSONAS_DIR'] = origDir;
        rmSync(personasDir, { recursive: true, force: true });
      }
    });
  });

  describe('reloadAgent', () => {
    it('queues reload when not immediate', async () => {
      db.createAgent({ name: 'reload-queue', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('reload-queue')!;
      db.updateAgentState('reload-queue', 'active', a.version, {
        tmuxSession: 'agent-reload-queue',
        proxyId: 'p1',
      });

      const result = await reloadAgent(ctx, 'reload-queue', { task: 'check PR' });
      assert.equal(result.reloadQueued, 1);
      assert.equal(result.reloadTask, 'check PR');
    });

    it('executes immediate reload on active agent', async () => {
      db.createAgent({ name: 'reload-imm', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('reload-imm')!;
      db.updateAgentState('reload-imm', 'active', a.version, {
        tmuxSession: 'agent-reload-imm',
        proxyId: 'p1',
      });

      const result = await reloadAgent(ctx, 'reload-imm', { immediate: true });
      assert.equal(result.state, 'active');
      assert.equal(result.reloadQueued, 0);
      assert.ok(result.spawnCount > 0);
      assert.ok(proxyCommands.some(c => c.action === 'kill_session'));
      assert.ok(proxyCommands.some(c => c.action === 'create_session'));
    });
  });

  describe('interruptAgent', () => {
    it('sends interrupt keys', async () => {
      db.createAgent({ name: 'int-test', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('int-test')!;
      db.updateAgentState('int-test', 'active', a.version, {
        tmuxSession: 'agent-int-test',
        proxyId: 'p1',
      });

      await interruptAgent(ctx, 'int-test');
      const sendKeyCmds = proxyCommands.filter(c => c.action === 'send_keys');
      assert.ok(sendKeyCmds.length >= 2); // Claude sends 3 escapes
    });
  });

  describe('compactAgent', () => {
    it('sends compact command', async () => {
      db.createAgent({ name: 'compact-test', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('compact-test')!;
      db.updateAgentState('compact-test', 'active', a.version, {
        tmuxSession: 'agent-compact-test',
        proxyId: 'p1',
      });

      await compactAgent(ctx, 'compact-test');
      assert.ok(proxyCommands.some(c => c.action === 'paste'));
    });

    it('skips compaction for engines that do not support it', async () => {
      db.createAgent({ name: 'compact-codex', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('compact-codex')!;
      db.updateAgentState('compact-codex', 'active', a.version, {
        tmuxSession: 'agent-compact-codex',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await compactAgent(ctx, 'compact-codex');
      assert.ok(!proxyCommands.some(c => c.action === 'paste'), 'should not paste when engine has no compact');
      const events = db.getEvents('compact-codex', 5);
      assert.ok(events.some((e: { event: string }) => e.event === 'compact_skipped'), 'should log compact_skipped event');
    });
  });

  describe('killAgent', () => {
    it('kills an active agent', async () => {
      db.createAgent({ name: 'kill-active', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('kill-active')!;
      db.updateAgentState('kill-active', 'active', a.version, {
        tmuxSession: 'agent-kill-active',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await killAgent(ctx, 'kill-active');

      const agent = db.getAgent('kill-active');
      assert.equal(agent?.state, 'suspended');
      assert.ok(proxyCommands.some(c => c.action === 'kill_session'));
    });

    it('kills an agent in spawning state', async () => {
      db.createAgent({ name: 'kill-spawning', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('kill-spawning')!;
      db.updateAgentState('kill-spawning', 'spawning', a.version, {
        tmuxSession: 'agent-kill-spawning',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await killAgent(ctx, 'kill-spawning');

      const agent = db.getAgent('kill-spawning');
      assert.equal(agent?.state, 'suspended');
    });

    it('kills an agent in suspending state', async () => {
      db.createAgent({ name: 'kill-suspending', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('kill-suspending')!;
      db.updateAgentState('kill-suspending', 'suspending', a.version, {
        tmuxSession: 'agent-kill-suspending',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await killAgent(ctx, 'kill-suspending');

      const agent = db.getAgent('kill-suspending');
      assert.equal(agent?.state, 'suspended');
    });

    it('kills an agent in resuming state', async () => {
      db.createAgent({ name: 'kill-resuming', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('kill-resuming')!;
      db.updateAgentState('kill-resuming', 'resuming', a.version, {
        tmuxSession: 'agent-kill-resuming',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await killAgent(ctx, 'kill-resuming');

      const agent = db.getAgent('kill-resuming');
      assert.equal(agent?.state, 'suspended');
    });
  });

  describe('spawnAgent — interrupted by kill', () => {
    it('returns current state if killed during spawn phase 2', async () => {
      db.createAgent({ name: 'spawn-kill', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      let callCount = 0;
      const slowCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          callCount++;
          // After create_session, simulate kill by changing state
          if (command.action === 'create_session') {
            const agent = db.getAgent('spawn-kill')!;
            if (agent.state === 'spawning') {
              db.updateAgentState('spawn-kill', 'suspended', agent.version, {
                tmuxSession: null,
              });
            }
          }
          return { ok: true };
        },
      };

      const result = await spawnAgent(slowCtx, {
        name: 'spawn-kill',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      // Phase 3 should detect state changed and return current state
      assert.equal(result.state, 'suspended');
    });
  });

  describe('startWatchdog', () => {
    it('marks agent failed if still in intermediate state after timeout', async () => {
      db.createAgent({ name: 'wd-stuck', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('wd-stuck')!;
      db.updateAgentState('wd-stuck', 'spawning', a.version, {
        tmuxSession: 'agent-wd-stuck',
        proxyId: 'p1',
      });

      // Use a very short timeout (50ms)
      const timer = startWatchdog(ctx, 'wd-stuck', 'spawning', 50, 'p1', 'agent-wd-stuck');

      // Wait for watchdog to fire
      await new Promise<void>((r) => setTimeout(r, 200));
      clearTimeout(timer);

      const agent = db.getAgent('wd-stuck');
      assert.equal(agent?.state, 'failed');
      assert.ok(agent?.failureReason?.includes('spawning timeout'));
    });

    it('does not mark agent failed if state already changed', async () => {
      db.createAgent({ name: 'wd-ok', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('wd-ok')!;
      db.updateAgentState('wd-ok', 'spawning', a.version, {
        tmuxSession: 'agent-wd-ok',
        proxyId: 'p1',
      });

      // Transition to active before watchdog fires
      const b = db.getAgent('wd-ok')!;
      db.updateAgentState('wd-ok', 'active', b.version, {});

      const timer = startWatchdog(ctx, 'wd-ok', 'spawning', 50, 'p1', 'agent-wd-ok');

      await new Promise<void>((r) => setTimeout(r, 200));
      clearTimeout(timer);

      const agent = db.getAgent('wd-ok');
      assert.equal(agent?.state, 'active'); // watchdog didn't touch it
    });

    it('attempts to kill tmux session on timeout', async () => {
      db.createAgent({ name: 'wd-kill', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('wd-kill')!;
      db.updateAgentState('wd-kill', 'suspending', a.version, {
        tmuxSession: 'agent-wd-kill',
        proxyId: 'p1',
      });

      proxyCommands = [];
      const timer = startWatchdog(ctx, 'wd-kill', 'suspending', 50, 'p1', 'agent-wd-kill');

      await new Promise<void>((r) => setTimeout(r, 200));
      clearTimeout(timer);

      assert.ok(proxyCommands.some(c => c.action === 'kill_session'));
    });
  });

  describe('frontmatter hooks', () => {
    it('spawnAgent uses hookStart instead of adapter command', async () => {
      db.createAgent({ name: 'hook-spawn', engine: 'claude', cwd: '/tmp', proxyId: 'p1', hookStart: 'my-custom-spawn-cmd --flag' });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'hook-spawn',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('my-custom-spawn-cmd --flag'), 'should use hookStart');
      // Verify the command portion (after &&) uses the hook, not the adapter default.
      // We can't assert !includes('claude') because COLLAB_PERSONA_FILE path may contain it.
      const cmdPart = paste.text.split('&&').pop()!.trim();
      assert.ok(!cmdPart.startsWith('claude '), 'command should not be the claude adapter default');
      assert.ok(paste.text.includes(`COLLAB_AGENT=${shellQuote('hook-spawn')}`), 'should have quoted COLLAB_AGENT');
      assert.ok(paste.text.includes('COLLAB_PERSONA_FILE='), 'should export COLLAB_PERSONA_FILE');
    });

    it('spawnAgent keeps top-level launch env separate from shell-hook env', async () => {
      db.createAgent({
        name: 'hook-spawn-shell-env',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        launchEnv: {
          GIT_CONFIG_GLOBAL: './agent-shell.gitconfig',
          COLLAB_PERSONA_FILE: '/tmp/bad-persona.md',
        },
        hookStart: JSON.stringify({
          shell: './run.sh',
          env: {
            MY_VAR: 'hello',
          },
        }),
      });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'hook-spawn-shell-env',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes(`GIT_CONFIG_GLOBAL=${shellQuote('./agent-shell.gitconfig')}`), 'should inject top-level launch env');
      assert.ok(paste.text.includes("MY_VAR='hello'"), 'should preserve hook-local shell env (shell-quoted)');
      assert.ok(!paste.text.includes('/tmp/bad-persona.md'), 'reserved COLLAB_PERSONA_FILE should not be overridden');
      assert.ok(paste.text.includes('./run.sh'), 'should still execute the shell hook command');
    });

    it('spawnAgent falls back to adapter when hookStart is null', async () => {
      db.createAgent({ name: 'hook-spawn-null', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      proxyCommands = [];

      await spawnAgent(ctx, {
        name: 'hook-spawn-null',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('claude'), 'should use adapter command');
      assert.ok(paste.text.includes('COLLAB_PERSONA_FILE='), 'should export COLLAB_PERSONA_FILE during launch');
    });

    it('resumeAgent uses hookResume for existing session', async () => {
      db.createAgent({ name: 'hook-resume', engine: 'claude', cwd: '/tmp', proxyId: 'p1', hookResume: 'my-resume-cmd --session' });
      const a = db.getAgent('hook-resume')!;
      db.updateAgentState('hook-resume', 'active', a.version, {
        tmuxSession: 'agent-hook-resume',
        proxyId: 'p1',
        currentSessionId: 'test-session-123',
      });
      // Suspend it first
      const b = db.getAgent('hook-resume')!;
      db.updateAgentState('hook-resume', 'suspended', b.version, {});

      proxyCommands = [];
      await resumeAgent(ctx, 'hook-resume');

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('my-resume-cmd --session'), 'should use hookResume');
      assert.ok(!paste.text.includes('--resume'), 'should not contain adapter resume flag');
      assert.ok(paste.text.includes('COLLAB_PERSONA_FILE='), 'should export COLLAB_PERSONA_FILE');
    });

    it('resumeAgent uses hookStart when no session exists', async () => {
      db.createAgent({ name: 'hook-resume-nosess', engine: 'claude', cwd: '/tmp', proxyId: 'p1', hookStart: 'my-spawn-for-resume', hookResume: 'my-resume-cmd' });
      const a = db.getAgent('hook-resume-nosess')!;
      db.updateAgentState('hook-resume-nosess', 'suspended', a.version, {
        tmuxSession: 'agent-hook-resume-nosess',
        proxyId: 'p1',
        currentSessionId: null,
      });

      proxyCommands = [];
      await resumeAgent(ctx, 'hook-resume-nosess');

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('my-spawn-for-resume'), 'should use hookStart when no session');
      assert.ok(!paste.text.includes('my-resume-cmd'), 'should not use hookResume');
    });

    it('compactAgent uses hookCompact instead of adapter', async () => {
      db.createAgent({
        name: 'hook-compact',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookCompact: 'my-compact-cmd',
        launchEnv: {
          GIT_CONFIG_GLOBAL: './should-not-appear.gitconfig',
        },
      });
      const a = db.getAgent('hook-compact')!;
      db.updateAgentState('hook-compact', 'active', a.version, {
        tmuxSession: 'agent-hook-compact',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await compactAgent(ctx, 'hook-compact');

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should have paste command');
      assert.ok(paste.text.includes('my-compact-cmd'), 'should use hookCompact');
      // Compact is not a launch hook — no env wrapping
      assert.ok(!paste.text.includes('COLLAB_AGENT='), 'compact should not have env wrapping');
      assert.ok(!paste.text.includes('GIT_CONFIG_GLOBAL='), 'top-level launch env should not apply to compact hooks');
    });

    it('compactAgent falls back to adapter compactKeys when hookCompact is null', async () => {
      db.createAgent({ name: 'hook-compact-null', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('hook-compact-null')!;
      db.updateAgentState('hook-compact-null', 'active', a.version, {
        tmuxSession: 'agent-hook-compact-null',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await compactAgent(ctx, 'hook-compact-null');

      // Claude adapter uses compactKeys (paste /compact), not hookCompact
      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should fall back to adapter compact');
      assert.ok(!paste.text.includes('COLLAB_PERSONA_FILE='), 'should not export COLLAB_PERSONA_FILE');
    });
  });

  describe('pipeline hooks', () => {
    it('dispatches pipeline steps in order during exit', async () => {
      const pipelineHook = JSON.stringify([
        { type: 'keystrokes', actions: [{ keystroke: 'Escape' }] },
        { type: 'shell', command: '/exit' },
        { type: 'keystrokes', actions: [{ keystroke: 'Enter' }] },
      ]);
      db.createAgent({
        name: 'pipeline-exit',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: pipelineHook,
      });
      const a = db.getAgent('pipeline-exit')!;
      db.updateAgentState('pipeline-exit', 'active', a.version, {
        tmuxSession: 'agent-pipeline-exit',
        proxyId: 'p1',
      });
      proxyCommands = [];

      await suspendAgent(ctx, 'pipeline-exit');

      // Should have: send_keys(Escape), paste(/exit), send_keys(Enter), then kill_session
      const sendKeys = proxyCommands.filter(c => c.action === 'send_keys');
      const pastes = proxyCommands.filter(c => c.action === 'paste');
      assert.ok(sendKeys.length >= 2, `expected at least 2 send_keys, got ${sendKeys.length}`);
      assert.ok(pastes.length >= 1, `expected at least 1 paste, got ${pastes.length}`);
      const exitPaste = pastes.find(c => 'text' in c && (c as { text: string }).text === '/exit');
      assert.ok(exitPaste, 'should have pasted /exit');
    });
  });

  describe('pipeline env injection', () => {
    it('injects COLLAB_AGENT into first shell step of pipeline start', async () => {
      const startPipeline = JSON.stringify([
        { type: 'shell', command: 'claude --model opus' },
        { type: 'keystroke', key: 'Escape' },
      ]);
      db.createAgent({
        name: 'env-inject-pipeline',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookStart: startPipeline,
      });

      proxyCommands = [];
      const result = await spawnAgent(ctx, {
        name: 'env-inject-pipeline',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      assert.equal(result.state, 'active');
      const paste = proxyCommands.find(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text.includes('claude --model opus')) as Extract<ProxyCommand, { action: 'paste' }> | undefined;
      assert.ok(paste, 'should have paste command with claude launch');
      assert.ok(paste!.text.includes(`COLLAB_AGENT=${shellQuote('env-inject-pipeline')}`), 'should include COLLAB_AGENT');
      assert.ok(paste!.text.includes('COLLAB_PERSONA_FILE='), 'should include COLLAB_PERSONA_FILE');
      // Should also have keystroke Escape
      assert.ok(proxyCommands.some(c => c.action === 'send_keys' && 'keys' in c && (c as { keys: string }).keys === 'Escape'));
    });
  });

  describe('wait pipeline step', () => {
    it('pauses execution between pipeline steps', async () => {
      const pipelineHook = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'wait', ms: 100 },
        { type: 'keystrokes', actions: [{ keystroke: 'Enter' }] },
      ]);
      db.createAgent({
        name: 'wait-step-agent',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: pipelineHook,
      });
      const a = db.getAgent('wait-step-agent')!;
      db.updateAgentState('wait-step-agent', 'active', a.version, {
        tmuxSession: 'agent-wait-step-agent',
        proxyId: 'p1',
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'has_session') return { ok: true, data: false };
          return { ok: true };
        },
      };

      proxyCommands = [];
      const start = Date.now();
      await suspendAgent(captureCtx, 'wait-step-agent');
      const elapsed = Date.now() - start;

      // Should have waited at least 100ms (the wait step)
      assert.ok(elapsed >= 90, `expected >= 90ms elapsed, got ${elapsed}ms`);
      // Verify steps executed: paste /exit, then send_keys Enter
      assert.ok(proxyCommands.some(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text === '/exit'));
      assert.ok(proxyCommands.some(c => c.action === 'send_keys' && 'keys' in c && (c as { keys: string }).keys === 'Enter'));
    });
  });

  describe('session capture via exit pipeline', () => {
    it('captures session ID via capture step in exit pipeline on suspend', async () => {
      const exitPipeline = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 50, regex: 'codex resume ([0-9a-f-]+)', var: 'SESSION_ID' },
      ]);
      db.createAgent({
        name: 'capture-exit-suspend',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: exitPipeline,
      });
      const a = db.getAgent('capture-exit-suspend')!;
      db.updateAgentState('capture-exit-suspend', 'active', a.version, {
        tmuxSession: 'agent-capture-exit-suspend',
        proxyId: 'p1',
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'Session saved.\ncodex resume 019ce018-ff0a-7ba0-9537-e4eb16a75970\n$' };
          }
          if (command.action === 'has_session') {
            return { ok: true, data: false };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await suspendAgent(captureCtx, 'capture-exit-suspend');

      assert.equal(result.state, 'suspended');
      const agent = db.getAgent('capture-exit-suspend')!;
      assert.ok(agent.capturedVars, 'capturedVars should be set');
      assert.equal(agent.capturedVars!['SESSION_ID'], '019ce018-ff0a-7ba0-9537-e4eb16a75970');
      assert.equal(agent.currentSessionId, '019ce018-ff0a-7ba0-9537-e4eb16a75970');
    });

    it('supports uuid shorthand in capture regex', async () => {
      const exitPipeline = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 50, regex: 'uuid', var: 'SESSION_ID' },
      ]);
      db.createAgent({
        name: 'capture-uuid-shorthand',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: exitPipeline,
      });
      const a = db.getAgent('capture-uuid-shorthand')!;
      db.updateAgentState('capture-uuid-shorthand', 'active', a.version, {
        tmuxSession: 'agent-capture-uuid-shorthand',
        proxyId: 'p1',
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'Session: a1b2c3d4-e5f6-7890-abcd-ef1234567890\nModel: opus\n' };
          }
          if (command.action === 'has_session') return { ok: true, data: false };
          return { ok: true };
        },
      };

      proxyCommands = [];
      await suspendAgent(captureCtx, 'capture-uuid-shorthand');

      const agent = db.getAgent('capture-uuid-shorthand')!;
      assert.equal(agent.capturedVars!['SESSION_ID'], 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('captures session ID via exit pipeline on reload', async () => {
      const exitPipeline = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 50, regex: 'codex resume ([0-9a-f-]+)', var: 'SESSION_ID' },
      ]);
      db.createAgent({
        name: 'capture-exit-reload',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: exitPipeline,
      });
      const a = db.getAgent('capture-exit-reload')!;
      db.updateAgentState('capture-exit-reload', 'active', a.version, {
        tmuxSession: 'agent-capture-exit-reload',
        proxyId: 'p1',
        currentSessionId: null,
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'codex resume abc-def-123\n$' };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await reloadAgent(captureCtx, 'capture-exit-reload', { immediate: true });

      assert.equal(result.state, 'active');
      const agent = db.getAgent('capture-exit-reload')!;
      assert.equal(agent.capturedVars!['SESSION_ID'], 'abc-def-123');
    });

    it('injects launchEnv with shell-quoted values during reload', async () => {
      db.createAgent({
        name: 'reload-env',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        launchEnv: {
          GIT_COMMITTER_NAME: 'Reload Agent',
        },
      });
      const a = db.getAgent('reload-env')!;
      db.updateAgentState('reload-env', 'active', a.version, {
        tmuxSession: 'agent-reload-env',
        proxyId: 'p1',
        currentSessionId: 'reload-session-123',
      });

      proxyCommands = [];
      const result = await reloadAgent(ctx, 'reload-env', { immediate: true });

      assert.equal(result.state, 'active');
      const paste = proxyCommands.find((c) => c.action === 'paste' && c.text.includes('--resume')) as Extract<ProxyCommand, { action: 'paste' }> | undefined;
      assert.ok(paste, 'should have reload resume paste command');
      assert.ok(paste.text.includes(`COLLAB_AGENT=${shellQuote('reload-env')}`), 'should include base COLLAB_AGENT');
      assert.ok(paste.text.includes("COLLAB_PERSONA_FILE='"), 'should include COLLAB_PERSONA_FILE during reload');
      assert.ok(paste.text.includes(`GIT_COMMITTER_NAME=${shellQuote('Reload Agent')}`), 'should shell-quote launch env during reload');
    });
  });

  describe('pipeline capture steps', () => {
    it('captures variable from pane output and stores in DB', async () => {
      const pipelineHook = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 50, regex: 'codex resume ([0-9a-f-]+)', var: 'SESSION_ID' },
      ]);
      db.createAgent({
        name: 'capture-pipeline',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: pipelineHook,
      });
      const a = db.getAgent('capture-pipeline')!;
      db.updateAgentState('capture-pipeline', 'active', a.version, {
        tmuxSession: 'agent-capture-pipeline',
        proxyId: 'p1',
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'Session saved.\ncodex resume 019ce018-ff0a-7ba0-9537-e4eb16a75970\n$' };
          }
          if (command.action === 'has_session') {
            return { ok: true, data: false };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await suspendAgent(captureCtx, 'capture-pipeline');

      assert.equal(result.state, 'suspended');
      // Capture step should have stored SESSION_ID in captured_vars
      const agent = db.getAgent('capture-pipeline')!;
      assert.ok(agent.capturedVars, 'capturedVars should not be null');
      assert.equal(agent.capturedVars!['SESSION_ID'], '019ce018-ff0a-7ba0-9537-e4eb16a75970');
      // SESSION_ID capture should also update currentSessionId for legacy resume
      assert.equal(agent.currentSessionId, '019ce018-ff0a-7ba0-9537-e4eb16a75970');
    });

    it('stores non-SESSION_ID captured variables without updating currentSessionId', async () => {
      const pipelineHook = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 20, regex: 'build: ([a-z0-9]+)', var: 'BUILD_HASH' },
      ]);
      db.createAgent({
        name: 'capture-custom-var',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: pipelineHook,
      });
      const a = db.getAgent('capture-custom-var')!;
      db.updateAgentState('capture-custom-var', 'active', a.version, {
        tmuxSession: 'agent-capture-custom-var',
        proxyId: 'p1',
        currentSessionId: 'existing-session',
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'Completed. build: abc123def\n$' };
          }
          if (command.action === 'has_session') {
            return { ok: true, data: false };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await suspendAgent(captureCtx, 'capture-custom-var');

      assert.equal(result.state, 'suspended');
      const agent = db.getAgent('capture-custom-var')!;
      assert.deepEqual(agent.capturedVars, { BUILD_HASH: 'abc123def' });
    });

    it('does not store when regex does not match', async () => {
      const pipelineHook = JSON.stringify([
        { type: 'shell', command: '/exit' },
        { type: 'capture', lines: 50, regex: 'codex resume ([0-9a-f-]+)', var: 'SESSION_ID' },
      ]);
      db.createAgent({
        name: 'capture-no-match',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: pipelineHook,
      });
      const a = db.getAgent('capture-no-match')!;
      db.updateAgentState('capture-no-match', 'active', a.version, {
        tmuxSession: 'agent-capture-no-match',
        proxyId: 'p1',
      });

      const captureCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'No session here\n$' };
          }
          if (command.action === 'has_session') {
            return { ok: true, data: false };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      await suspendAgent(captureCtx, 'capture-no-match');

      const agent = db.getAgent('capture-no-match')!;
      assert.equal(agent.capturedVars, null, 'capturedVars should remain null when regex does not match');
    });
  });

  describe('executeCustomButton', () => {
    it('dispatches pipeline steps for a custom button', async () => {
      const buttons = {
        compact: [
          { type: 'shell', command: '/compact' },
          { type: 'keystrokes', actions: [{ keystroke: 'Enter' }] },
        ],
      };
      db.createAgent({
        name: 'custom-btn-agent',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        customButtons: JSON.stringify(buttons),
      });
      const a = db.getAgent('custom-btn-agent')!;
      db.updateAgentState('custom-btn-agent', 'active', a.version, {
        tmuxSession: 'agent-custom-btn-agent',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await executeCustomButton(ctx, 'custom-btn-agent', 'compact');

      const pastes = proxyCommands.filter(c => c.action === 'paste');
      const keys = proxyCommands.filter(c => c.action === 'send_keys');
      assert.ok(pastes.some(c => 'text' in c && (c as { text: string }).text === '/compact'), 'should paste /compact');
      assert.ok(keys.some(c => 'keys' in c && (c as { keys: string }).keys === 'Enter'), 'should send Enter');
    });

    it('throws for non-existent button', async () => {
      db.createAgent({
        name: 'custom-btn-missing',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        customButtons: JSON.stringify({ other: [{ type: 'shell', command: 'echo' }] }),
      });
      const a = db.getAgent('custom-btn-missing')!;
      db.updateAgentState('custom-btn-missing', 'active', a.version, {
        tmuxSession: 'agent-custom-btn-missing',
        proxyId: 'p1',
      });

      await assert.rejects(
        () => executeCustomButton(ctx, 'custom-btn-missing', 'nonexistent'),
        /not found/,
      );
    });

    it('throws for agent with no custom buttons', async () => {
      db.createAgent({
        name: 'custom-btn-none',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });
      const a = db.getAgent('custom-btn-none')!;
      db.updateAgentState('custom-btn-none', 'active', a.version, {
        tmuxSession: 'agent-custom-btn-none',
        proxyId: 'p1',
      });

      await assert.rejects(
        () => executeCustomButton(ctx, 'custom-btn-none', 'anything'),
        /no custom buttons/,
      );
    });
  });

  describe('hook dispatch output validation', () => {
    // Golden output tests: verify the exact commands dispatched for each hook type.
    // These catch env wrapping, template interpolation, and pipeline dispatch bugs.

    it('compact dispatches bare command without env wrapping', async () => {
      db.createAgent({
        name: 'golden-compact',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookCompact: '/compact',
      });
      const a = db.getAgent('golden-compact')!;
      db.updateAgentState('golden-compact', 'active', a.version, {
        tmuxSession: 'agent-golden-compact',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await compactAgent(ctx, 'golden-compact');

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should dispatch paste command');
      assert.equal(paste.text, '/compact', 'compact should dispatch bare command, no env wrapping');
      assert.equal(paste.pressEnter, true, 'compact should press enter');
    });

    it('compact pipeline dispatches steps without env wrapping', async () => {
      const pipeline = JSON.stringify([
        { type: 'keystroke', key: 'Escape' },
        { type: 'shell', command: '/compact' },
      ]);
      db.createAgent({
        name: 'golden-compact-pipeline',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookCompact: pipeline,
      });
      const a = db.getAgent('golden-compact-pipeline')!;
      db.updateAgentState('golden-compact-pipeline', 'active', a.version, {
        tmuxSession: 'agent-golden-compact-pipeline',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await compactAgent(ctx, 'golden-compact-pipeline');

      const keys = proxyCommands.filter(c => c.action === 'send_keys');
      const pastes = proxyCommands.filter(c => c.action === 'paste');
      assert.ok(keys.some(c => 'keys' in c && (c as { keys: string }).keys === 'Escape'), 'should send Escape');
      assert.ok(pastes.length >= 1, 'should have paste');
      const compactPaste = pastes.find(c => 'text' in c && (c as { text: string }).text === '/compact');
      assert.ok(compactPaste, 'compact paste should be bare /compact without env');
    });

    it('interrupt dispatches bare keystrokes without env wrapping', async () => {
      db.createAgent({
        name: 'golden-interrupt',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });
      const a = db.getAgent('golden-interrupt')!;
      db.updateAgentState('golden-interrupt', 'active', a.version, {
        tmuxSession: 'agent-golden-interrupt',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await interruptAgent(ctx, 'golden-interrupt');

      // Interrupt should only send keystrokes — no paste, no env
      const pastes = proxyCommands.filter(c => c.action === 'paste');
      assert.equal(pastes.length, 0, 'interrupt should not paste anything');
      const keys = proxyCommands.filter(c => c.action === 'send_keys');
      assert.ok(keys.length >= 1, 'interrupt should send at least one keystroke');
    });

    it('exit dispatches bare command without env wrapping', async () => {
      db.createAgent({
        name: 'golden-exit',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: '/exit',
      });
      const a = db.getAgent('golden-exit')!;
      db.updateAgentState('golden-exit', 'active', a.version, {
        tmuxSession: 'agent-golden-exit',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await suspendAgent(ctx, 'golden-exit');

      const paste = proxyCommands.find(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text === '/exit') as Extract<ProxyCommand, { action: 'paste' }> | undefined;
      assert.ok(paste, 'exit should dispatch bare /exit');
      // Should NOT have env wrapping
      const envPastes = proxyCommands.filter(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text.includes('COLLAB_AGENT='));
      assert.equal(envPastes.length, 0, 'exit should not have env wrapping');
    });

    it('exit pipeline dispatches steps without env wrapping', async () => {
      const pipeline = JSON.stringify([
        { type: 'keystroke', key: 'Escape' },
        { type: 'shell', command: '/exit' },
      ]);
      db.createAgent({
        name: 'golden-exit-pipeline',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookExit: pipeline,
      });
      const a = db.getAgent('golden-exit-pipeline')!;
      db.updateAgentState('golden-exit-pipeline', 'active', a.version, {
        tmuxSession: 'agent-golden-exit-pipeline',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await suspendAgent(ctx, 'golden-exit-pipeline');

      const exitPaste = proxyCommands.find(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text === '/exit');
      assert.ok(exitPaste, 'exit pipeline should paste bare /exit');
    });

    it('custom button dispatches bare command without env wrapping', async () => {
      const buttons = { myaction: [{ type: 'shell', command: '/my-command' }] };
      db.createAgent({
        name: 'golden-custom',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        customButtons: JSON.stringify(buttons),
      });
      const a = db.getAgent('golden-custom')!;
      db.updateAgentState('golden-custom', 'active', a.version, {
        tmuxSession: 'agent-golden-custom',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await executeCustomButton(ctx, 'golden-custom', 'myaction');

      const paste = proxyCommands.find(c => c.action === 'paste') as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'custom button should dispatch paste');
      assert.equal(paste.text, '/my-command', 'custom button should paste bare command');
    });

    it('start dispatches command WITH env wrapping', async () => {
      db.createAgent({
        name: 'golden-start',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookStart: 'claude --model opus',
      });

      proxyCommands = [];
      await spawnAgent(ctx, {
        name: 'golden-start',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text.includes('claude --model opus')) as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'start should dispatch paste with launch command');
      assert.ok(paste.text.includes('COLLAB_AGENT='), 'start SHOULD have env wrapping');
      assert.ok(paste.text.includes('COLLAB_PERSONA_FILE='), 'start SHOULD include persona file');
    });

    it('resume dispatches command WITH env wrapping', async () => {
      db.createAgent({
        name: 'golden-resume',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookResume: 'claude --resume test-session',
      });
      const a = db.getAgent('golden-resume')!;
      db.updateAgentState('golden-resume', 'suspended', a.version, {
        currentSessionId: 'test-session',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await resumeAgent(ctx, 'golden-resume');

      const paste = proxyCommands.find(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text.includes('claude --resume')) as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'resume should dispatch paste');
      assert.ok(paste.text.includes('COLLAB_AGENT='), 'resume SHOULD have env wrapping');
    });

    it('start with ShellHook env does NOT duplicate COLLAB_AGENT', async () => {
      // ShellHook format: { shell: "...", env: { CUSTOM: "val" } }
      const hookStart = JSON.stringify({ shell: 'claude --model opus', env: { MY_VAR: 'hello world' } });
      db.createAgent({
        name: 'golden-shell-env',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        hookStart,
      });

      proxyCommands = [];
      await spawnAgent(ctx, {
        name: 'golden-shell-env',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
      });

      const paste = proxyCommands.find(c => c.action === 'paste' && 'text' in c && (c as { text: string }).text.includes('claude --model opus')) as Extract<ProxyCommand, { action: 'paste' }>;
      assert.ok(paste, 'should dispatch paste with claude command');
      // Count COLLAB_AGENT occurrences — should be exactly 1 (from withLaunchEnv, not from ShellHook resolver)
      const matches = paste.text.match(/COLLAB_AGENT=/g) || [];
      assert.equal(matches.length, 1, `COLLAB_AGENT should appear exactly once, got ${matches.length}: ${paste.text}`);
      // Custom env should be present and shell-quoted
      assert.ok(paste.text.includes('MY_VAR='), 'custom env should be present');
      assert.ok(paste.text.includes("'hello world'"), 'custom env values should be shell-quoted');
    });
  });
});
