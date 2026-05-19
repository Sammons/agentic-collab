/**
 * Crash recovery — v3 Q8 surface.
 *
 * Three coordinated routines reconcile ephemeral state when the orchestrator
 * restarts, when a proxy reconnects after going away, or when a worktree is
 * left behind on disk by a missed `cleanup`:
 *
 *   1. `BootReconciler`     — single-shot at orchestrator startup.
 *   2. `ProxyReconnectHandler` — invoked from the proxy-register route.
 *   3. `OrphanedWorktreeSweep` — periodic interval after listen.
 *
 * All three follow the v3-vision §"Crash recovery" rules:
 *  - check `$STATUS_PATH` first (an agent may have finished while we were
 *    away — finalise via the reaper, never just discard the work);
 *  - check `has_session` next (live tmux → resume waiting on the reaper);
 *  - otherwise the instance died — mark failed, best-effort `cleanup`, mark
 *    the originating `topic_queue` row failed (we do NOT auto-requeue;
 *    requeue is a human-policy decision per Q8 spec).
 *
 * No new proxy commands are introduced. Worktree removal piggybacks on the
 * existing `exec` command with a 60s timeout (long enough for the `git
 * worktree remove` that the proxy default would otherwise kill at 5s).
 */

import { statSync, readdirSync } from 'node:fs';
import type { Database } from './database.ts';
import type { InstanceReaper } from './instance-reaper.ts';
import type { TopicDelivery } from './topic-delivery.ts';
import type {
  AgentInstanceRow,
  AgentTemplateRow,
  ProxyCommand,
  ProxyResponse,
  WsInstanceFailedEvent,
} from '../shared/types.ts';
import { shellQuote } from '../shared/utils.ts';
import { buildInstanceEnv } from './instance-env.ts';

/**
 * Narrow fs surface so tests can inject a recorder and avoid touching the
 * real filesystem. Mirrors the pattern from `ReaperFsAdapter` (Q3).
 */
export type RecoveryFsAdapter = {
  /** Returns `true` if `path` exists and is a directory. Never throws. */
  isDirectory: (path: string) => boolean;
  /** Returns the immediate child entry names of `path`. Returns `[]` on error. */
  readdir: (path: string) => string[];
  /**
   * Returns the size of the file at `path`, or `null` if it does not exist.
   * BootReconciler uses this to decide whether `$STATUS_PATH` is ready (a
   * non-zero size means the agent signaled before crash).
   */
  fileSize: (path: string) => number | null;
};

