import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
        launchEnv: {
          GIT_CONFIG_GLOBAL: '$PWD/test-agent.gitconfig',
          GIT_AUTHOR_NAME: 'test-agent',
        },
      });

      assert.equal(agent.name, 'test-agent-1');
      assert.equal(agent.engine, 'claude');
      assert.equal(agent.model, 'opus');
      assert.equal(agent.thinking, 'high');
      assert.deepEqual(agent.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/test-agent.gitconfig',
        GIT_AUTHOR_NAME: 'test-agent',
      });
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

    it('upserts launch env from persona config without disturbing runtime state', () => {
      const created = db.createAgent({ name: 'persona-env', engine: 'claude', cwd: '/tmp/persona-env' });
      db.updateAgentState('persona-env', 'active', created.version, {
        tmuxSession: 'agent-persona-env',
        proxyId: 'proxy-env',
      });

      const updated = db.upsertAgentFromPersona({
        name: 'persona-env',
        engine: 'claude',
        cwd: '/tmp/persona-env-v2',
        launchEnv: {
          GIT_CONFIG_GLOBAL: '$PWD/persona-env.gitconfig',
          GIT_AUTHOR_NAME: 'persona-env',
        },
      });
      assert.equal(updated.state, 'active');
      assert.equal(updated.tmuxSession, 'agent-persona-env');
      assert.equal(updated.proxyId, 'proxy-env');
      assert.equal(updated.cwd, '/tmp/persona-env-v2');
      assert.deepEqual(updated.launchEnv, {
        GIT_CONFIG_GLOBAL: '$PWD/persona-env.gitconfig',
        GIT_AUTHOR_NAME: 'persona-env',
      });

      const cleared = db.upsertAgentFromPersona({
        name: 'persona-env',
        engine: 'claude',
        cwd: '/tmp/persona-env-v2',
        launchEnv: null,
      });
      assert.equal(cleared.launchEnv, null);
      assert.equal(cleared.state, 'active');
      assert.equal(cleared.tmuxSession, 'agent-persona-env');
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

  describe('migrations', () => {
    it('adds launch_env to legacy agents tables', () => {
      const legacyDir = mkdtempSync(join(tmpdir(), 'agentic-collab-legacy-'));
      const dbPath = join(legacyDir, 'legacy.db');
      const legacyDb = new DatabaseSync(dbPath);

      legacyDb.exec(`
        CREATE TABLE agents (
          name               TEXT PRIMARY KEY,
          engine             TEXT NOT NULL,
          model              TEXT,
          thinking           TEXT,
          cwd                TEXT NOT NULL,
          persona            TEXT,
          permissions        TEXT,
          proxy_host         TEXT,
          state              TEXT NOT NULL DEFAULT 'void',
          state_before_shutdown TEXT,
          current_session_id TEXT,
          tmux_session       TEXT,
          proxy_id           TEXT,
          last_activity      TEXT,
          last_context_pct   INTEGER,
          reload_queued      INTEGER NOT NULL DEFAULT 0,
          reload_task        TEXT,
          failed_at          TEXT,
          failure_reason     TEXT,
          version            INTEGER NOT NULL DEFAULT 0,
          spawn_count        INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
      `);
      legacyDb.prepare(`
        INSERT INTO agents (name, engine, cwd, state, version, spawn_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('legacy-agent', 'claude', '/legacy', 'void', 0, 0, '2026-03-13T00:00:00Z');
      legacyDb.close();

      const migratedDb = new Database(dbPath);
      try {
        const columns = migratedDb.rawDb.prepare('PRAGMA table_info(agents)').all() as Array<Record<string, unknown>>;
        assert.ok(columns.some((column) => column['name'] === 'launch_env'));

        const legacyAgent = migratedDb.getAgent('legacy-agent');
        assert.ok(legacyAgent);
        assert.equal(legacyAgent.launchEnv, null);
      } finally {
        migratedDb.close();
        rmSync(legacyDir, { recursive: true, force: true });
      }
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
      const msg = db.addDashboardMessage('test-agent-1', 'to_agent', 'Hello agent', { topic: 'greeting' });
      assert.equal(msg.agent, 'test-agent-1');
      assert.equal(msg.direction, 'to_agent');
      assert.equal(msg.message, 'Hello agent');
      assert.equal(msg.topic, 'greeting');
      assert.equal(msg.sourceAgent, null);
      assert.equal(msg.targetAgent, null);

      const msg2 = db.addDashboardMessage('test-agent-1', 'from_agent', 'Hi there');
      assert.equal(msg2.direction, 'from_agent');
      assert.equal(msg2.topic, null);
      assert.equal(msg2.sourceAgent, null);
      assert.equal(msg2.targetAgent, null);
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

    it('searches messages by text', () => {
      db.addDashboardMessage('search-agent-a', 'to_agent', 'deploy the widget service');
      db.addDashboardMessage('search-agent-a', 'from_agent', 'widget deployed successfully');
      db.addDashboardMessage('search-agent-b', 'to_agent', 'check widget status');
      db.addDashboardMessage('search-agent-b', 'from_agent', 'all systems nominal');

      // Search across all agents
      const widgetResults = db.searchMessages('widget');
      assert.equal(widgetResults.length, 3);
      assert.ok(widgetResults.every(m => m.message.toLowerCase().includes('widget')));

      // Search filtered to one agent
      const agentBResults = db.searchMessages('widget', 'search-agent-b');
      assert.equal(agentBResults.length, 1);
      assert.equal(agentBResults[0]!.agent, 'search-agent-b');

      // Search with no matches
      const noResults = db.searchMessages('nonexistent-term-xyz');
      assert.equal(noResults.length, 0);
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

    it('touchAllProxyHeartbeats refreshes all proxies', () => {
      db.registerProxy('touch-a', 'tok-a', 'host-a:1234');
      db.registerProxy('touch-b', 'tok-b', 'host-b:5678');
      const count = db.touchAllProxyHeartbeats();
      // Should touch at least the two we just registered (plus any from prior tests)
      assert.ok(count >= 2, `expected >= 2 touched, got ${count}`);
      const a = db.getProxy('touch-a')!;
      const b = db.getProxy('touch-b')!;
      assert.ok(a.lastHeartbeat);
      assert.ok(b.lastHeartbeat);
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

  describe('dashboard_read_cursors', () => {
    let cursorDb: Database;
    let cursorTmpDir: string;

    before(() => {
      cursorTmpDir = mkdtempSync(join(tmpdir(), 'agentic-cursor-test-'));
      cursorDb = new Database(join(cursorTmpDir, 'cursor.db'));
      cursorDb.createAgent({ name: 'cursor-agent-a', engine: 'claude', cwd: '/tmp' });
      cursorDb.createAgent({ name: 'cursor-agent-b', engine: 'claude', cwd: '/tmp' });
    });

    after(() => {
      cursorDb.close();
      rmSync(cursorTmpDir, { recursive: true, force: true });
    });

    it('returns unread counts for agents with no cursor', () => {
      cursorDb.addDashboardMessage('cursor-agent-a', 'from_agent', 'msg1');
      cursorDb.addDashboardMessage('cursor-agent-a', 'from_agent', 'msg2');

      const counts = cursorDb.getUnreadCounts();
      assert.equal(counts['cursor-agent-a'], 2);
    });

    it('returns zero unread after updating read cursor', () => {
      cursorDb.updateReadCursor('cursor-agent-a');

      const counts = cursorDb.getUnreadCounts();
      assert.equal(counts['cursor-agent-a'] ?? 0, 0);
    });

    it('counts only messages after last read cursor', () => {
      cursorDb.updateReadCursor('cursor-agent-a');
      cursorDb.addDashboardMessage('cursor-agent-a', 'from_agent', 'msg3');

      const counts = cursorDb.getUnreadCounts();
      assert.equal(counts['cursor-agent-a'], 1);
    });

    it('upserts read cursor idempotently', () => {
      cursorDb.updateReadCursor('cursor-agent-a');
      cursorDb.updateReadCursor('cursor-agent-a');
      // Should not throw — ON CONFLICT handles the upsert
      const counts = cursorDb.getUnreadCounts();
      assert.ok(typeof (counts['cursor-agent-a'] ?? 0) === 'number');
    });
  });

  describe('reminders', () => {
    let rDb: Database;
    let rTmpDir: string;

    before(() => {
      rTmpDir = mkdtempSync(join(tmpdir(), 'agentic-reminder-test-'));
      rDb = new Database(join(rTmpDir, 'reminder.db'));
      rDb.createAgent({ name: 'rem-agent-a', engine: 'claude', cwd: '/tmp' });
      rDb.createAgent({ name: 'rem-agent-b', engine: 'claude', cwd: '/tmp' });
    });

    after(() => {
      rDb.close();
      rmSync(rTmpDir, { recursive: true, force: true });
    });

    it('creates a reminder', () => {
      const r = rDb.createReminder({
        agentName: 'rem-agent-a',
        createdBy: 'dashboard',
        prompt: 'Check build status',
        cadenceMinutes: 10,
      });
      assert.equal(r.agentName, 'rem-agent-a');
      assert.equal(r.createdBy, 'dashboard');
      assert.equal(r.prompt, 'Check build status');
      assert.equal(r.cadenceMinutes, 10);
      assert.equal(r.status, 'pending');
      assert.equal(r.sortOrder, 0);
      assert.equal(r.lastDeliveredAt, null);
      assert.equal(r.completedAt, null);
      assert.ok(r.id > 0);
    });

    it('auto-increments sort_order per agent', () => {
      const r1 = rDb.createReminder({
        agentName: 'rem-agent-a',
        prompt: 'Second reminder',
        cadenceMinutes: 15,
      });
      const r2 = rDb.createReminder({
        agentName: 'rem-agent-a',
        prompt: 'Third reminder',
        cadenceMinutes: 20,
      });
      // r1 should be sort_order 1, r2 should be sort_order 2 (first was 0)
      assert.equal(r1.sortOrder, 1);
      assert.equal(r2.sortOrder, 2);

      // Different agent starts from 0
      const r3 = rDb.createReminder({
        agentName: 'rem-agent-b',
        prompt: 'Agent B first',
        cadenceMinutes: 5,
      });
      assert.equal(r3.sortOrder, 0);
    });

    it('rejects cadence < 5', () => {
      assert.throws(() => {
        rDb.createReminder({
          agentName: 'rem-agent-a',
          prompt: 'Too fast',
          cadenceMinutes: 3,
        });
      }, /cadenceMinutes must be >= 5/);
    });

    it('listReminders filters by agent', () => {
      const allA = rDb.listReminders('rem-agent-a');
      assert.ok(allA.length >= 3);
      assert.ok(allA.every(r => r.agentName === 'rem-agent-a'));

      const allB = rDb.listReminders('rem-agent-b');
      assert.ok(allB.length >= 1);
      assert.ok(allB.every(r => r.agentName === 'rem-agent-b'));

      const all = rDb.listReminders();
      assert.ok(all.length >= allA.length + allB.length);
    });

    it('completeReminder updates status and completed_at', () => {
      const r = rDb.createReminder({
        agentName: 'rem-agent-a',
        prompt: 'Will complete',
        cadenceMinutes: 10,
      });
      const completed = rDb.completeReminder(r.id);
      assert.ok(completed);
      assert.equal(completed!.status, 'completed');
      assert.ok(completed!.completedAt !== null);
    });

    it('listReminders keeps pending first and caps completed history to five', () => {
      const agentName = 'rem-agent-history';
      rDb.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp' });
      const pendingA = rDb.createReminder({
        agentName,
        prompt: 'Pending A',
        cadenceMinutes: 10,
      });
      const pendingB = rDb.createReminder({
        agentName,
        prompt: 'Pending B',
        cadenceMinutes: 15,
      });

      const completed = Array.from({ length: 6 }, (_, idx) => {
        const reminder = rDb.createReminder({
          agentName,
          prompt: `Completed ${idx + 1}`,
          cadenceMinutes: 20,
        });
        rDb.completeReminder(reminder.id);
        rDb.rawDb.prepare('UPDATE reminders SET completed_at = ? WHERE id = ?').run(
          `2026-03-13T12:00:0${idx}Z`,
          reminder.id,
        );
        return reminder;
      });

      const listed = rDb.listReminders(agentName);
      // completed[1..5] in reverse (most-recently-completed first); index 0 is
      // dropped from the listing window. slice/reverse avoids indexed access
      // while preserving the exact expected ordering.
      const completedNewestFirst = completed.slice(1).reverse().map(r => r.id);
      assert.deepEqual(
        listed.map(r => r.id),
        [
          pendingA.id,
          pendingB.id,
          ...completedNewestFirst,
        ],
      );
      assert.ok(listed.every(r => r.agentName === agentName));
      assert.equal(listed.filter(r => r.status === 'completed').length, 5);
      const oldestCompleted = completed[0];
      assert.ok(oldestCompleted !== undefined);
      assert.ok(!listed.some(r => r.id === oldestCompleted.id));
    });

    it('deleteReminder removes it', () => {
      const r = rDb.createReminder({
        agentName: 'rem-agent-a',
        prompt: 'Will delete',
        cadenceMinutes: 10,
      });
      assert.ok(rDb.getReminder(r.id));
      assert.equal(rDb.deleteReminder(r.id), true);
      assert.equal(rDb.getReminder(r.id), undefined);
      assert.equal(rDb.deleteReminder(r.id), false);
    });

    it('swapReminderOrder swaps two reminders', () => {
      const r1 = rDb.createReminder({
        agentName: 'rem-agent-b',
        prompt: 'Swap A',
        cadenceMinutes: 10,
      });
      const r2 = rDb.createReminder({
        agentName: 'rem-agent-b',
        prompt: 'Swap B',
        cadenceMinutes: 10,
      });

      const origOrder1 = r1.sortOrder;
      const origOrder2 = r2.sortOrder;

      assert.equal(rDb.swapReminderOrder(r1.id, r2.id), true);

      const updated1 = rDb.getReminder(r1.id)!;
      const updated2 = rDb.getReminder(r2.id)!;
      assert.equal(updated1.sortOrder, origOrder2);
      assert.equal(updated2.sortOrder, origOrder1);
    });

    it('swapReminderOrder fails for different agents', () => {
      const rA = rDb.createReminder({
        agentName: 'rem-agent-a',
        prompt: 'Agent A',
        cadenceMinutes: 10,
      });
      const rB = rDb.createReminder({
        agentName: 'rem-agent-b',
        prompt: 'Agent B',
        cadenceMinutes: 10,
      });
      assert.equal(rDb.swapReminderOrder(rA.id, rB.id), false);
    });

    it('getTopReminder returns lowest sort_order pending', () => {
      // Create a fresh agent with known state
      rDb.createAgent({ name: 'rem-agent-top', engine: 'claude', cwd: '/tmp' });
      const first = rDb.createReminder({
        agentName: 'rem-agent-top',
        prompt: 'First',
        cadenceMinutes: 5,
      });
      rDb.createReminder({
        agentName: 'rem-agent-top',
        prompt: 'Second',
        cadenceMinutes: 5,
      });

      const top = rDb.getTopReminder('rem-agent-top');
      assert.ok(top);
      assert.equal(top!.id, first.id);
      assert.equal(top!.prompt, 'First');
    });

    it('listDueReminders returns reminders where cadence elapsed', () => {
      rDb.createAgent({ name: 'rem-agent-due', engine: 'claude', cwd: '/tmp' });
      const r = rDb.createReminder({
        agentName: 'rem-agent-due',
        prompt: 'Due reminder',
        cadenceMinutes: 5,
      });

      // Never delivered → should be due
      const due = rDb.listDueReminders();
      assert.ok(due.some(d => d.id === r.id));
    });

    it('listDueReminders skips recently delivered', () => {
      rDb.createAgent({ name: 'rem-agent-recent', engine: 'claude', cwd: '/tmp' });
      const r = rDb.createReminder({
        agentName: 'rem-agent-recent',
        prompt: 'Recent reminder',
        cadenceMinutes: 5,
      });

      // Mark as just delivered
      rDb.updateReminderDelivery(r.id);

      const due = rDb.listDueReminders();
      assert.ok(!due.some(d => d.id === r.id));
    });

    it('listDueReminders skips completed reminders', () => {
      rDb.createAgent({ name: 'rem-agent-done', engine: 'claude', cwd: '/tmp' });
      const r = rDb.createReminder({
        agentName: 'rem-agent-done',
        prompt: 'Completed reminder',
        cadenceMinutes: 5,
      });
      rDb.completeReminder(r.id);

      const due = rDb.listDueReminders();
      assert.ok(!due.some(d => d.id === r.id));
    });
  });

  describe('captured variables', () => {
    it('defaults capturedVars to null on new agent', () => {
      const agent = db.createAgent({
        name: 'capture-test-1',
        engine: 'claude',
        cwd: '/tmp/test',
      });
      assert.equal(agent.capturedVars, null);
    });

    it('stores and retrieves a captured variable', () => {
      db.createAgent({
        name: 'capture-test-2',
        engine: 'claude',
        cwd: '/tmp/test',
      });
      db.updateAgentCapturedVar('capture-test-2', 'SESSION_ID', 'abc-123');
      const agent = db.getAgent('capture-test-2')!;
      assert.deepEqual(agent.capturedVars, { SESSION_ID: 'abc-123' });
    });

    it('merges multiple captured variables', () => {
      db.createAgent({
        name: 'capture-test-3',
        engine: 'claude',
        cwd: '/tmp/test',
      });
      db.updateAgentCapturedVar('capture-test-3', 'SESSION_ID', 'sess-1');
      db.updateAgentCapturedVar('capture-test-3', 'BUILD_ID', 'build-42');
      const agent = db.getAgent('capture-test-3')!;
      assert.deepEqual(agent.capturedVars, { SESSION_ID: 'sess-1', BUILD_ID: 'build-42' });
    });

    it('overwrites existing captured variable', () => {
      db.createAgent({
        name: 'capture-test-4',
        engine: 'claude',
        cwd: '/tmp/test',
      });
      db.updateAgentCapturedVar('capture-test-4', 'SESSION_ID', 'old-id');
      db.updateAgentCapturedVar('capture-test-4', 'SESSION_ID', 'new-id');
      const agent = db.getAgent('capture-test-4')!;
      assert.deepEqual(agent.capturedVars, { SESSION_ID: 'new-id' });
    });

    it('preserves capturedVars through upsertAgentFromPersona', () => {
      db.createAgent({
        name: 'capture-test-5',
        engine: 'claude',
        cwd: '/tmp/test',
      });
      db.updateAgentCapturedVar('capture-test-5', 'SESSION_ID', 'keep-me');
      // Upsert updates config fields but preserves runtime state
      db.upsertAgentFromPersona({
        name: 'capture-test-5',
        engine: 'claude',
        cwd: '/tmp/test-updated',
      });
      const agent = db.getAgent('capture-test-5')!;
      assert.deepEqual(agent.capturedVars, { SESSION_ID: 'keep-me' });
      assert.equal(agent.cwd, '/tmp/test-updated');
    });

    it('ignores update for non-existent agent', () => {
      // Should not throw
      db.updateAgentCapturedVar('non-existent-agent', 'FOO', 'bar');
    });
  });

  describe('data stores', () => {
    let sDb: Database;
    let sTmpDir: string;

    before(() => {
      sTmpDir = mkdtempSync(join(tmpdir(), 'agentic-stores-test-'));
      sDb = new Database(join(sTmpDir, 'stores.db'));
    });

    after(() => {
      sDb.close();
      rmSync(sTmpDir, { recursive: true, force: true });
    });

    it('creates and retrieves a store', () => {
      const store = sDb.createStore({ name: 'test-store', agent: 'my-agent' });
      assert.equal(store.name, 'test-store');
      assert.equal(store.agent, 'my-agent');
      assert.ok(store.createdAt);
      assert.ok(store.updatedAt);

      const retrieved = sDb.getStore('test-store');
      assert.ok(retrieved);
      assert.equal(retrieved!.name, 'test-store');
      assert.equal(retrieved!.agent, 'my-agent');
    });

    it('creates a store without agent', () => {
      const store = sDb.createStore({ name: 'no-agent-store' });
      assert.equal(store.name, 'no-agent-store');
      assert.equal(store.agent, null);
    });

    it('upserts on conflict', () => {
      sDb.createStore({ name: 'upsert-store', agent: 'first' });
      const updated = sDb.createStore({ name: 'upsert-store', agent: 'second' });
      assert.equal(updated.agent, 'second');
    });

    it('lists stores ordered by updated_at desc', () => {
      const stores = sDb.listStores();
      assert.ok(stores.length >= 2);
      assert.ok(stores.some(s => s.name === 'test-store'));
    });

    it('deletes a store', () => {
      sDb.createStore({ name: 'delete-me' });
      assert.ok(sDb.getStore('delete-me'));
      assert.equal(sDb.deleteStore('delete-me'), true);
      assert.equal(sDb.getStore('delete-me'), null);
      assert.equal(sDb.deleteStore('delete-me'), false);
    });

    it('returns null for non-existent store', () => {
      assert.equal(sDb.getStore('nonexistent'), null);
    });

    it('touchStore updates the updated_at timestamp', () => {
      sDb.createStore({ name: 'touch-test' });
      const before = sDb.getStore('touch-test')!.updatedAt;
      // Force a slight delay by setting updated_at to the past
      sDb.rawDb.prepare("UPDATE data_stores SET updated_at = '2020-01-01T00:00:00Z' WHERE name = 'touch-test'").run();
      sDb.touchStore('touch-test');
      const after = sDb.getStore('touch-test')!.updatedAt;
      assert.notEqual(after, '2020-01-01T00:00:00Z');
    });
  });

  // Carries v2 `agents.agent_group` values forward to the v3 teams schema.
  // Pre-existing groups got stranded because the v3 cutover added the new
  // tables but never seeded them from the old column.
  describe('v1 user-version migration — agent_group → teams', () => {
    it('backfills teams + memberships from existing agent_group values', () => {
      const mdir = mkdtempSync(join(tmpdir(), 'agentic-collab-mig-'));
      const path = join(mdir, 'mig.db');
      // Hand-write a "pre-migration" DB: ensure user_version is 0 and the
      // agent_group column already exists. We let Database() build the
      // schema, then we rewind user_version to 0 and insert raw rows.
      let db = new Database(path);
      db.rawDb.exec('DELETE FROM team_members; DELETE FROM teams;');
      db.rawDb.exec('PRAGMA user_version = 0');
      db.rawDb.prepare(
        "INSERT INTO agents (name, engine, cwd, agent_group, state) VALUES (?, 'claude', '/tmp', ?, 'idle')",
      ).run('alice', 'Research');
      db.rawDb.prepare(
        "INSERT INTO agents (name, engine, cwd, agent_group, state) VALUES (?, 'claude', '/tmp', ?, 'idle')",
      ).run('bob', 'Research');
      db.rawDb.prepare(
        "INSERT INTO agents (name, engine, cwd, agent_group, state) VALUES (?, 'claude', '/tmp', ?, 'idle')",
      ).run('carol', 'Ops');
      db.rawDb.prepare(
        "INSERT INTO agents (name, engine, cwd, state) VALUES (?, 'claude', '/tmp', 'idle')",
      ).run('dave'); // no group → should not show up as a member
      db.close();

      // Re-open: migrate() runs and v1 backfill should fire.
      db = new Database(path);
      const teams = db.listTeams();
      const teamNames = teams.map((t) => t.name).sort();
      assert.deepEqual(teamNames, ['Ops', 'Research']);
      const research = teams.find((t) => t.name === 'Research')!;
      const ops = teams.find((t) => t.name === 'Ops')!;
      assert.deepEqual([...research.members].sort(), ['alice', 'bob']);
      assert.deepEqual([...ops.members].sort(), ['carol']);

      // Idempotent: re-opening must NOT duplicate teams or members.
      db.close();
      db = new Database(path);
      const teams2 = db.listTeams();
      assert.equal(teams2.length, 2);
      const research2 = teams2.find((t) => t.name === 'Research')!;
      assert.deepEqual([...research2.members].sort(), ['alice', 'bob']);
      db.close();
      rmSync(mdir, { recursive: true, force: true });
    });

    it('no-op on a fresh DB with no agents', () => {
      const mdir = mkdtempSync(join(tmpdir(), 'agentic-collab-mig-fresh-'));
      const db = new Database(join(mdir, 'fresh.db'));
      assert.deepEqual(db.listTeams(), []);
      const v = db.rawDb.prepare('PRAGMA user_version').get() as { user_version: number };
      // v3 (RFC-009) drops the removed feature's tables and is the final rung
      assert.equal(v.user_version, 3);
      db.close();
      rmSync(mdir, { recursive: true, force: true });
    });
  });

  describe('files', () => {
    it('creates and retrieves a file record', () => {
      const file = db.addFile({
        id: 'test-file-id-001',
        name: 'test-document.pdf',
        size: 1024,
        mime: 'application/pdf',
        path: '/data/files/test-file-id-001.pdf',
      });

      assert.equal(file.id, 'test-file-id-001');
      assert.equal(file.name, 'test-document.pdf');
      assert.equal(file.size, 1024);
      assert.equal(file.mime, 'application/pdf');
      assert.equal(file.path, '/data/files/test-file-id-001.pdf');
      assert.equal(file.expiresAt, null);
      assert.ok(file.createdAt);

      const retrieved = db.getFile('test-file-id-001');
      assert.deepEqual(retrieved, file);
    });

    it('creates a file with expiresAt', () => {
      const expiresAt = '2026-12-31T23:59:59Z';
      const file = db.addFile({
        id: 'test-file-id-002',
        name: 'temporary.txt',
        size: 512,
        mime: 'text/plain',
        path: '/data/files/test-file-id-002.txt',
        expiresAt,
      });

      assert.equal(file.expiresAt, expiresAt);
    });

    it('lists all files', () => {
      db.addFile({
        id: 'test-file-id-003',
        name: 'file3.json',
        size: 256,
        mime: 'application/json',
        path: '/data/files/test-file-id-003.json',
      });

      const files = db.listFiles();
      assert.ok(files.length >= 3);
      const ids = files.map((f) => f.id);
      assert.ok(ids.includes('test-file-id-001'));
      assert.ok(ids.includes('test-file-id-002'));
      assert.ok(ids.includes('test-file-id-003'));
    });

    it('deletes a file record', () => {
      const file = db.addFile({
        id: 'test-file-id-delete',
        name: 'to-be-deleted.txt',
        size: 100,
        mime: 'text/plain',
        path: '/data/files/test-file-id-delete.txt',
      });

      const deleted = db.deleteFile(file.id);
      assert.equal(deleted, true);

      const retrieved = db.getFile('test-file-id-delete');
      assert.equal(retrieved, null);

      // Deleting again returns false
      const deletedAgain = db.deleteFile('test-file-id-delete');
      assert.equal(deletedAgain, false);
    });

    it('returns null for non-existent file', () => {
      const file = db.getFile('non-existent-id');
      assert.equal(file, null);
    });
  });

  describe('dashboard messages with fileIds', () => {
    it('creates a message with file IDs attached', () => {
      const msg = db.addDashboardMessage('test-agent', 'to_agent', 'Hello with files', {
        topic: 'test-topic',
        sourceAgent: 'dashboard',
        targetAgent: 'test-agent',
        fileIds: ['file-001', 'file-002'],
      });

      assert.deepEqual(msg.fileIds, ['file-001', 'file-002']);
    });

    it('creates a message without file IDs', () => {
      const msg = db.addDashboardMessage('test-agent', 'to_agent', 'Hello without files', {
        topic: 'test-topic',
        sourceAgent: 'dashboard',
        targetAgent: 'test-agent',
      });

      assert.equal(msg.fileIds, null);
    });

    it('creates a message with empty file IDs array', () => {
      const msg = db.addDashboardMessage('test-agent', 'to_agent', 'Hello with empty files', {
        topic: 'test-topic',
        sourceAgent: 'dashboard',
        targetAgent: 'test-agent',
        fileIds: [],
      });

      // Empty array should be stored as null
      assert.equal(msg.fileIds, null);
    });
  });

  // RFC-008: encrypted Telegram bot-token store. The DB layer stores ONLY
  // ciphertext; these tests treat the blob as opaque (encryption is covered in
  // secret-crypto.test.ts) and only verify storage semantics.
  describe('agent_telegram_tokens', () => {
    it('set/get/has/delete round-trip', () => {
      const agent = 'tg-agent-1';
      const blob = 'opaque-ciphertext-blob-aaaa';

      assert.equal(db.hasTelegramToken(agent), false);
      assert.equal(db.getTelegramTokenCiphertext(agent), null);

      db.setTelegramToken(agent, blob);
      assert.equal(db.hasTelegramToken(agent), true);
      assert.equal(db.getTelegramTokenCiphertext(agent), blob);

      db.deleteTelegramToken(agent);
      assert.equal(db.hasTelegramToken(agent), false);
      assert.equal(db.getTelegramTokenCiphertext(agent), null);
    });

    it('upserts (second set overwrites)', () => {
      const agent = 'tg-agent-2';
      db.setTelegramToken(agent, 'first-blob');
      db.setTelegramToken(agent, 'second-blob');
      assert.equal(db.getTelegramTokenCiphertext(agent), 'second-blob');
    });

    it('stores ciphertext, NOT the plaintext token', () => {
      // Mirror what the route layer does: encrypt, then store. The raw row must
      // never contain the plaintext token.
      const agent = 'tg-agent-3';
      const plaintext = 'PLAINTEXT-BOT-TOKEN-do-not-store';
      const ciphertext = 'enc::' + Buffer.from(plaintext).toString('base64') + '::wrapped';
      db.setTelegramToken(agent, ciphertext);

      const stored = db.getTelegramTokenCiphertext(agent);
      assert.equal(stored, ciphertext);
      assert.notEqual(stored, plaintext);

      // The raw SQLite row also must not contain the plaintext anywhere.
      const row = db.rawDb
        .prepare('SELECT * FROM agent_telegram_tokens WHERE agent_name = ?')
        .get(agent) as Record<string, unknown>;
      assert.ok(!JSON.stringify(row).includes(plaintext));
    });

    it('delete is a no-op for an unknown agent', () => {
      assert.doesNotThrow(() => db.deleteTelegramToken('no-such-agent'));
    });
  });
});
