import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database.ts';
import { ReminderDispatcher } from './reminder-dispatcher.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Minimal mock that records tryDeliver calls */
function mockMessageDispatcher(): MessageDispatcher & { deliverCalls: string[] } {
  const deliverCalls: string[] = [];
  return {
    deliverCalls,
    tryDeliver: async (agentName: string) => { deliverCalls.push(agentName); return false; },
    stop: () => {},
  } as unknown as MessageDispatcher & { deliverCalls: string[] };
}

describe('ReminderDispatcher', () => {
  let db: Database;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-reminder-dispatch-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.createAgent({ name: 'dispatch-agent', engine: 'claude', cwd: '/tmp' });
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tick enqueues message for due reminder', () => {
    const r = db.createReminder({
      agentName: 'dispatch-agent',
      createdBy: 'ben',
      prompt: 'Check the logs',
      cadenceMinutes: 5,
    });

    const queued: unknown[] = [];
    const mock = mockMessageDispatcher();
    const dispatcher = new ReminderDispatcher({
      db,
      messageDispatcher: mock,
      onQueueUpdate: (msg) => queued.push(msg),
    });

    dispatcher.tick();

    assert.equal(queued.length, 1);
    assert.deepEqual(mock.deliverCalls, ['dispatch-agent']);
    const pending = db.getDeliverableMessages('dispatch-agent');
    assert.ok(pending.some(m => m.envelope.includes('Check the logs')));
    assert.ok(pending.some(m => m.envelope.includes(`reminder #${r.id}`)));
    assert.ok(pending.some(m => m.envelope.includes('from ben')));

    // Clean up
    db.deleteReminder(r.id);
  });

  it('tick skips reminders not yet due', () => {
    const r = db.createReminder({
      agentName: 'dispatch-agent',
      prompt: 'Not due yet',
      cadenceMinutes: 60,
    });

    // Mark as just delivered
    db.updateReminderDelivery(r.id);

    const queued: unknown[] = [];
    const dispatcher = new ReminderDispatcher({
      db,
      messageDispatcher: mockMessageDispatcher(),
      onQueueUpdate: (msg) => queued.push(msg),
    });

    dispatcher.tick();

    // Should not have enqueued anything for this reminder
    const pending = db.getDeliverableMessages('dispatch-agent');
    assert.ok(!pending.some(m => m.envelope.includes('Not due yet')));

    // Clean up
    db.deleteReminder(r.id);
  });

  it('tick updates last_delivered_at after delivery', () => {
    const r = db.createReminder({
      agentName: 'dispatch-agent',
      prompt: 'Track delivery time',
      cadenceMinutes: 5,
    });

    assert.equal(db.getReminder(r.id)!.lastDeliveredAt, null);

    const dispatcher = new ReminderDispatcher({ db, messageDispatcher: mockMessageDispatcher() });
    dispatcher.tick();

    const updated = db.getReminder(r.id)!;
    assert.ok(updated.lastDeliveredAt !== null);

    // Clean up
    db.deleteReminder(r.id);
  });

  it('start/stop manage the timer', () => {
    const dispatcher = new ReminderDispatcher({
      db,
      messageDispatcher: mockMessageDispatcher(),
      intervalMs: 100_000, // long interval so it doesn't tick during test
    });

    dispatcher.start();
    // Calling start again is a no-op
    dispatcher.start();

    dispatcher.stop();
    // Calling stop again is safe
    dispatcher.stop();
  });

  it('completing top reminder makes next one deliverable immediately', () => {
    db.createAgent({ name: 'dispatch-agent-seq', engine: 'claude', cwd: '/tmp' });

    const r1 = db.createReminder({
      agentName: 'dispatch-agent-seq',
      prompt: 'First task',
      cadenceMinutes: 5,
    });
    const r2 = db.createReminder({
      agentName: 'dispatch-agent-seq',
      prompt: 'Second task',
      cadenceMinutes: 5,
    });

    // First tick should deliver r1 (top reminder)
    const dispatcher = new ReminderDispatcher({ db, messageDispatcher: mockMessageDispatcher() });
    dispatcher.tick();

    const afterTick1 = db.getReminder(r1.id)!;
    assert.ok(afterTick1.lastDeliveredAt !== null);

    // r2 is not the top reminder, so it should not have been delivered
    const afterTick1R2 = db.getReminder(r2.id)!;
    assert.equal(afterTick1R2.lastDeliveredAt, null);

    // Complete r1 — now r2 becomes the top reminder
    db.completeReminder(r1.id);

    // r2 has never been delivered, so it should be due now
    const due = db.listDueReminders();
    assert.ok(due.some(d => d.id === r2.id));

    // Clean up
    db.deleteReminder(r1.id);
    db.deleteReminder(r2.id);
  });
});
