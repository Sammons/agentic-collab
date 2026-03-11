import type { Database } from './database.ts';
import type { PendingMessage } from '../shared/types.ts';

export type ReminderDispatcherOptions = {
  db: Database;
  onQueueUpdate?: (message: PendingMessage) => void;
  intervalMs?: number;
};

export class ReminderDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly onQueueUpdate: ((message: PendingMessage) => void) | undefined;
  private readonly intervalMs: number;

  constructor(opts: ReminderDispatcherOptions) {
    this.db = opts.db;
    this.onQueueUpdate = opts.onQueueUpdate;
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log(`[reminders] Starting dispatcher (every ${this.intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(): void {
    const due = this.db.listDueReminders();
    for (const reminder of due) {
      const creator = reminder.createdBy || 'system';
      const envelope = `[reminder #${reminder.id} from ${creator}]: ${reminder.prompt}\nMark done when complete: collab reminder done ${reminder.id}`;
      const msg = this.db.enqueueMessage({
        sourceAgent: null,
        targetAgent: reminder.agentName,
        envelope,
      });
      this.db.updateReminderDelivery(reminder.id);
      if (this.onQueueUpdate) {
        this.onQueueUpdate(msg);
      }
    }
  }
}