const defaultFsAdapter: RecoveryFsAdapter = {
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readdir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  fileSize(path: string): number | null {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
};

type ProxyDispatchFn = (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;

// ── BootReconciler ────────────────────────────────────────────────────────

export type BootReconcilerOptions = {
  db: Database;
  proxyDispatch: ProxyDispatchFn;
  instanceReaper: InstanceReaper;
  /** Reserved for future use (e.g. re-draining topics after a sweep). */
  topicDelivery?: TopicDelivery;
  /** Optional event sink — currently only used to mirror `instance_failed`. */
  onEvent?: (event: WsInstanceFailedEvent) => void;
  fsAdapter?: RecoveryFsAdapter;
};

export type ReconcileSummary = {
  resumed: number;
  failed: number;
  finalised: number;
  skipped: number;
};

export class BootReconciler {
  private readonly db: Database;
  private readonly proxyDispatch: ProxyDispatchFn;
  private readonly reaper: InstanceReaper;
  private readonly onEvent: (event: WsInstanceFailedEvent) => void;
  private readonly fs: RecoveryFsAdapter;

  constructor(opts: BootReconcilerOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.reaper = opts.instanceReaper;
    this.onEvent = opts.onEvent ?? (() => {});
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
  }

  /**
   * Walk every live `agent_instances` row and decide its fate. Idempotent:
   * re-running on an already-reconciled DB is a no-op.
   *
   * Per the spec this runs once at boot BEFORE listen, so callers should
   * await it. The work is bounded by the existing proxy retry budget — if
   * the proxy is unreachable, the row is skipped for this pass and the
   * proxy-reconnect path picks it up.
   */
  async reconcile(): Promise<ReconcileSummary> {
    const rows = this.db.listLiveAgentInstances();
    const summary: ReconcileSummary = { resumed: 0, failed: 0, finalised: 0, skipped: 0 };

    for (const row of rows) {
      try {
        const verdict = await this.reconcileOne(row);
        summary[verdict] += 1;
      } catch (err) {
        // Best-effort: never block startup on a single misbehaving row.
        console.error(`[boot-reconcile] row ${row.id} failed:`, (err as Error).message);
        summary.skipped += 1;
      }
    }

    if (rows.length > 0) {
      console.log(
        `[boot-reconcile] processed ${rows.length} live instance(s): `
          + `resumed=${summary.resumed} failed=${summary.failed} `
          + `finalised=${summary.finalised} skipped=${summary.skipped}`,
      );
    }
    return summary;
  }

  private async reconcileOne(
    row: AgentInstanceRow,
  ): Promise<'resumed' | 'failed' | 'finalised' | 'skipped'> {
    // 1. $STATUS_PATH non-empty? The agent already signaled but we missed
    //    the notify — let the reaper run the full finalisation path.
    if (this.statusReady(row.statusPath)) {
      await this.reaper.wake(row.id);
      return 'finalised';
    }

    // 2. Ask the proxy whether the tmux session is still alive.
    let proxyResp: ProxyResponse;
    try {
      proxyResp = await this.proxyDispatch(row.proxyId, {
        action: 'has_session',
        sessionName: row.tmuxSession,
      });
    } catch (err) {
      // Unreachable proxy — skip; the reconnect handler will catch it.
      console.warn(
        `[boot-reconcile] proxy ${row.proxyId} threw on has_session for `
          + `${row.id}: ${(err as Error).message}`,
      );
      return 'skipped';
    }

    if (!proxyResp.ok) {
      console.warn(
        `[boot-reconcile] proxy ${row.proxyId} unreachable for ${row.id}: `
          + `${proxyResp.error ?? 'unknown'}`,
      );
      return 'skipped';
    }

    if (proxyResp.data === true) {
      // Session alive → instance is still running; the reaper will pick it up.
      return 'resumed';
    }

    // 3. Session dead, no status. Mark failed, run cleanup best-effort,
    //    mark the queue row failed. No automatic requeue per spec.
    await failInstance(this.db, this.proxyDispatch, row, 'tmux session gone at boot', this.onEvent);
    return 'failed';
  }

  private statusReady(path: string): boolean {
    const size = this.fs.fileSize(path);
    return size != null && size > 0;
  }
}

// ── ProxyReconnectHandler ─────────────────────────────────────────────────

export type ProxyReconnectHandlerOptions = {
  db: Database;
  proxyDispatch: ProxyDispatchFn;
  onEvent?: (event: WsInstanceFailedEvent) => void;
  fsAdapter?: RecoveryFsAdapter;
};

export type ProxyReconnectSummary = {
  failed: number;
};

export class ProxyReconnectHandler {
  private readonly db: Database;
  private readonly proxyDispatch: ProxyDispatchFn;
  private readonly onEvent: (event: WsInstanceFailedEvent) => void;
  private readonly fs: RecoveryFsAdapter;

  constructor(opts: ProxyReconnectHandlerOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.onEvent = opts.onEvent ?? (() => {});
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
  }

  /**
   * Called from the `/api/proxy/register` route after the existing self-heal
   * step. Every live `agent_instances` row attributed to this proxy died
   * when the proxy died — mark them all failed and run cleanup best-effort.
   *
   * Best-effort: never throws back to the route handler.
   */
  async onProxyRegister(proxyId: string): Promise<ProxyReconnectSummary> {
    const rows = this.db.listAgentInstancesByProxy(proxyId, { onlyLive: true });
    let failed = 0;
    for (const row of rows) {
      try {
        // Only run cleanup if the worktree directory still exists on disk —
        // worktree removal against a non-existent path is noise, and `cleanup`
        // hooks typically `git worktree remove --force` which errors loudly.
        const cleanupWanted = !!row.worktreePath && this.fs.isDirectory(row.worktreePath);
        await failInstance(
          this.db,
          this.proxyDispatch,
          row,
          'proxy reconnected after disconnect',
          this.onEvent,
          { runCleanup: cleanupWanted },
        );
        failed += 1;
      } catch (err) {
        console.error(
          `[proxy-reconnect] failed to mark instance ${row.id} on ${proxyId}:`,
          (err as Error).message,
        );
      }
    }
    if (failed > 0) {
      console.log(`[proxy-reconnect] failed ${failed} orphaned instance(s) on ${proxyId}`);
    }
    return { failed };
  }
}

// ── OrphanedWorktreeSweep ─────────────────────────────────────────────────

export type OrphanedWorktreeSweepOptions = {
  db: Database;
  proxyDispatch: ProxyDispatchFn;
  /**
   * Pattern that on-disk entries under `cwd_base` must match to be considered
   * a worktree candidate. Defaults to `^wt-` which matches the convention
   * established by the smoke harness and the v3 vision.
   */
  prefix?: string;
  /**
   * Sweep tick interval (ms). Defaults to 60s. The sweep is best-effort and
   * idempotent — there's no benefit to ticking faster.
   */
  intervalMs?: number;
  /**
   * Which proxy to ask for the removal exec. Defaults to using the first
   * registered proxy (a worktree base is host-local, so it doesn't really
   * matter which proxy runs the `rm -rf`). Tests override this.
   */
  proxyResolver?: () => string | null;
  onEvent?: (event: WsInstanceFailedEvent) => void;
  fsAdapter?: RecoveryFsAdapter;
};

const DEFAULT_SWEEP_PREFIX = /^wt-/;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export class OrphanedWorktreeSweep {
  private readonly db: Database;
  private readonly proxyDispatch: ProxyDispatchFn;
  private readonly prefix: RegExp;
  private readonly intervalMs: number;
  private readonly resolveProxy: () => string | null;
  private readonly fs: RecoveryFsAdapter;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: OrphanedWorktreeSweepOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.prefix = opts.prefix ? new RegExp(opts.prefix) : DEFAULT_SWEEP_PREFIX;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.resolveProxy = opts.proxyResolver ?? (() => {
      const proxies = this.db.listProxies();
      return proxies.length > 0 ? proxies[0]!.proxyId : null;
    });
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
  }

  start(intervalMs?: number): void {
    if (this.timer) return;
    const ms = intervalMs ?? this.intervalMs;
    // Run one sweep on next tick, then on a steady cadence.
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        console.error('[orphan-sweep] tick failed:', (err as Error).message);
      });
    }, ms);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sweep pass. For each known `cwd_base`, enumerate child directories
   * matching `prefix` and remove any that don't correspond to a live
   * `agent_instances.worktree_path`. Never throws — best-effort.
   */
  async sweep(): Promise<{ removed: number; skipped: number }> {
    const bases = this.db.listCwdBases();
    const knownPaths = new Set(
      this.db.listLiveAgentInstances()
        .map((r) => r.worktreePath)
        .filter((p): p is string => !!p),
    );

    let removed = 0;
    let skipped = 0;

    for (const { cwdBase } of bases) {
      if (!this.fs.isDirectory(cwdBase)) {
        skipped += 1;
        continue;
      }
      const entries = this.fs.readdir(cwdBase);
      for (const name of entries) {
        if (!this.prefix.test(name)) continue;
        const fullPath = `${cwdBase.replace(/\/+$/, '')}/${name}`;
        if (!this.fs.isDirectory(fullPath)) continue;
        if (knownPaths.has(fullPath)) continue;

        const proxyId = this.resolveProxy();
        if (!proxyId) {
          // No proxy available — defer; next tick will retry.
          skipped += 1;
          continue;
        }

        const command = buildWorktreeRemovalCommand(cwdBase, fullPath);
        try {
          const r = await this.proxyDispatch(proxyId, {
            action: 'exec',
            command,
            timeoutMs: 60_000,
          });
          if (r.ok) {
            console.log(`[orphan-sweep] removed orphaned worktree: ${fullPath}`);
            removed += 1;
          } else {
            console.warn(`[orphan-sweep] removal failed for ${fullPath}: ${r.error ?? 'unknown'}`);
            skipped += 1;
          }
        } catch (err) {
          console.warn(`[orphan-sweep] removal threw for ${fullPath}: ${(err as Error).message}`);
          skipped += 1;
        }
      }
    }

    return { removed, skipped };
  }
}

