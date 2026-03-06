import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import type { LifecycleContext } from './lifecycle.ts';

describe('Network', () => {
  let db: Database;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];
  let ctx: LifecycleContext;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'network-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    proxyCommands = [];

    ctx = {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'has_session') {
          return { ok: true, data: false }; // simulate missing sessions for crash recovery
        }
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
    };
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('shutdownAgents', () => {
    it('suspends active agents with stateBeforeShutdown', () => {
      db.createAgent({ name: 'net-active', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-active')!;
      db.updateAgentState('net-active', 'active', a.version, {
        tmuxSession: 'agent-net-active',
        proxyId: 'p1',
      });

      db.createAgent({ name: 'net-idle', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const b = db.getAgent('net-idle')!;
      db.updateAgentState('net-idle', 'idle', b.version, {
        tmuxSession: 'agent-net-idle',
        proxyId: 'p1',
      });

      const count = shutdownAgents(ctx);
      assert.equal(count, 2);

      const active = db.getAgent('net-active')!;
      assert.equal(active.state, 'suspended');
      assert.equal(active.stateBeforeShutdown, 'active');

      const idle = db.getAgent('net-idle')!;
      assert.equal(idle.state, 'suspended');
      assert.equal(idle.stateBeforeShutdown, 'idle');
    });

    it('ignores void/suspended agents', () => {
      db.createAgent({ name: 'net-void', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      // void agent should not be touched
      const count = shutdownAgents(ctx);
      assert.equal(count, 0); // net-active and net-idle already suspended
    });
  });

  describe('restoreAllAgents', () => {
    it('restores agents with stateBeforeShutdown', async () => {
      proxyCommands = [];
      const count = await restoreAllAgents(ctx);
      assert.ok(count >= 1); // at least net-active and net-idle should be restored
      assert.ok(proxyCommands.some(c => c.action === 'create_session'));
      assert.ok(proxyCommands.some(c => c.action === 'paste'));
    });

    it('returns 0 when nothing to restore', async () => {
      // All agents should now be active/idle after restore
      // Create a fresh context with sessions found
      const freshCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'has_session') {
            return { ok: true, data: true }; // sessions exist
          }
          return { ok: true };
        },
      };
      // Suspend all first, then clear stateBeforeShutdown
      const agents = db.listAgents().filter(a => a.state === 'active' || a.state === 'idle');
      for (const a of agents) {
        db.updateAgentState(a.name, 'suspended', a.version, {
          stateBeforeShutdown: null,
        });
      }

      proxyCommands = [];
      const count = await restoreAllAgents(freshCtx);
      assert.equal(count, 0);
    });
  });
});
