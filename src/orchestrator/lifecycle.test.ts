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
  reloadAgent, interruptAgent, compactAgent, killAgent, startWatchdog, type LifecycleContext,
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
      assert.ok(paste.text.includes('MY_VAR=hello'), 'should preserve hook-local shell env');
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
      assert.ok(paste.text.includes('COLLAB_PERSONA_FILE='), 'should export COLLAB_PERSONA_FILE');
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

  describe('detect_session_regex on suspend', () => {
    it('extracts session ID from pane capture on suspend when regex is set', async () => {
      db.createAgent({
        name: 'detect-suspend',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        detectSessionRegex: 'codex resume ([0-9a-f-]+)',
      });
      const a = db.getAgent('detect-suspend')!;
      db.updateAgentState('detect-suspend', 'active', a.version, {
        tmuxSession: 'agent-detect-suspend',
        proxyId: 'p1',
      });

      // Mock proxy to return exit output containing session ID
      const detectCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'Session saved.\nTo continue this session, run codex resume 019ce018-ff0a-7ba0-9537-e4eb16a75970\n$' };
          }
          if (command.action === 'has_session') {
            return { ok: true, data: false }; // session exited cleanly
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await suspendAgent(detectCtx, 'detect-suspend');

      assert.equal(result.state, 'suspended');
      assert.equal(result.currentSessionId, '019ce018-ff0a-7ba0-9537-e4eb16a75970');
    });

    it('does not overwrite session ID when regex does not match', async () => {
      db.createAgent({
        name: 'detect-nomatch',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        detectSessionRegex: 'codex resume ([0-9a-f-]+)',
      });
      const a = db.getAgent('detect-nomatch')!;
      db.updateAgentState('detect-nomatch', 'active', a.version, {
        tmuxSession: 'agent-detect-nomatch',
        proxyId: 'p1',
        currentSessionId: 'original-session-id',
      });

      // Mock proxy to return exit output WITHOUT a session ID
      const noMatchCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'Process exited.\n$' };
          }
          if (command.action === 'has_session') {
            return { ok: true, data: false };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await suspendAgent(noMatchCtx, 'detect-nomatch');

      assert.equal(result.state, 'suspended');
      // currentSessionId should remain unchanged since regex didn't match
      assert.equal(result.currentSessionId, 'original-session-id');
    });

    it('skips pane capture when no detect_session_regex is set', async () => {
      db.createAgent({
        name: 'detect-none',
        engine: 'claude',
        cwd: '/tmp',
        proxyId: 'p1',
        // No detectSessionRegex
      });
      const a = db.getAgent('detect-none')!;
      db.updateAgentState('detect-none', 'active', a.version, {
        tmuxSession: 'agent-detect-none',
        proxyId: 'p1',
      });

      proxyCommands = [];
      await suspendAgent(ctx, 'detect-none');

      // The default mock returns capture for any capture call, but
      // without detectSessionRegex the suspend flow should NOT attempt capture
      // before the has_session check. Only has_session + kill should appear
      // after the exit paste.
      const captureBeforeHasSession = proxyCommands.findIndex(c => c.action === 'capture');
      const hasSessionIdx = proxyCommands.findIndex(c => c.action === 'has_session');
      // If capture exists, it should not be for session detection (only has_session check matters)
      if (captureBeforeHasSession !== -1) {
        // In the default ctx, capture returns '> \n' which won't match anything,
        // but more importantly the code path should not call capture before has_session
        // when there's no regex set
        assert.ok(captureBeforeHasSession > hasSessionIdx || hasSessionIdx === -1,
          'should not capture pane for session detection when no regex is set');
      }
    });
  });

  describe('detect_session_regex on reload', () => {
    it('uses exit-detected session ID for reload resume command', async () => {
      db.createAgent({
        name: 'detect-reload',
        engine: 'codex',
        cwd: '/tmp',
        proxyId: 'p1',
        detectSessionRegex: 'codex resume ([0-9a-f-]+)',
      });
      const a = db.getAgent('detect-reload')!;
      db.updateAgentState('detect-reload', 'active', a.version, {
        tmuxSession: 'agent-detect-reload',
        proxyId: 'p1',
        currentSessionId: null, // no prior session
      });

      // Mock proxy to return exit output with session ID
      const detectCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'capture') {
            return { ok: true, data: 'To continue this session, run codex resume abc-def-123\n$' };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const result = await reloadAgent(detectCtx, 'detect-reload', { immediate: true });

      assert.equal(result.state, 'active');
      // The detected session ID from exit should be persisted
      assert.equal(result.currentSessionId, 'abc-def-123');
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
});
