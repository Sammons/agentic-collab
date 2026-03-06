/**
 * Health monitor: polls agents every 30s.
 * Priority chain: reload > compact > suspend > ping.
 * Uses engine adapters for idle-state and context-% detection.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';
import { sessionName, canSuspend } from '../shared/agent-entity.ts';
import { getAdapter } from './adapters/index.ts';
import { reloadAgent, compactAgent, type LifecycleContext } from './lifecycle.ts';

export type HealthMonitorOptions = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  onAgentUpdate?: (agentName: string) => void;
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
  private readonly pollIntervalMs: number;
  private readonly autoCompactThreshold: number;
  private readonly autoReloadThreshold: number;
  private readonly idleSuspendMs: number;
  private readonly onAgentUpdate: (agentName: string) => void;

  constructor(opts: HealthMonitorOptions) {
    this.db = opts.db;
    this.locks = opts.locks;
    this.proxyDispatch = opts.proxyDispatch;
    this.orchestratorHost = opts.orchestratorHost;
    this.onAgentUpdate = opts.onAgentUpdate ?? (() => {});
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
   * Poll a single agent. Priority: reload > compact > idle detection.
   */
  async pollAgent(agentSnapshot: AgentRecord): Promise<void> {
    // Re-read fresh state to avoid acting on stale data from pollAll()
    const agent = this.db.getAgent(agentSnapshot.name);
    if (!agent || !agent.proxyId || !canSuspend(agent)) return;

    const adapter = getAdapter(agent.engine);
    const session = sessionName(agent);

    // 1. Capture pane output
    const captureResult = await this.proxyDispatch(agent.proxyId, {
      action: 'capture',
      sessionName: session,
      lines: 50,
    });

    if (!captureResult.ok) {
      // Session might be gone — mark failed
      console.warn(`[health] Cannot capture ${agent.name}: ${captureResult.error}`);
      this.db.updateAgentState(agent.name, 'failed', agent.version, {
        failedAt: new Date().toISOString(),
        failureReason: `Health check failed: ${captureResult.error}`,
      });
      this.db.logEvent(agent.name, 'health_check_failed', undefined, { reason: captureResult.error });
      this.onAgentUpdate(agent.name);
      return;
    }

    const paneOutput = (captureResult.data as string) ?? '';

    // 2. Parse context percentage
    const contextResult = adapter.parseContextPercent(paneOutput);
    if (contextResult.contextPct !== null) {
      this.db.updateAgentState(agent.name, agent.state, agent.version, {
        lastContextPct: contextResult.contextPct,
        lastActivity: new Date().toISOString(),
      });
      this.onAgentUpdate(agent.name);
      // Re-read after update for fresh version
      const fresh = this.db.getAgent(agent.name);
      if (!fresh) return;

      // Priority 1: Reload if queued or context critically high
      if (fresh.reloadQueued) {
        await this.handleReload(fresh);
        return;
      }

      // Priority 2: Reload if context >= reload threshold
      if (contextResult.contextPct >= this.autoReloadThreshold) {
        console.log(`[health] ${agent.name} context at ${contextResult.contextPct}% — triggering reload`);
        await this.handleReload(fresh);
        return;
      }

      // Priority 3: Compact if context >= compact threshold
      if (contextResult.contextPct >= this.autoCompactThreshold) {
        console.log(`[health] ${agent.name} context at ${contextResult.contextPct}% — sending compact`);
        const lifecycleCtx = this.makeLifecycleCtx();
        await compactAgent(lifecycleCtx, agent.name);
        return;
      }
    }

    // 3. Detect idle state
    const idleState = adapter.detectIdleState(paneOutput);

    if (idleState === 'waiting_for_input' && agent.state === 'active') {
      // Transition to idle
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'active') {
        this.db.updateAgentState(agent.name, 'idle', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'idle_detected');
        this.onAgentUpdate(agent.name);
      }
    } else if (idleState !== 'waiting_for_input' && agent.state === 'idle') {
      // Agent is active again
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'idle') {
        this.db.updateAgentState(agent.name, 'active', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'activity_detected');
        this.onAgentUpdate(agent.name);
      }
    }

    // 4. Check idle suspend timeout
    if (agent.state === 'idle' && agent.lastActivity) {
      const idleDuration = Date.now() - new Date(agent.lastActivity).getTime();
      if (idleDuration > this.idleSuspendMs) {
        console.log(`[health] ${agent.name} idle for ${Math.round(idleDuration / 1000)}s — suspending`);
        this.db.logEvent(agent.name, 'idle_suspend_triggered', undefined, {
          idleDurationMs: idleDuration,
        });
        // Don't auto-suspend for now — just log. The operator can configure this.
      }
    }

    // 5. Handle queued reload (even without context data)
    const latest = this.db.getAgent(agent.name);
    if (latest && latest.reloadQueued && idleState === 'waiting_for_input') {
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
