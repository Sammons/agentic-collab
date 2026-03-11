/**
 * Health monitor: polls agents every 30s (read-only observation).
 *
 * Idle detection uses screen-diff: captures the last N lines of tmux pane
 * output each poll cycle and compares to the previous capture. If the output
 * is unchanged across consecutive polls, the agent is considered idle.
 * This is engine-agnostic — no regex prompt detection needed.
 *
 * Context % parsing still uses engine adapters (each CLI reports usage differently).
 * Context percentages are recorded to the DB for dashboard display but do NOT
 * trigger automatic compact or reload actions.
 *
 * Message delivery is entirely owned by MessageDispatcher (event-driven).
 * The health monitor does NOT participate in message delivery.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord, PendingMessage, DashboardMessage } from '../shared/types.ts';
import { sessionName, canSuspend } from '../shared/agent-entity.ts';
import { getAdapter } from './adapters/index.ts';
import { reloadAgent, type LifecycleContext } from './lifecycle.ts';

export type HealthMonitorOptions = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  onAgentUpdate?: (agentName: string) => void;
  onQueueUpdate?: (message: PendingMessage) => void;
  onDashboardMessage?: (message: DashboardMessage) => void;
  pollIntervalMs?: number;
  idleSuspendMs?: number;        // ms of idle before suspend (default 5 minutes)
};

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_IDLE_SUSPEND_MS = 5 * 60 * 1000;

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private readonly quickPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Consecutive health check failure count per agent. */
  private readonly consecutiveFailures = new Map<string, number>();
  private static readonly FAILURE_THRESHOLD = 3; // failures before marking agent as failed
  /**
   * Last captured pane snapshot (ANSI-stripped, last N lines) per agent.
   * Used for screen-diff idle detection.
   */
  private readonly lastPaneSnapshot = new Map<string, string>();
  /**
   * Count of consecutive polls where pane output was unchanged.
   * When >= IDLE_THRESHOLD, the agent is considered idle.
   */
  private readonly unchangedCount = new Map<string, number>();
  /**
   * Number of consecutive unchanged polls required before marking idle.
   * With 5s fast-poll, 2 consecutive (after baseline) = 15s to detect idle.
   */
  static readonly IDLE_THRESHOLD = 2;
  /** Number of trailing pane lines to capture for screen-diff. */
  static readonly SNAPSHOT_LINES = 15;
  private readonly db: Database;
  private readonly locks: LockManager;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly orchestratorHost: string;
  private readonly pollIntervalMs: number;
  private readonly idleSuspendMs: number;
  static readonly FAST_POLL_MS = 5_000;
  private readonly onAgentUpdate: (agentName: string) => void;
  private readonly onQueueUpdate: (message: PendingMessage) => void;
  private readonly onDashboardMessage: (message: DashboardMessage) => void;

  constructor(opts: HealthMonitorOptions) {
    this.db = opts.db;
    this.locks = opts.locks;
    this.proxyDispatch = opts.proxyDispatch;
    this.orchestratorHost = opts.orchestratorHost;
    this.onAgentUpdate = opts.onAgentUpdate ?? (() => {});
    this.onQueueUpdate = opts.onQueueUpdate ?? (() => {});
    this.onDashboardMessage = opts.onDashboardMessage ?? (() => {});
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.idleSuspendMs = opts.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
  }

  /**
   * Strip ANSI escape sequences from a string.
   * Handles CSI sequences (colors, cursor), OSC sequences (hyperlinks, titles),
   * and single-character escapes.
   */
  static stripAnsi(text: string): string {
    // CSI: \x1b[ ... final byte (letter)
    // OSC: \x1b] ... ST (\x1b\\ or \x07)
    // Single-char: \x1b followed by a non-[ non-] byte
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g, '');
  }

  /**
   * Take a snapshot of the last N lines of pane output for screen-diff.
   * Strips ANSI codes and trailing whitespace for stable comparison.
   */
  static takeSnapshot(paneOutput: string, lines: number = HealthMonitor.SNAPSHOT_LINES): string {
    const stripped = HealthMonitor.stripAnsi(paneOutput);
    const allLines = stripped.split('\n');
    return allLines
      .slice(-lines)
      .map(l => l.trimEnd())
      .join('\n');
  }

  /**
   * Screen-diff idle detection: compare current pane snapshot to previous.
   * Returns true if the agent appears idle (screen unchanged).
   */
  private checkScreenDiff(agentName: string, paneOutput: string): boolean {
    const snapshot = HealthMonitor.takeSnapshot(paneOutput);
    const prev = this.lastPaneSnapshot.get(agentName);
    this.lastPaneSnapshot.set(agentName, snapshot);

    if (prev === undefined) {
      // First capture — no comparison possible, assume active
      this.unchangedCount.set(agentName, 0);
      return false;
    }

    if (snapshot === prev) {
      const count = (this.unchangedCount.get(agentName) ?? 0) + 1;
      this.unchangedCount.set(agentName, count);
      return count >= HealthMonitor.IDLE_THRESHOLD;
    } else {
      this.unchangedCount.set(agentName, 0);
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    console.log(`[health] Starting monitor (poll every ${this.pollIntervalMs}ms, fast-poll every ${HealthMonitor.FAST_POLL_MS}ms for active agents)`);
    this.timer = setInterval(() => {
      this.pollAll().catch((err) => {
        console.error('[health] Poll error:', err);
      });
    }, this.pollIntervalMs);
    this.fastTimer = setInterval(() => {
      this.pollActiveAgents().catch((err) => {
        console.error('[health] Fast poll error:', err);
      });
    }, HealthMonitor.FAST_POLL_MS);
  }

  stop(): void {
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[health] Monitor stopped');
    }
    for (const timer of this.quickPollTimers.values()) {
      clearTimeout(timer);
    }
    this.quickPollTimers.clear();
  }

  /**
   * Schedule a one-shot poll for a specific agent ~1s from now.
   * Used after message delivery to catch the idle→active transition quickly.
   * Deduplicates: only one quick poll per agent at a time.
   */
  scheduleQuickPoll(agentName: string): void {
    if (this.quickPollTimers.has(agentName)) return;
    const timer = setTimeout(() => {
      this.quickPollTimers.delete(agentName);
      const agent = this.db.getAgent(agentName);
      if (agent && agent.proxyId) {
        this.pollAgent(agent).catch((err) => {
          console.error(`[health] Quick poll error for ${agentName}:`, err);
        });
      }
    }, 1000);
    this.quickPollTimers.set(agentName, timer);
  }

  /**
   * Fast-poll only active agents (every 5s) for near real-time state detection.
   * Uses screen-diff: captures last N lines of pane, compares to previous capture.
   * Unchanged across IDLE_THRESHOLD consecutive polls → idle.
   */
  async pollActiveAgents(): Promise<void> {
    const agents = this.db.listAgents().filter(
      (a) => a.state === 'active' && a.proxyId,
    );
    for (const agent of agents) {
      try {
        const paneOutput = await this.capturePaneOutput(agent);
        if (paneOutput === null) continue;
        const isIdle = this.checkScreenDiff(agent.name, paneOutput);
        this.handleIdleTransitions(agent, isIdle);
      } catch (err) {
        console.error(`[health] Fast poll error for ${agent.name}:`, err);
      }
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
   * Poll a single agent. Read-only observation + idle detection.
   */
  async pollAgent(agentSnapshot: AgentRecord): Promise<void> {
    const agent = this.db.getAgent(agentSnapshot.name);
    if (!agent || !agent.proxyId || !canSuspend(agent)) return;

    const paneOutput = await this.capturePaneOutput(agent);
    if (paneOutput === null) return;

    // Check if the CLI exited back to a bare shell prompt (e.g. session not found)
    if (this.detectCliExit(agent, paneOutput)) return;

    this.recordContextPercent(agent, paneOutput);

    const isIdle = this.checkScreenDiff(agent.name, paneOutput);
    this.handleIdleTransitions(agent, isIdle);

    this.checkIdleSuspendTimeout(agent.name);

    if (isIdle) {
      await this.handleQueuedReload(agent.name);
    }

    // Update lastActivity on every successful poll so dashboard timestamps stay fresh.
    // Done last to avoid version conflicts with other state updates above.
    const latest = this.db.getAgent(agent.name);
    if (latest) {
      this.db.updateAgentState(agent.name, latest.state, latest.version, {
        lastActivity: new Date().toISOString(),
      });
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
      const failures = (this.consecutiveFailures.get(agent.name) ?? 0) + 1;
      this.consecutiveFailures.set(agent.name, failures);
      console.warn(`[health] Cannot capture ${agent.name} (${failures}/${HealthMonitor.FAILURE_THRESHOLD}): ${captureResult.error}`);

      if (failures >= HealthMonitor.FAILURE_THRESHOLD) {
        this.db.updateAgentState(agent.name, 'failed', agent.version, {
          failedAt: new Date().toISOString(),
          failureReason: `Health check failed ${failures}x: ${captureResult.error}`,
        });
        this.db.logEvent(agent.name, 'health_check_failed', undefined, {
          reason: captureResult.error,
          consecutiveFailures: failures,
        });
        this.onAgentUpdate(agent.name);
        this.consecutiveFailures.delete(agent.name);
      }
      return null;
    }

    // Reset failure counter on success
    this.consecutiveFailures.delete(agent.name);
    return (captureResult.data as string) ?? '';
  }

  /**
   * Parse context % from pane output and record to DB (read-only — no actions taken).
   */
  private recordContextPercent(agent: AgentRecord, paneOutput: string): void {
    const adapter = getAdapter(agent.engine);
    const contextResult = adapter.parseContextPercent(paneOutput);
    if (contextResult.contextPct === null) return;

    this.db.updateAgentState(agent.name, agent.state, agent.version, {
      lastContextPct: contextResult.contextPct,
      lastActivity: new Date().toISOString(),
    });
    this.onAgentUpdate(agent.name);
  }

  /**
   * Screen-diff idle transitions.
   *
   * - active → idle: screen unchanged for IDLE_THRESHOLD consecutive polls
   * - idle → active: screen changed (any content diff)
   *
   * No regex, no engine-specific patterns, no tmux activity timestamps.
   */
  private handleIdleTransitions(agent: AgentRecord, isIdle: boolean): void {
    if (agent.state === 'active' && isIdle) {
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'active') {
        this.db.updateAgentState(agent.name, 'idle', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'idle_detected');
        this.onAgentUpdate(agent.name);
      }
    } else if (agent.state === 'idle' && !isIdle) {
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
  /**
   * Detect if the CLI has exited back to a bare shell prompt.
   * This happens when `claude --resume <id>` fails (e.g. "No conversation found")
   * or the CLI crashes. The tmux session stays alive but shows a bash prompt.
   *
   * Returns true if exit was detected (agent marked as failed), false otherwise.
   */
  private detectCliExit(agent: AgentRecord, paneOutput: string): boolean {
    const key = `shell_${agent.name}`;
    const lines = paneOutput.split('\n');

    // Find the last non-empty line
    let lastLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed) { lastLine = trimmed; break; }
    }

    // Bare shell prompt: user@host:path$ or [user@host path]$
    // Must end with $ (bash) or % (zsh) optionally followed by whitespace
    const isShellPrompt = /[@:].*[$%]\s*$/.test(lastLine);
    if (!isShellPrompt) {
      this.consecutiveFailures.delete(key);
      return false;
    }
    const count = (this.consecutiveFailures.get(key) ?? 0) + 1;
    this.consecutiveFailures.set(key, count);

    if (count < 2) return false; // need 2 consecutive to confirm

    // Determine reason from pane context
    let reason = 'CLI exited to shell prompt';
    if (/No conversation found|session.*not found/i.test(paneOutput)) {
      reason = 'CLI session not found — resume failed';
    } else if (/error|panic|crash/i.test(paneOutput)) {
      reason = 'CLI crashed to shell prompt';
    }

    console.warn(`[health] ${agent.name}: ${reason}`);
    this.db.updateAgentState(agent.name, 'failed', agent.version, {
      failedAt: new Date().toISOString(),
      failureReason: reason,
    });
    this.db.logEvent(agent.name, 'cli_exit_detected', undefined, { reason, lastLine });
    this.onAgentUpdate(agent.name);
    this.consecutiveFailures.delete(key);
    this.lastPaneSnapshot.delete(agent.name);
    return true;
  }

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