/**
 * Build the host-shell command for removing an orphaned worktree. Falls back
 * to `rm -rf` if `git worktree remove` errors (the worktree may have been
 * unregistered from the parent repo's worktree list while the on-disk dir
 * lingered). Paths are shell-quoted via `shellQuote` to survive special
 * characters in either segment.
 */
function buildWorktreeRemovalCommand(cwdBase: string, orphanPath: string): string {
  const baseQ = shellQuote(cwdBase);
  const orphanQ = shellQuote(orphanPath);
  return `git -C ${baseQ} worktree remove --force ${orphanQ} || rm -rf ${orphanQ}`;
}

// ── Shared failure path ───────────────────────────────────────────────────

/**
 * Mark an instance and its `topic_queue` row failed, optionally running the
 * template's `cleanup` hook via the proxy's `exec` command. Mirrors
 * `TopicDelivery.failInstance` but lives outside the kernel so the recovery
 * paths don't have to reach back into a private method.
 *
 * Never throws. Cleanup failures are logged but don't block state updates.
 */
async function failInstance(
  db: Database,
  proxyDispatch: ProxyDispatchFn,
  row: AgentInstanceRow,
  reason: string,
  onEvent: (event: WsInstanceFailedEvent) => void,
  options?: { runCleanup?: boolean },
): Promise<void> {
  const runCleanup = options?.runCleanup ?? true;

  // Update state first so concurrent sweeps see the row as terminal.
  db.updateInstanceState(row.id, 'failed', {
    completedAt: new Date().toISOString(),
    failureReason: reason,
  });
  if (row.queueId != null) {
    db.markTopicQueueCompleted(row.queueId, 'failed');
  }

  // Emit the lifecycle event so any connected dashboards see the transition.
  const finalRow = db.getAgentInstance(row.id) ?? row;
  onEvent({ type: 'instance_failed', instance: finalRow, reason });

  if (!runCleanup) return;

  const template = db.getAgentTemplate(row.agentTemplate);
  if (!template?.hookCleanup) return;

  const env = buildCleanupEnv(row, template);
  const command = wrapWithEnv(template.hookCleanup, env);
  const cleanupCmd: ProxyCommand = template.cwdBase
    ? { action: 'exec', command, cwd: template.cwdBase, timeoutMs: 60_000 }
    : { action: 'exec', command, timeoutMs: 60_000 };

  try {
    const r = await proxyDispatch(row.proxyId, cleanupCmd);
    if (!r.ok) {
      console.warn(`[recovery] cleanup failed for ${row.id}: ${r.error ?? 'unknown'}`);
    }
  } catch (err) {
    console.warn(`[recovery] cleanup threw for ${row.id}: ${(err as Error).message}`);
  }
}

function buildCleanupEnv(row: AgentInstanceRow, template: AgentTemplateRow): Record<string, string> {
  return buildInstanceEnv({
    messageId: row.messageId,
    messagePath: row.messagePath,
    replyPath: row.replyPath,
    statusPath: row.statusPath,
    worktreePath: row.worktreePath ?? '',
    cwdBase: template.cwdBase ?? '',
    repoRoot: template.repoRoot ?? template.cwdBase ?? '',
    agentTemplate: row.agentTemplate,
    topicName: row.spawnedFromTopic ?? '',
    instanceAddr: row.instanceAddr,
    replyToAddr: row.replyToAddr ?? null,
    instanceId: row.id,
    messageContent: '',
  });
}

function wrapWithEnv(command: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  return `export ${assignments}; ${command}`;
}
