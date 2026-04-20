/**
 * Event-driven message delivery.
 *
 * Sole owner of message delivery — the health monitor does not participate.
 * Triggered immediately on enqueue via tryDeliver(agentName), with a drain
 * loop (6s interval, max 20 attempts) for batch delivery.
 *
 * Delivery is immediate when an agent can accept lifecycle actions. The
 * dispatcher does not gate on pane capture or persisted idle state.
 *
 * Race safety: the draining set prevents concurrent drain loops for the
 * same agent. A drain loop owns exclusive delivery rights until it finishes
 * or exhausts its attempts.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, PendingMessage, DashboardMessage } from '../shared/types.ts';
import { canSuspend } from '../shared/agent-entity.ts';
import { deliverToAgent, type LifecycleContext } from './lifecycle.ts';

export type MessageDispatcherOptions = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  onQueueUpdate?: (message: PendingMessage) => void;
  onDashboardMessage?: (message: DashboardMessage) => void;
  onMessageDelivered?: (agentName: string) => void;
};

export class MessageDispatcher {
  private readonly db: Database;
  private readonly locks: LockManager;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly orchestratorHost: string;
  private readonly onQueueUpdate: (message: PendingMessage) => void;
  private readonly onDashboardMessage: (message: DashboardMessage) => void;
  private readonly onMessageDelivered: (agentName: string) => void;
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Guards against concurrent drain loops for the same agent. */
  private readonly draining = new Set<string>();
  /**
   * Cool-down timestamps per agent (Race 2 fix).
   * After compact/interrupt operations, delivery waits for the agent to
   * process the command before sending messages to avoid interleaving.
   */
  private readonly coolDownUntil = new Map<string, number>();
  private static readonly DRAIN_INTERVAL_MS = 6000;
  private static readonly DRAIN_MAX_ATTEMPTS = 20;
  private static readonly STALE_ATTEMPT_TIMEOUT_S = 60;
  /** Cool-down period after lifecycle operations (ms). */
  static readonly LIFECYCLE_COOLDOWN_MS = 300;

  constructor(opts: MessageDispatcherOptions) {
    this.db = opts.db;
    this.locks = opts.locks;
    this.proxyDispatch = opts.proxyDispatch;
    this.orchestratorHost = opts.orchestratorHost;
    this.onQueueUpdate = opts.onQueueUpdate ?? (() => {});
    this.onDashboardMessage = opts.onDashboardMessage ?? (() => {});
    this.onMessageDelivered = opts.onMessageDelivered ?? (() => {});
  }

  /**
   * Attempt immediate delivery of pending messages to an agent.
   * Called on enqueue from API routes (event-driven, sub-second).
   *
   * Returns true if a message was delivered, false otherwise.
   * Schedules a drain loop on both success (for remaining messages) and
   * failure (to retry delivery) — preventing fire-and-forget loss.
   */
  async tryDeliver(agentName: string): Promise<boolean> {
    // Recover any stale delivery attempts before trying
    this.db.resetStaleAttempts(MessageDispatcher.STALE_ATTEMPT_TIMEOUT_S);

    const agent = this.db.getAgent(agentName);
    if (!agent || !agent.proxyId || !canSuspend(agent)) {
      console.log(`[dispatcher] Cannot deliver to ${agentName}: ${!agent ? 'not found' : !agent.proxyId ? 'no proxy' : `state=${agent.state}`}`);
      // Still schedule drain if there are pending messages — agent may become available
      const pending = this.db.getDeliverableMessages(agentName);
      if (pending.length > 0) {
        this.scheduleDrain(agentName);
      }
      return false;
    }

    const delivered = await this.deliverNextMessage(agentName);
    // Schedule drain on both success (more messages) and failure (retry)
    // This prevents fire-and-forget error swallowing (Race 1)
    // Use hasPendingMessages instead of getDeliverableMessages to include
    // messages with future next_attempt_at (in backoff state)
    if (this.db.hasPendingMessages(agentName)) {
      this.scheduleDrain(agentName);
    }
    return delivered;
  }

  /**
   * Sweep all agents with pending messages and trigger delivery.
   * Called at startup to resume delivery of messages queued before restart.
   */
  async drainPending(): Promise<void> {
    const agents = this.db.agentsWithPendingMessages();
    if (agents.length === 0) return;
    console.log(`[dispatcher] Startup sweep: ${agents.length} agent(s) with pending messages`);
    for (const agentName of agents) {
      this.tryDeliver(agentName).catch((err) => {
        console.error(`[dispatcher] Startup delivery failed for ${agentName}:`, (err as Error).message);
      });
    }
  }

  /**
   * Clean up drain timers on shutdown.
   */
  stop(): void {
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer);
    }
    this.drainTimers.clear();
    this.draining.clear();
    this.coolDownUntil.clear();
  }

  /**
   * Signal that a lifecycle operation completed for an agent.
   * Delivery will wait for LIFECYCLE_COOLDOWN_MS before sending messages
   * to avoid command interleaving in the agent's tmux pane (Race 2 fix).
   */
  signalLifecycleOp(agentName: string): void {
    const coolDownEnd = Date.now() + MessageDispatcher.LIFECYCLE_COOLDOWN_MS;
    this.coolDownUntil.set(agentName, coolDownEnd);
  }

  /**
   * Wait for any active cool-down period to expire.
   * Returns immediately if no cool-down is active.
   */
  private async waitForCoolDown(agentName: string): Promise<void> {
    const coolDownEnd = this.coolDownUntil.get(agentName);
    if (!coolDownEnd) return;

    const now = Date.now();
    if (now >= coolDownEnd) {
      this.coolDownUntil.delete(agentName);
      return;
    }

    const waitMs = coolDownEnd - now;
    console.log(`[dispatcher] ${agentName}: waiting ${waitMs}ms for lifecycle cool-down`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.coolDownUntil.delete(agentName);
  }

  /**
   * Schedule a drain loop to deliver remaining queued messages.
   * Retries every DRAIN_INTERVAL_MS until queue is empty or max attempts reached.
   *
   * Race-safe: the draining set prevents concurrent drain loops for the same agent.
   * The flag is held for the entire drain lifecycle (across all attempts), not just
   * while a single delivery is in-flight.
   */
  private scheduleDrain(agentName: string, attempt: number = 0): void {
    if (this.draining.has(agentName)) return; // another drain loop is active
    if (attempt >= MessageDispatcher.DRAIN_MAX_ATTEMPTS) return;

    // Check for any pending messages (including those with backoff)
    // Don't bail out just because no messages are immediately deliverable
    if (!this.db.hasPendingMessages(agentName)) return;

    // Claim exclusive drain rights
    this.draining.add(agentName);

    const timer = setTimeout(async () => {
      this.drainTimers.delete(agentName);
      try {
        // Recover stale attempts before each drain cycle
        this.db.resetStaleAttempts(MessageDispatcher.STALE_ATTEMPT_TIMEOUT_S);

        const agent = this.db.getAgent(agentName);
        if (!agent || !agent.proxyId || !canSuspend(agent)) {
          this.draining.delete(agentName);
          return;
        }
        await this.deliverNextMessage(agentName);

        // Check if more messages remain (including those with backoff)
        if (this.db.hasPendingMessages(agentName) && attempt + 1 < MessageDispatcher.DRAIN_MAX_ATTEMPTS) {
          // Release drain lock, then re-schedule
          this.draining.delete(agentName);
          this.scheduleDrain(agentName, attempt + 1);
        } else {
          this.draining.delete(agentName);
        }
      } catch (err) {
        console.error(`[dispatcher] Drain error for ${agentName}:`, (err as Error).message);
        this.draining.delete(agentName);
      }
    }, MessageDispatcher.DRAIN_INTERVAL_MS);
    this.drainTimers.set(agentName, timer);
  }

  /**
   * Deliver the next pending message to an agent.
   * One message per call to avoid flooding.
   */
  private async deliverNextMessage(agentName: string): Promise<boolean> {
    // Wait for any lifecycle cool-down before delivery (Race 2 fix)
    await this.waitForCoolDown(agentName);

    const messages = this.db.getDeliverableMessages(agentName);
    if (messages.length === 0) return false;

    const message = messages[0]!;
    this.db.markAttemptStarted(message.id);

    const agent = this.db.getAgent(agentName);
    if (!agent || !agent.proxyId) {
      this.db.markAttemptFailed(message.id, 'Agent not available or has no proxy');
      const updated = this.db.getPendingMessageById(message.id);
      if (updated) {
        this.onQueueUpdate(updated);
        if (updated.status === 'failed') {
          this.autoReplyToSender(updated);
        }
      }
      return false;
    }

    const lifecycleCtx = this.makeLifecycleCtx();
    const error = await deliverToAgent(lifecycleCtx, agent, message.envelope);

    if (error) {
      this.db.markAttemptFailed(message.id, error);
      const updated = this.db.getPendingMessageById(message.id);
      if (updated) {
        this.onQueueUpdate(updated);
        if (updated.status === 'failed') {
          this.autoReplyToSender(updated);
        }
      }
      return false;
    }

    this.db.markMessageDelivered(message.id);
    const updated = this.db.getPendingMessageById(message.id);
    if (updated) {
      this.onQueueUpdate(updated);
    }
    this.onMessageDelivered(agentName);
    return true;
  }

  /**
   * Auto-reply to sender when delivery permanently fails.
   */
  private autoReplyToSender(message: PendingMessage): void {
    const failureText = `[system] Delivery to ${message.targetAgent} failed after ${message.retryCount} attempts: ${message.error ?? 'unknown error'}`;

    try {
      if (message.sourceAgent) {
        const reply = this.db.enqueueMessage({
          sourceAgent: null,
          targetAgent: message.sourceAgent,
          envelope: failureText,
        });
        this.onQueueUpdate(reply);
      } else {
        const msg = this.db.addDashboardMessage(message.targetAgent, 'from_agent', failureText, { topic: 'system' });
        this.onDashboardMessage(msg);
      }
    } catch (err) {
      console.error(`[dispatcher] Failed to enqueue auto-reply for ${message.targetAgent}:`, (err as Error).message);
    }
  }

  private makeLifecycleCtx(): LifecycleContext {
    return {
      db: this.db,
      locks: this.locks,
      proxyDispatch: this.proxyDispatch,
      orchestratorHost: this.orchestratorHost,
    };
  }
}
