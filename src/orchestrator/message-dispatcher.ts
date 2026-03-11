/**
 * Event-driven message delivery.
 *
 * Sole owner of message delivery — the health monitor does not participate.
 * Triggered immediately on enqueue via tryDeliver(agentName), with a drain
 * loop (6s interval, max 20 attempts) for batch delivery.
 *
 * Delivery requires the agent to be idle (waiting_for_input). If the agent
 * isn't idle, the message stays queued for the next drain attempt.
 *
 * Race safety: the draining set prevents concurrent drain loops for the
 * same agent. A drain loop owns exclusive delivery rights until it finishes
 * or exhausts its attempts.
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
  /** Guards against concurrent drain loops for the same agent. */
  private readonly draining = new Set<string>();
  private static readonly DRAIN_INTERVAL_MS = 6000;
  private static readonly DRAIN_MAX_ATTEMPTS = 20;
  private static readonly STALE_ATTEMPT_TIMEOUT_S = 60;

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
   * If a message was delivered and more are queued, schedules a drain
   * loop to retry delivery every 6s until the queue is empty.
   */
  async tryDeliver(agentName: string): Promise<boolean> {
    // Recover any stale delivery attempts before trying
    this.db.resetStaleAttempts(MessageDispatcher.STALE_ATTEMPT_TIMEOUT_S);

    const agent = this.db.getAgent(agentName);
    if (!agent || !agent.proxyId || !canSuspend(agent)) return false;

    // Engines that buffer pasted input (e.g. Claude) can receive messages while active.
    // Others must be idle (waiting_for_input) before delivery.
    const adapter = getAdapter(agent.engine);
    if (!adapter.canDeliverWhileActive) {
      const isIdle = await this.checkAgentIdle(agent);
      if (!isIdle) {
        // Agent not idle — start a drain loop to retry later
        this.scheduleDrain(agentName);
        return false;
      }
    }

    const delivered = await this.deliverNextMessage(agentName);
    if (delivered) {
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

    const remaining = this.db.getDeliverableMessages(agentName);
    if (remaining.length === 0) return;

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

        const adapter = getAdapter(agent.engine);
        let canDeliver = true;
        if (!adapter.canDeliverWhileActive) {
          canDeliver = await this.checkAgentIdle(agent);
        }

        if (canDeliver) {
          await this.deliverNextMessage(agentName);
        }

        // Check if more messages remain
        const still = this.db.getDeliverableMessages(agentName);
        if (still.length > 0 && attempt + 1 < MessageDispatcher.DRAIN_MAX_ATTEMPTS) {
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
