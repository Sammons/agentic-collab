/**
 * Event-driven message delivery.
 *
 * Replaces the poll-based delivery that lived inside HealthMonitor.
 * Exposes tryDeliver(agentName) which can be called immediately on enqueue
 * (sub-second delivery) or from the health monitor poll as a fallback.
 *
 * Delivery requires the agent to be idle (waiting_for_input). If the agent
 * isn't idle, the message stays queued for the next attempt.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord, PendingMessage, DashboardMessage } from '../shared/types.ts';
import { sessionName, canSuspend } from '../shared/agent-entity.ts';
import { getAdapter } from './adapters/index.ts';
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
  private static readonly DRAIN_INTERVAL_MS = 3000;
  private static readonly DRAIN_MAX_ATTEMPTS = 20;

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
   * Called on enqueue (event-driven) and from health monitor poll (fallback).
   *
   * Returns true if a message was delivered, false otherwise.
   * If a message was delivered and more are queued, schedules a drain
   * timer to retry delivery every 3s until the queue is empty.
   */
  async tryDeliver(agentName: string): Promise<boolean> {
    const agent = this.db.getAgent(agentName);
    if (!agent || !agent.proxyId || !canSuspend(agent)) return false;

    // Check if agent is waiting for input before attempting delivery
    const isIdle = await this.checkAgentIdle(agent);
    if (!isIdle) return false;

    const delivered = await this.deliverNextMessage(agentName);
    if (delivered) {
      this.scheduleDrain(agentName);
    }
    return delivered;
  }

  /**
   * Clean up drain timers on shutdown.
   */
  stop(): void {
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer);
    }
    this.drainTimers.clear();
  }

  /**
   * Schedule a drain attempt to deliver remaining queued messages.
   * Retries every DRAIN_INTERVAL_MS until queue is empty or max attempts reached.
   */
  private scheduleDrain(agentName: string, attempt: number = 0): void {
    if (this.drainTimers.has(agentName)) return; // already draining
    if (attempt >= MessageDispatcher.DRAIN_MAX_ATTEMPTS) return;

    const remaining = this.db.getDeliverableMessages(agentName);
    if (remaining.length === 0) return;

    const timer = setTimeout(async () => {
      this.drainTimers.delete(agentName);
      try {
        const delivered = await this.tryDeliver(agentName);
        if (delivered) {
          this.scheduleDrain(agentName, attempt + 1);
        } else {
          // Agent not idle yet — retry
          const still = this.db.getDeliverableMessages(agentName);
          if (still.length > 0) {
            this.scheduleDrain(agentName, attempt + 1);
          }
        }
      } catch (err) {
        console.error(`[dispatcher] Drain error for ${agentName}:`, (err as Error).message);
      }
    }, MessageDispatcher.DRAIN_INTERVAL_MS);
    this.drainTimers.set(agentName, timer);
  }

  /**
   * Deliver without checking idle state — for use when the health monitor
   * has already confirmed the agent is waiting_for_input.
   */
  async deliverIfReady(agentName: string): Promise<boolean> {
    return this.deliverNextMessage(agentName);
  }

  /**
   * Capture pane output and check if agent is waiting for input.
   */
  private async checkAgentIdle(agent: AgentRecord): Promise<boolean> {
    if (!agent.proxyId) return false;

    const captureResult = await this.proxyDispatch(agent.proxyId, {
      action: 'capture',
      sessionName: sessionName(agent),
      lines: 50,
    });

    if (!captureResult.ok) return false;

    const paneOutput = (captureResult.data as string) ?? '';
    const adapter = getAdapter(agent.engine);
    return adapter.detectIdleState(paneOutput) === 'waiting_for_input';
  }

  /**
   * Deliver the next pending message to an agent.
   * One message per call to avoid flooding.
   */
  private async deliverNextMessage(agentName: string): Promise<boolean> {
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
        const msg = this.db.addDashboardMessage(message.targetAgent, 'from_agent', failureText);
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
