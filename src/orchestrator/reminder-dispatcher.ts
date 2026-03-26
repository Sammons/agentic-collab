import type { Database } from './database.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { PendingMessage, DashboardMessage } from '../shared/types.ts';

export type ReminderDispatcherOptions = {
  db: Database;
  messageDispatcher: MessageDispatcher;
  onQueueUpdate?: (message: PendingMessage) => void;
  onDashboardMessage?: (message: DashboardMessage) => void;
  intervalMs?: number;
};

export class ReminderDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly messageDispatcher: MessageDispatcher;
  private readonly onQueueUpdate: ((message: PendingMessage) => void) | undefined;
  private readonly onDashboardMessage: ((message: DashboardMessage) => void) | undefined;
  private readonly intervalMs: number;

  constructor(opts: ReminderDispatcherOptions) {
    this.db = opts.db;
    this.messageDispatcher = opts.messageDispatcher;
    this.onQueueUpdate = opts.onQueueUpdate;
    this.onDashboardMessage = opts.onDashboardMessage;
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

      // Show reminder in dashboard thread
      const displayMessage = `Reminder #${reminder.id}: ${reminder.prompt}`;
      const dashMsg = this.db.addDashboardMessage(reminder.agentName, 'to_agent', displayMessage, {
        topic: 'reminder',
        sourceAgent: creator,
        targetAgent: reminder.agentName,
      });

      const msg = this.db.enqueueMessage({
        sourceAgent: null,
        targetAgent: reminder.agentName,
        envelope,
      });
      this.db.linkDashboardMessageToQueue(dashMsg.id, msg.id);
      this.db.updateReminderDelivery(reminder.id);

      if (this.onDashboardMessage) {
        this.onDashboardMessage(dashMsg);
      }
      if (this.onQueueUpdate) {
        this.onQueueUpdate(msg);
      }
      // Trigger delivery — without this, messages sit in the queue forever
      this.messageDispatcher.tryDeliver(reminder.agentName).catch((err) => {
        console.error(`[reminders] Delivery trigger failed for ${reminder.agentName}:`, (err as Error).message);
      });
    }
  }
}
