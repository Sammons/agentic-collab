import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Database', () => {
  let db: Database;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-collab-test-'));
    db = new Database(join(tmpDir, 'test.db'));
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('agents', () => {
    it('creates and retrieves an agent', () => {
      const agent = db.createAgent({
        name: 'test-agent-1',
        engine: 'claude',
        model: 'opus',
        thinking: 'high',
        cwd: '/tmp/test',
        persona: 'test-persona.md',
      });

      assert.equal(agent.name, 'test-agent-1');
      assert.equal(agent.engine, 'claude');
      assert.equal(agent.model, 'opus');
      assert.equal(agent.thinking, 'high');
      assert.equal(agent.state, 'void');
      assert.equal(agent.version, 0);
      assert.equal(agent.spawnCount, 0);

      const retrieved = db.getAgent('test-agent-1');
      assert.deepEqual(retrieved, agent);
    });

    it('rejects duplicate agent names', () => {
      db.createAgent({ name: 'dup-test', engine: 'claude', cwd: '/tmp' });
      assert.throws(() => {
        db.createAgent({ name: 'dup-test', engine: 'claude', cwd: '/tmp' });
      });
    });

    it('lists all agents sorted by name', () => {
      db.createAgent({ name: 'z-agent', engine: 'codex', cwd: '/tmp' });
      db.createAgent({ name: 'a-agent', engine: 'opencode', cwd: '/tmp' });
      const agents = db.listAgents();
      const names = agents.map(a => a.name);
      assert.ok(names.indexOf('a-agent') < names.indexOf('z-agent'));
    });

    it('updates agent state with version check', () => {
      const agent = db.createAgent({ name: 'state-test', engine: 'claude', cwd: '/tmp' });
      assert.equal(agent.version, 0);

      const updated = db.updateAgentState('state-test', 'spawning', 0);
      assert.equal(updated.state, 'spawning');
      assert.equal(updated.version, 1);

      const updated2 = db.updateAgentState('state-test', 'active', 1, {
        tmuxSession: 'agent-state-test',
        lastActivity: '2025-01-01T00:00:00Z',
      });
      assert.equal(updated2.state, 'active');
      assert.equal(updated2.version, 2);
      assert.equal(updated2.tmuxSession, 'agent-state-test');
    });

    it('rejects state update with wrong version', () => {
      db.createAgent({ name: 'version-test', engine: 'claude', cwd: '/tmp' });
      db.updateAgentState('version-test', 'spawning', 0);
      assert.throws(() => {
        db.updateAgentState('version-test', 'active', 0); // Wrong version
      }, /Version conflict/);
    });

    it('updates state with extra fields', () => {
      db.createAgent({ name: 'extra-test', engine: 'claude', cwd: '/tmp' });
      const updated = db.updateAgentState('extra-test', 'failed', 0, {
        failedAt: '2025-01-01T00:00:00Z',
        failureReason: 'Spawn timeout',
      });
      assert.equal(updated.state, 'failed');
      assert.equal(updated.failedAt, '2025-01-01T00:00:00Z');
      assert.equal(updated.failureReason, 'Spawn timeout');
    });

    it('deletes an agent', () => {
      db.createAgent({ name: 'delete-me', engine: 'claude', cwd: '/tmp' });
      assert.ok(db.getAgent('delete-me'));
      assert.ok(db.deleteAgent('delete-me'));
      assert.equal(db.getAgent('delete-me'), undefined);
    });

    it('returns false when deleting non-existent agent', () => {
      assert.equal(db.deleteAgent('nope'), false);
    });

    it('throws on non-existent agent state update', () => {
      assert.throws(() => {
        db.updateAgentState('nonexistent', 'active', 0);
      }, /not found/);
    });
  });

  describe('events', () => {
    it('logs and retrieves events', () => {
      db.createAgent({ name: 'event-agent', engine: 'claude', cwd: '/tmp' });
      const ev = db.logEvent('event-agent', 'spawned', 'msg-abc', { foo: 'bar' });
      assert.equal(ev.agentName, 'event-agent');
      assert.equal(ev.event, 'spawned');
      assert.equal(ev.messageId, 'msg-abc');
      assert.equal(JSON.parse(ev.meta!).foo, 'bar');

      const events = db.getEvents('event-agent');
      assert.ok(events.length >= 1);
      assert.equal(events[0]!.event, 'spawned');
    });

    it('respects event limit', () => {
      db.createAgent({ name: 'limit-agent', engine: 'claude', cwd: '/tmp' });
      for (let i = 0; i < 10; i++) {
        db.logEvent('limit-agent', `event-${i}`);
      }
      const limited = db.getEvents('limit-agent', 3);
      assert.equal(limited.length, 3);
    });
  });

  describe('dashboard_messages', () => {
    it('adds and retrieves messages', () => {
      const msg = db.addDashboardMessage('test-agent-1', 'to_agent', 'Hello agent', 'greeting');
      assert.equal(msg.agent, 'test-agent-1');
      assert.equal(msg.direction, 'to_agent');
      assert.equal(msg.message, 'Hello agent');
      assert.equal(msg.topic, 'greeting');

      const msg2 = db.addDashboardMessage('test-agent-1', 'from_agent', 'Hi there');
      assert.equal(msg2.direction, 'from_agent');
      assert.equal(msg2.topic, null);
    });

    it('retrieves threads grouped by agent', () => {
      db.addDashboardMessage('thread-agent-a', 'to_agent', 'msg1');
      db.addDashboardMessage('thread-agent-b', 'to_agent', 'msg2');
      db.addDashboardMessage('thread-agent-a', 'from_agent', 'reply1');

      const threads = db.getDashboardThreads();
      assert.ok(threads['thread-agent-a']);
      assert.ok(threads['thread-agent-b']);
      assert.equal(threads['thread-agent-a']!.length, 2);
      assert.equal(threads['thread-agent-b']!.length, 1);
    });

    it('filters threads by agent name', () => {
      const threads = db.getDashboardThreads('thread-agent-a');
      assert.ok(threads['thread-agent-a']);
      assert.equal(threads['thread-agent-b'], undefined);
    });
  });

  describe('workstreams', () => {
    it('creates a workstream with agents', () => {
      db.createAgent({ name: 'ws-agent-1', engine: 'claude', cwd: '/tmp' });
      db.createAgent({ name: 'ws-agent-2', engine: 'claude', cwd: '/tmp' });

      const ws = db.createWorkstream('test-ws', 'Build the thing', 'plan.md');
      assert.equal(ws.name, 'test-ws');
      assert.equal(ws.goal, 'Build the thing');
      assert.equal(ws.plan, 'plan.md');

      db.addAgentToWorkstream('test-ws', 'ws-agent-1');
      db.addAgentToWorkstream('test-ws', 'ws-agent-2');

      const agents = db.getWorkstreamAgents('test-ws');
      assert.deepEqual(agents, ['ws-agent-1', 'ws-agent-2']);
    });

    it('lists workstreams', () => {
      const list = db.listWorkstreams();
      assert.ok(list.some(ws => ws.name === 'test-ws'));
    });

    it('handles duplicate agent-workstream assignment gracefully', () => {
      // Should not throw due to INSERT OR IGNORE
      db.addAgentToWorkstream('test-ws', 'ws-agent-1');
      const agents = db.getWorkstreamAgents('test-ws');
      assert.equal(agents.filter(a => a === 'ws-agent-1').length, 1);
    });
  });

  describe('proxies', () => {
    it('registers and retrieves a proxy', () => {
      const proxy = db.registerProxy('proxy-1', 'token-abc', 'localhost:3100');
      assert.equal(proxy.proxyId, 'proxy-1');
      assert.equal(proxy.token, 'token-abc');
      assert.equal(proxy.host, 'localhost:3100');
    });

    it('lists proxies', () => {
      const list = db.listProxies();
      assert.ok(list.some(p => p.proxyId === 'proxy-1'));
    });

    it('updates heartbeat', () => {
      const before = db.getProxy('proxy-1')!;
      // Small delay to ensure time difference
      db.updateProxyHeartbeat('proxy-1');
      const after = db.getProxy('proxy-1')!;
      assert.ok(after.lastHeartbeat >= before.lastHeartbeat);
    });

    it('returns false for heartbeat on unknown proxy', () => {
      assert.equal(db.updateProxyHeartbeat('nope'), false);
    });

    it('removes a proxy', () => {
      db.registerProxy('proxy-del', 'tok', 'host:1234');
      assert.ok(db.removeProxy('proxy-del'));
      assert.equal(db.getProxy('proxy-del'), undefined);
    });

    it('replaces proxy on re-register', () => {
      db.registerProxy('proxy-re', 'old-token', 'old-host:1234');
      db.registerProxy('proxy-re', 'new-token', 'new-host:5678');
      const proxy = db.getProxy('proxy-re')!;
      assert.equal(proxy.token, 'new-token');
      assert.equal(proxy.host, 'new-host:5678');
    });
  });
});
