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

  describe('pending_messages (queue)', () => {
    it('enqueues a message', () => {
      const msg = db.enqueueMessage({
        sourceAgent: 'agent-a',
        targetAgent: 'agent-b',
        envelope: '[from: agent-a]: hello',
      });
      assert.equal(msg.sourceAgent, 'agent-a');
      assert.equal(msg.targetAgent, 'agent-b');
      assert.equal(msg.status, 'pending');
      assert.equal(msg.retryCount, 0);
      assert.ok(msg.id > 0);
    });

    it('enqueues a dashboard message (null source)', () => {
      const msg = db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'agent-b',
        envelope: '[from: dashboard]: hi',
      });
      assert.equal(msg.sourceAgent, null);
    });

    it('retrieves deliverable messages', () => {
      const messages = db.getDeliverableMessages('agent-b');
      assert.ok(messages.length >= 2);
      assert.ok(messages.every(m => m.status === 'pending'));
    });

    it('marks attempt started', () => {
      const messages = db.getDeliverableMessages('agent-b');
      const msg = messages[0]!;
      db.markAttemptStarted(msg.id);
      const updated = db.getPendingMessageById(msg.id)!;
      assert.ok(updated.lastAttemptAt !== null);
    });

    it('marks message delivered', () => {
      const messages = db.getDeliverableMessages('agent-b');
      const msg = messages[0]!;
      db.markMessageDelivered(msg.id);
      const updated = db.getPendingMessageById(msg.id)!;
      assert.equal(updated.status, 'delivered');
      assert.ok(updated.deliveredAt !== null);
    });

    it('marks attempt failed with backoff', () => {
      const msg = db.enqueueMessage({
        sourceAgent: 'agent-c',
        targetAgent: 'agent-d',
        envelope: 'will fail',
      });
      db.markAttemptStarted(msg.id);
      db.markAttemptFailed(msg.id, 'proxy unreachable');
      const updated = db.getPendingMessageById(msg.id)!;
      assert.equal(updated.retryCount, 1);
      assert.equal(updated.error, 'proxy unreachable');
      assert.ok(updated.nextAttemptAt !== null);
      assert.equal(updated.status, 'pending'); // not failed yet
    });

    it('marks as failed after max retries', () => {
      const msg = db.enqueueMessage({
        sourceAgent: 'agent-c',
        targetAgent: 'agent-d',
        envelope: 'will fail permanently',
      });
      // Exhaust all retries
      for (let i = 0; i < 5; i++) {
        db.markAttemptStarted(msg.id);
        db.markAttemptFailed(msg.id, `attempt ${i + 1} failed`);
      }
      const updated = db.getPendingMessageById(msg.id)!;
      assert.equal(updated.status, 'failed');
      assert.equal(updated.retryCount, 5);
    });

    it('lists pending messages with filters', () => {
      const all = db.listPendingMessages();
      assert.ok(all.length > 0);

      const pending = db.listPendingMessages(undefined, 'pending');
      assert.ok(pending.every(m => m.status === 'pending'));

      const forAgent = db.listPendingMessages('agent-b');
      assert.ok(forAgent.every(m => m.targetAgent === 'agent-b'));
    });

    it('links dashboard message to queue', () => {
      const dashMsg = db.addDashboardMessage('queue-link-agent', 'to_agent', 'linked msg');
      const queueMsg = db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'queue-link-agent',
        envelope: 'linked',
      });
      db.linkDashboardMessageToQueue(dashMsg.id, queueMsg.id);

      // Verify via threads
      const threads = db.getDashboardThreads('queue-link-agent');
      const msgs = threads['queue-link-agent']!;
      const linked = msgs.find(m => m.id === dashMsg.id);
      assert.equal(linked?.queueId, queueMsg.id);
    });

    it('resetStaleAttempts recovers hung deliveries', () => {
      const msg = db.enqueueMessage({
        sourceAgent: null,
        targetAgent: 'agent-stale',
        envelope: 'stale test',
      });
      db.markAttemptStarted(msg.id);
      // Manually backdate the last_attempt_at to make it stale
      db.rawDb.prepare(
        `UPDATE pending_messages SET last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-120 seconds') WHERE id = ?`
      ).run(msg.id);

      const reset = db.resetStaleAttempts(60);
      assert.ok(reset >= 1);

      const updated = db.getPendingMessageById(msg.id)!;
      assert.equal(updated.retryCount, 1);
      assert.ok(updated.nextAttemptAt !== null);
    });

    it('clearDashboardMessages removes all messages for agent', () => {
      db.addDashboardMessage('clear-agent', 'to_agent', 'msg1');
      db.addDashboardMessage('clear-agent', 'from_agent', 'msg2');
      db.addDashboardMessage('clear-other', 'to_agent', 'msg3');

      db.clearDashboardMessages('clear-agent');

      const threads = db.getDashboardThreads();
      assert.equal(threads['clear-agent'], undefined);
      assert.ok(threads['clear-other']?.length === 1);
    });

    it('clearPendingMessages removes only pending dashboard messages', () => {
      const pending = db.enqueueMessage({ sourceAgent: null, targetAgent: 'clear-pending', envelope: 'test' });
      const agentMsg = db.enqueueMessage({ sourceAgent: 'some-agent', targetAgent: 'clear-pending', envelope: 'from agent' });

      db.clearPendingMessages('clear-pending');

      // Dashboard-sourced pending message should be gone
      assert.equal(db.getPendingMessageById(pending.id), undefined);
      // Agent-sourced message should remain
      const remaining = db.getPendingMessageById(agentMsg.id);
      assert.ok(remaining);
    });
  });
});
