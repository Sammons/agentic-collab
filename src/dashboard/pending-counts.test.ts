import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Reminder } from '../shared/types.ts';
import { countPendingReminders, remindersFromEvent } from './pending-counts.ts';

function reminder(overrides: Partial<Reminder>): Reminder {
  return {
    id: 1,
    agentName: 'agent-a',
    createdBy: null,
    prompt: 'check the build',
    cadenceMinutes: 30,
    skipIfActive: false,
    sortOrder: 0,
    status: 'pending',
    lastDeliveredAt: null,
    completedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('countPendingReminders', () => {
  it('counts only pending rows in a mixed list', () => {
    const rows = [
      reminder({ id: 1, status: 'pending' }),
      reminder({ id: 2, status: 'completed', completedAt: '2026-06-11T01:00:00.000Z' }),
      reminder({ id: 3, status: 'pending' }),
      reminder({ id: 4, status: 'completed', completedAt: '2026-06-11T02:00:00.000Z' }),
    ];
    assert.equal(countPendingReminders(rows), 2);
  });

  it('returns 0 for an empty list', () => {
    assert.equal(countPendingReminders([]), 0);
  });

  it('returns 0 when every reminder is completed', () => {
    const rows = [
      reminder({ id: 1, status: 'completed' }),
      reminder({ id: 2, status: 'completed' }),
    ];
    assert.equal(countPendingReminders(rows), 0);
  });
});

describe('remindersFromEvent', () => {
  it('extracts the reminders array from a well-formed ws:reminder_update payload', () => {
    const rows = [reminder({ id: 7 })];
    const detail = { type: 'reminder_update', reminders: rows };
    assert.deepEqual(remindersFromEvent(detail), rows);
  });

  it('returns an empty array payload as-is (zero reminders is a valid update)', () => {
    assert.deepEqual(remindersFromEvent({ type: 'reminder_update', reminders: [] }), []);
  });

  it('returns null when detail is undefined', () => {
    assert.equal(remindersFromEvent(undefined), null);
  });

  it('returns null when detail is null', () => {
    assert.equal(remindersFromEvent(null), null);
  });

  it('returns null when detail is not an object', () => {
    assert.equal(remindersFromEvent('reminder_update'), null);
  });

  it('returns null when the reminders key is missing', () => {
    assert.equal(remindersFromEvent({ type: 'reminder_update' }), null);
  });

  it('returns null when reminders is not an array', () => {
    assert.equal(remindersFromEvent({ type: 'reminder_update', reminders: { id: 1 } }), null);
  });
});
