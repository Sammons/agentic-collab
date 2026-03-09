import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
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
      assert.ok(paste.text.includes('-a never'), 'should include -a never for unattended operation');
      assert.ok(paste.text.includes('-s danger-full-access'), 'should include -s danger-full-access sandbox mode');
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
      assert.ok(paste.text.startsWith('export COLLAB_AGENT=cmd-minimal && claude'), 'should have COLLAB_AGENT prefix and claude command');
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
});
