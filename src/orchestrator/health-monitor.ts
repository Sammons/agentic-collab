/**
 * Health monitor: polls agents every 30s.
 * Priority chain: reload > compact > suspend > ping.
 * Uses engine adapters for idle-state and context-% detection.
 *
 * Message delivery is handled by MessageDispatcher (event-driven).
 * The health monitor calls dispatcher.deliverIfReady() as a fallback
 * during each poll cycle for agents that are waiting_for_input.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord, PendingMessage, DashboardMessage } from '../shared/types.ts';
import { sessionName, canSuspend } from '../shared/agent-entity.ts';
import { getAdapter } from './adapters/index.ts';
import { reloadAgent, compactAgent, type LifecycleContext } from './lifecycle.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';

export type HealthMonitorOptions = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  messageDispatcher: MessageDispatcher;
  onAgentUpdate?: (agentName: string) => void;
  onQueueUpdate?: (message: PendingMessage) => void;
  onDashboardMessage?: (message: DashboardMessage) => void;
  pollIntervalMs?: number;
  autoCompactThreshold?: number; // context % to trigger compact (default 80)
  autoReloadThreshold?: number;  // context % to trigger reload (default 90)
  idleSuspendMs?: number;        // ms of idle before suspend (default 5 minutes)
};

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_COMPACT_THRESHOLD = 80;
const DEFAULT_RELOAD_THRESHOLD = 90;
const DEFAULT_IDLE_SUSPEND_MS = 5 * 60 * 1000;

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly locks: LockManager;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly orchestratorHost: string;
  private readonly messageDispatcher: MessageDispatcher;
  private readonly pollIntervalMs: number;
  private readonly autoCompactThreshold: number;
  private readonly autoReloadThreshold: number;
  private readonly idleSuspendMs: number;
  private readonly onAgentUpdate: (agentName: string) => void;
  private readonly onQueueUpdate: (message: PendingMessage) => void;
  private readonly onDashboardMessage: (message: DashboardMessage) => void;

  constructor(opts: HealthMonitorOptions) {
    this.db = opts.db;
    this.locks = opts.locks;
    this.proxyDispatch = opts.proxyDispatch;
    this.orchestratorHost = opts.orchestratorHost;
    this.messageDispatcher = opts.messageDispatcher;
    this.onAgentUpdate = opts.onAgentUpdate ?? (() => {});
    this.onQueueUpdate = opts.onQueueUpdate ?? (() => {});
    this.onDashboardMessage = opts.onDashboardMessage ?? (() => {});
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.autoCompactThreshold = opts.autoCompactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.autoReloadThreshold = opts.autoReloadThreshold ?? DEFAULT_RELOAD_THRESHOLD;
    this.idleSuspendMs = opts.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[health] Starting monitor (poll every ${this.pollIntervalMs}ms)`);
    this.timer = setInterval(() => {
      this.pollAll().catch((err) => {
        console.error('[health] Poll error:', err);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[health] Monitor stopped');
    }
  }

  /**
   * Poll all active/idle agents.
   */
  async pollAll(): Promise<void> {
    // Recover hung delivery attempts (>60s without completion)
    const staleReset = this.db.resetStaleAttempts(60);
    if (staleReset > 0) {
      console.log(`[health] Reset ${staleReset} stale delivery attempts`);
    }

    const agents = this.db.listAgents().filter(
      (a) => canSuspend(a) && a.proxyId,
    );

    for (const agent of agents) {
      try {
        await this.pollAgent(agent);
      } catch (err) {
        console.error(`[health] Error polling ${agent.name}:`, err);
      }
    }
  }

  /**
   * Poll a single agent. Priority: reload > compact > idle detection > delivery > suspend timeout.
   */
  async pollAgent(agentSnapshot: AgentRecord): Promise<void> {
    const agent = this.db.getAgent(agentSnapshot.name);
    if (!agent || !agent.proxyId || !canSuspend(agent)) return;

    const paneOutput = await this.capturePaneOutput(agent);
    if (paneOutput === null) return;

    const adapter = getAdapter(agent.engine);
    if (await this.handleContextThresholds(agent, adapter, paneOutput)) return;

    const idleState = adapter.detectIdleState(paneOutput);
    this.handleIdleTransitions(agent, idleState);

    if (idleState === 'waiting_for_input') {
      // Fallback delivery — primary delivery is event-driven via MessageDispatcher
      await this.messageDispatcher.deliverIfReady(agent.name);
    }

    this.checkIdleSuspendTimeout(agent.name);

    if (idleState === 'waiting_for_input') {
      await this.handleQueuedReload(agent.name);
    }
  }

  /**
   * Capture pane output for an agent. Returns null if capture failed
   * (agent marked as failed as a side-effect).
   */
  private async capturePaneOutput(agent: AgentRecord): Promise<string | null> {
    const captureResult = await this.proxyDispatch(agent.proxyId!, {
      action: 'capture',
      sessionName: sessionName(agent),
      lines: 50,
    });

    if (!captureResult.ok) {
      console.warn(`[health] Cannot capture ${agent.name}: ${captureResult.error}`);
      this.db.updateAgentState(agent.name, 'failed', agent.version, {
        failedAt: new Date().toISOString(),
        failureReason: `Health check failed: ${captureResult.error}`,
      });
      this.db.logEvent(agent.name, 'health_check_failed', undefined, { reason: captureResult.error });
      this.onAgentUpdate(agent.name);
      return null;
    }

    return (captureResult.data as string) ?? '';
  }

  /**
   * Check context thresholds and trigger reload/compact if needed.
   * Returns true if a threshold action was taken (caller should short-circuit).
   */
  private async handleContextThresholds(
    agent: AgentRecord,
    adapter: ReturnType<typeof getAdapter>,
    paneOutput: string,
  ): Promise<boolean> {
    const contextResult = adapter.parseContextPercent(paneOutput);
    if (contextResult.contextPct === null) return false;

    this.db.updateAgentState(agent.name, agent.state, agent.version, {
      lastContextPct: contextResult.contextPct,
      lastActivity: new Date().toISOString(),
    });
    this.onAgentUpdate(agent.name);

    const fresh = this.db.getAgent(agent.name);
    if (!fresh) return true;

    if (fresh.reloadQueued) {
      await this.handleReload(fresh);
      return true;
    }

    if (contextResult.contextPct >= this.autoReloadThreshold) {
      console.log(`[health] ${agent.name} context at ${contextResult.contextPct}% — triggering reload`);
      await this.handleReload(fresh);
      return true;
    }

    if (contextResult.contextPct >= this.autoCompactThreshold) {
      console.log(`[health] ${agent.name} context at ${contextResult.contextPct}% — sending compact`);
      const lifecycleCtx = this.makeLifecycleCtx();
      await compactAgent(lifecycleCtx, agent.name);
      return true;
    }

    return false;
  }

  /**
   * Detect and apply idle state transitions (active ↔ idle).
   */
  private handleIdleTransitions(agent: AgentRecord, idleState: string): void {
    if (idleState === 'waiting_for_input' && agent.state === 'active') {
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'active') {
        this.db.updateAgentState(agent.name, 'idle', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'idle_detected');
        this.onAgentUpdate(agent.name);
      }
    } else if (idleState !== 'waiting_for_input' && agent.state === 'idle') {
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'idle') {
        this.db.updateAgentState(agent.name, 'active', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'activity_detected');
        this.onAgentUpdate(agent.name);
      }
    }
  }

  /**
   * Check if an idle agent has exceeded the suspend timeout.
   * Currently logs only — auto-suspend is not implemented yet.
   */
  private checkIdleSuspendTimeout(agentName: string): void {
    const agent = this.db.getAgent(agentName);
    if (!agent || agent.state !== 'idle' || !agent.lastActivity) return;

    const idleDuration = Date.now() - new Date(agent.lastActivity).getTime();
    if (idleDuration > this.idleSuspendMs) {
      console.log(`[health] ${agent.name} idle for ${Math.round(idleDuration / 1000)}s (exceeds ${Math.round(this.idleSuspendMs / 1000)}s threshold)`);
      this.db.logEvent(agent.name, 'idle_timeout_exceeded', undefined, {
        idleDurationMs: idleDuration,
        thresholdMs: this.idleSuspendMs,
      });
    }
  }

  /**
   * Handle a queued reload when the agent is waiting for input.
   */
  private async handleQueuedReload(agentName: string): Promise<void> {
    const latest = this.db.getAgent(agentName);
    if (latest && latest.reloadQueued) {
      await this.handleReload(latest);
    }
  }

  private async handleReload(agent: AgentRecord): Promise<void> {
    try {
      const lifecycleCtx = this.makeLifecycleCtx();
      await reloadAgent(lifecycleCtx, agent.name, {
        immediate: true,
        task: agent.reloadTask ?? undefined,
      });
      this.onAgentUpdate(agent.name);
    } catch (err) {
      console.error(`[health] Reload failed for ${agent.name}:`, err);
      this.onAgentUpdate(agent.name);
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
