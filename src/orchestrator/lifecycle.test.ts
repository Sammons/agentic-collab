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
  reloadAgent, interruptAgent, compactAgent, type LifecycleContext,
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
  });
});
