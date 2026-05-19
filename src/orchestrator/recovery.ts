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
 *    the originating `topic_queue` row failed (default) or requeue if
 *    `V3_RECOVERY_QUEUE_POLICY=requeue`.
 *
 * No new proxy commands are introduced. Worktree removal piggybacks on the
 * existing `exec` command with a 60s timeout (long enough for the `git
 * worktree remove` that the proxy default would otherwise kill at 5s).
 *
 * Q8 hostile-review hardening:
 *  - boot reconcile is bounded by a wall-clock cap and parallelised in chunks
 *    so an unreachable proxy can't stall `server.listen` for minutes (C1);
 *  - `ProxyReconnectHandler` probes `has_session` before failing live rows so
 *    a transient proxy heartbeat blip doesn't terminate healthy sessions (C2);
 *  - `OrphanedWorktreeSweep` is single-flight (C3) and re-checks the
 *    DB+mtime immediately before each `rm` to mitigate TOCTOU (C4);
 *  - orphan removal is routed via a proxy that has ever serviced the
 *    `cwd_base` (C5);
 *  - `'spawning'` and `'completing'` rows are excluded from recovery's
 *    working set — those are owned by Q3 (claim flow) and the reaper
 *    respectively (C6, H2).
 */

import { statSync, readdirSync } from 'node:fs';
import type { Database } from './database.ts';
import type { InstanceReaper } from './instance-reaper.ts';
import type {
  AgentInstanceRow,
  AgentInstanceState,
  AgentTemplateRow,
  ProxyCommand,
  ProxyResponse,
  WsInstanceFailedEvent,
} from '../shared/types.ts';
import { shellQuote, DEFAULT_WORKTREE_PREFIX } from '../shared/utils.ts';
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
  /**
   * Returns the directory mtime in ms since epoch, or `null` if the path
   * does not exist. The sweep uses a 60s grace before removing freshly
   * created directories (a new instance may have just made one between the
   * snapshot and the rm exec).
   */
  mtimeMs: (path: string) => number | null;
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
  mtimeMs(path: string): number | null {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
};

type ProxyDispatchFn = (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;

/**
 * `'spawning'` is Q3's transient claim window; `'completing'` is the reaper's
 * finalisation window. Recovery must NOT touch either — racing those owners
 * produces contradictory terminal outcomes (e.g. instance_failed +
 * instance_completed for the same row).
 */
const RECOVERY_EXCLUDED_STATES: AgentInstanceState[] = ['spawning', 'completing'];

/**
 * Read the queue policy from env. Default `'fail'` matches the original Q8
 * spec; `'requeue'` resets the topic_queue row back to `'queued'` so a
 * subsequent `claimAndSpawn` pass can grab it.
 */
function readQueuePolicy(): 'fail' | 'requeue' {
  const raw = process.env['V3_RECOVERY_QUEUE_POLICY'];
  return raw === 'requeue' ? 'requeue' : 'fail';
}

// ── BootReconciler ────────────────────────────────────────────────────────

export type BootReconcilerOptions = {
  db: Database;
  proxyDispatch: ProxyDispatchFn;
  instanceReaper: InstanceReaper;
  /** Optional event sink — currently only used to mirror `instance_failed`. */
  onEvent?: (event: WsInstanceFailedEvent) => void;
  fsAdapter?: RecoveryFsAdapter;
  /**
   * Wall-clock cap (ms) for the entire reconcile pass. Defaults to 30s, or
   * the value of `BOOT_RECONCILE_TIMEOUT_MS` if set. Once the cap is hit,
   * the reconciler returns with the remaining rows counted as `skipped`.
   * Unreconciled rows are picked up by the proxy-reconnect handler or the
   * periodic sweep. Per Q8 spec line 282: "Bound it."
   */
  wallClockCapMs?: number;
  /**
   * Per-row work is fanned out in parallel chunks of this size. Defaults
   * to 10 — large enough to amortise per-row dispatch latency, small enough
   * that an unreachable proxy can't stall the entire pass behind one slow
   * chunk.
   */
  chunkSize?: number;
};

export type ReconcileSummary = {
  resumed: number;
  failed: number;
  finalised: number;
  skipped: number;
};

const DEFAULT_BOOT_WALL_CLOCK_MS = 30_000;
const DEFAULT_BOOT_CHUNK_SIZE = 10;

export class BootReconciler {
  private readonly db: Database;
  private readonly proxyDispatch: ProxyDispatchFn;
  private readonly reaper: InstanceReaper;
  private readonly onEvent: (event: WsInstanceFailedEvent) => void;
  private readonly fs: RecoveryFsAdapter;
  private readonly wallClockCapMs: number;
  private readonly chunkSize: number;

  constructor(opts: BootReconcilerOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.reaper = opts.instanceReaper;
    this.onEvent = opts.onEvent ?? (() => {});
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
    const envCap = Number.parseInt(process.env['BOOT_RECONCILE_TIMEOUT_MS'] ?? '', 10);
    this.wallClockCapMs = opts.wallClockCapMs
      ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_BOOT_WALL_CLOCK_MS);
    this.chunkSize = opts.chunkSize ?? DEFAULT_BOOT_CHUNK_SIZE;
  }

  /**
   * Walk every live `agent_instances` row and decide its fate. Idempotent:
   * re-running on an already-reconciled DB is a no-op.
   *
   * Bounded by `wallClockCapMs` (C1). If the cap fires, remaining rows are
   * counted as `skipped` and the proxy-reconnect handler / periodic sweep
   * picks them up. Rows are processed in parallel chunks of `chunkSize` so
   * one unreachable proxy can't serialise the whole pass.
   *
   * `'spawning'` and `'completing'` rows are excluded — those are owned by
   * Q3's claim flow and the reaper's finalisation flow respectively (C6).
   */
  async reconcile(): Promise<ReconcileSummary> {
    const rows = this.db.listLiveAgentInstances({ excludeStates: RECOVERY_EXCLUDED_STATES });
    const summary: ReconcileSummary = { resumed: 0, failed: 0, finalised: 0, skipped: 0 };

    if (rows.length === 0) return summary;

    const deadline = Date.now() + this.wallClockCapMs;
    let processed = 0;
    let capHit = false;

    for (let i = 0; i < rows.length; i += this.chunkSize) {
      if (Date.now() >= deadline) {
        capHit = true;
        break;
      }
      const chunk = rows.slice(i, i + this.chunkSize);
      const results = await Promise.allSettled(chunk.map((row) => this.reconcileOne(row)));
      for (let j = 0; j < results.length; j += 1) {
        const r = results[j]!;
        if (r.status === 'fulfilled') {
          summary[r.value] += 1;
        } else {
          console.error(
            `[boot-reconcile] row ${chunk[j]!.id} failed:`,
            (r.reason as Error).message,
          );
          summary.skipped += 1;
        }
      }
      processed += chunk.length;
    }

    if (capHit) {
      const remaining = rows.length - processed;
      summary.skipped += remaining;
      console.warn(
        `[boot-reconcile] wall-clock cap ${this.wallClockCapMs}ms hit; `
          + `${remaining} live instance(s) unreconciled. Proxy-reconnect handler `
          + `or periodic sweep will pick them up.`,
      );
    }

    console.log(
      `[boot-reconcile] processed ${rows.length} live instance(s): `
        + `resumed=${summary.resumed} failed=${summary.failed} `
        + `finalised=${summary.finalised} skipped=${summary.skipped}`,
    );
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

    // 3. Session dead, no status. Mark failed, run cleanup best-effort (H1:
    //    only if the worktree directory is on disk), mark the queue row
    //    failed (or requeue per env policy).
    const cleanupWanted = !!row.worktreePath && this.fs.isDirectory(row.worktreePath);
    await failInstance(
      this.db,
      this.proxyDispatch,
      row,
      'tmux session gone at boot',
      this.onEvent,
      { runCleanup: cleanupWanted, queuePolicy: readQueuePolicy() },
    );
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
  skipped: number;
};

export class ProxyReconnectHandler {
  private readonly db: Database;
  private readonly proxyDispatch: ProxyDispatchFn;
  private readonly onEvent: (event: WsInstanceFailedEvent) => void;
  private readonly fs: RecoveryFsAdapter;
  /**
   * Single-flight per proxy_id (H4). A proxy heartbeat blip can produce
   * back-to-back `/api/proxy/register` calls; serialising per proxy keeps
   * us from double-processing the same instance set.
   */
  private readonly inFlightProxies = new Set<string>();

  constructor(opts: ProxyReconnectHandlerOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.onEvent = opts.onEvent ?? (() => {});
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
  }

  /**
   * Called from the `/api/proxy/register` route after the existing self-heal
   * step. For each live `agent_instances` row attributed to this proxy,
   * probe `has_session` FIRST (C2) — a proxy heartbeat may have lapsed
   * while the tmux session is still alive, in which case we leave the row
   * alone. Only rows whose session is confirmed dead are marked failed.
   *
   * `'spawning'` and `'completing'` are excluded (C6, H2). Best-effort: never
   * throws back to the route handler. Single-flight per proxy_id (H4).
   */
  async onProxyRegister(proxyId: string): Promise<ProxyReconnectSummary> {
    if (this.inFlightProxies.has(proxyId)) {
      return { failed: 0, skipped: 0 };
    }
    this.inFlightProxies.add(proxyId);
    try {
      return await this.runOnce(proxyId);
    } finally {
      this.inFlightProxies.delete(proxyId);
    }
  }

  private async runOnce(proxyId: string): Promise<ProxyReconnectSummary> {
    const rows = this.db.listAgentInstancesByProxy(proxyId, {
      onlyLive: true,
      excludeStates: RECOVERY_EXCLUDED_STATES,
    });
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        // C2: probe has_session first. Persistent self-heal at
        // routes.ts:128-137 follows the same probe-before-act pattern; we
        // mirror it here for ephemeral instances.
        let probe: ProxyResponse;
        try {
          probe = await this.proxyDispatch(proxyId, {
            action: 'has_session',
            sessionName: row.tmuxSession,
          });
        } catch (err) {
          console.warn(
            `[proxy-reconnect] has_session threw for ${row.id} on ${proxyId}: `
              + `${(err as Error).message}`,
          );
          skipped += 1;
          continue;
        }
        if (!probe.ok) {
          // Proxy unreachable mid-handler — leave the row alone, next
          // register will retry.
          console.warn(
            `[proxy-reconnect] proxy ${proxyId} unreachable for ${row.id}: `
              + `${probe.error ?? 'unknown'}`,
          );
          skipped += 1;
          continue;
        }
        if (probe.data === true) {
          // Session is alive — the proxy had a transient blip but tmux
          // survived. Don't touch the row.
          skipped += 1;
          continue;
        }

        // Confirmed dead. Run cleanup only if the worktree dir is on disk
        // (H1 — cleanup hooks typically `git worktree remove --force` which
        // errors loudly against a missing path).
        const cleanupWanted = !!row.worktreePath && this.fs.isDirectory(row.worktreePath);
        await failInstance(
          this.db,
          this.proxyDispatch,
          row,
          'proxy reconnected after disconnect',
          this.onEvent,
          { runCleanup: cleanupWanted, queuePolicy: readQueuePolicy() },
        );
        failed += 1;
      } catch (err) {
        console.error(
          `[proxy-reconnect] failed to mark instance ${row.id} on ${proxyId}:`,
          (err as Error).message,
        );
      }
    }
    if (failed > 0 || skipped > 0) {
      console.log(
        `[proxy-reconnect] ${proxyId}: failed=${failed} skipped=${skipped} `
          + `(skipped includes live sessions and unreachable probes)`,
      );
    }
    return { failed, skipped };
  }
}

// ── OrphanedWorktreeSweep ─────────────────────────────────────────────────

export type OrphanedWorktreeSweepOptions = {
  db: Database;
  proxyDispatch: ProxyDispatchFn;
  /**
   * Pattern that on-disk entries under `cwd_base` must match to be considered
   * a worktree candidate. Defaults to `^wt-` (shared `DEFAULT_WORKTREE_PREFIX`)
   * which matches the convention established by the smoke harness and the
   * v3 vision.
   */
  prefix?: string;
  /**
   * Sweep tick interval (ms). Defaults to 60s. The sweep is best-effort and
   * idempotent — there's no benefit to ticking faster.
   */
  intervalMs?: number;
  /**
   * Custom proxy resolver (path → proxy_id). Tests override this; in
   * production the default resolver routes via a proxy that has ever
   * serviced an `agent_instances` row referencing the matching `cwd_base`
   * (C5).
   */
  proxyResolver?: (cwdBase: string, orphanPath: string) => string | null;
  /**
   * Mtime grace for newly created orphan candidates. Directories younger
   * than this are skipped to avoid racing a freshly spawned instance whose
   * `agent_instances` row hasn't yet been observed (C4). Default 60s.
   */
  mtimeGraceMs?: number;
  onEvent?: (event: WsInstanceFailedEvent) => void;
  fsAdapter?: RecoveryFsAdapter;
};

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MTIME_GRACE_MS = 60_000;

export class OrphanedWorktreeSweep {
  private readonly db: Database;
  private readonly proxyDispatch: ProxyDispatchFn;
  private readonly prefix: RegExp;
  private readonly intervalMs: number;
  private readonly mtimeGraceMs: number;
  private readonly resolveProxy: (cwdBase: string, orphanPath: string) => string | null;
  private readonly fs: RecoveryFsAdapter;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Single-flight guard (C3). One tick can take > intervalMs when many
   * orphans need a 60s `git worktree remove` exec; without this guard,
   * overlapping ticks race the read-then-rm sequence.
   */
  private sweepInFlight = false;

  constructor(opts: OrphanedWorktreeSweepOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.prefix = opts.prefix ? new RegExp(opts.prefix) : DEFAULT_WORKTREE_PREFIX;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.mtimeGraceMs = opts.mtimeGraceMs ?? DEFAULT_MTIME_GRACE_MS;
    this.resolveProxy = opts.proxyResolver ?? ((cwdBase) => this.defaultResolveProxy(cwdBase));
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
  }

  /**
   * C5: pick a proxy that has ever serviced an instance under this `cwd_base`.
   * In multi-host deployments, orphans on host A must be removed via host A's
   * proxy. If multiple proxies match, prefer the most recently registered.
   * If no proxy has ever owned an instance with this `cwd_base`, log a
   * one-time warning and return null (the sweep skips this candidate).
   *
   * TODO: a proper fix would be host-aware template metadata. This
   * heuristic relies on observed proxy activity and may miss a freshly
   * provisioned host with zero ephemeral history.
   */
  private defaultResolveProxy(cwdBase: string): string | null {
    const candidates = this.db.rawDb.prepare(
      `SELECT DISTINCT ai.proxy_id AS proxy_id, p.registered_at AS registered_at
         FROM agent_instances ai
         JOIN agent_templates t ON t.id = ai.agent_template
         JOIN proxies p ON p.proxy_id = ai.proxy_id
        WHERE t.cwd_base = ?
        ORDER BY p.registered_at DESC`,
    ).all(cwdBase) as Array<{ proxy_id: string; registered_at: string }>;

    if (candidates.length === 0) {
      console.warn(
        `[orphan-sweep] no proxy has ever serviced cwd_base=${cwdBase}; `
          + `skipping orphan candidates here. (Likely a multi-host config — `
          + `provide a proxyResolver or wait for an instance to land on the host.)`,
      );
      return null;
    }
    return candidates[0]!.proxy_id;
  }

  start(intervalMs?: number): void {
    if (this.timer) return;
    const ms = intervalMs ?? this.intervalMs;
    // Run one sweep on next tick, then on a steady cadence. (First tick
    // fires at T+intervalMs, not T+0 — L3 comment correction.)
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
   *
   * Hardening:
   *  - C3: single-flight via `sweepInFlight`.
   *  - C4: immediately before each `rm` exec, re-query the live worktree
   *    set and check the directory mtime; skip if a new instance claimed
   *    the path between the initial snapshot and the rm, or if the dir is
   *    younger than `mtimeGraceMs` (a freshly spawned instance's row may
   *    not be visible yet).
   *  - C5: route via `resolveProxy(cwdBase, orphanPath)` — defaults to a
   *    proxy that has historically serviced an instance under this base.
   */
  async sweep(): Promise<{ removed: number; skipped: number }> {
    if (this.sweepInFlight) return { removed: 0, skipped: 0 };
    this.sweepInFlight = true;
    try {
      return await this.sweepInner();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweepInner(): Promise<{ removed: number; skipped: number }> {
    const bases = this.db.listCwdBases();
    const initialKnownPaths = new Set(
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
        if (initialKnownPaths.has(fullPath)) continue;

        // C4: mtime grace — don't touch directories that are too fresh.
        // Clock skew (and node:fs reporting sub-millisecond futures on
        // some filesystems) can yield a negative `now - mtime`; clamp to 0
        // so a zero-grace caller doesn't mistakenly skip a freshly-mkdir'd
        // candidate.
        const mtime = this.fs.mtimeMs(fullPath);
        if (mtime != null) {
          const age = Math.max(0, Date.now() - mtime);
          if (age < this.mtimeGraceMs) {
            skipped += 1;
            continue;
          }
        }

        // C4: re-query immediately before rm to catch instances that
        // claimed this path AFTER the initial snapshot.
        const liveNow = new Set(
          this.db.listLiveAgentInstances()
            .map((r) => r.worktreePath)
            .filter((p): p is string => !!p),
        );
        if (liveNow.has(fullPath)) {
          skipped += 1;
          continue;
        }

        const proxyId = this.resolveProxy(cwdBase, fullPath);
        if (!proxyId) {
          // No proxy available for this base — defer; next tick will retry.
          skipped += 1;
          continue;
        }

        // C5: look up the template's repo_root so `git worktree remove`
        // runs against the source repo, not the worktree base (H5). If
        // unavailable, fall through to `rm -rf`.
        const repoRoot = this.lookupRepoRoot(cwdBase);
        const command = buildWorktreeRemovalCommand(repoRoot, fullPath);
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

  /**
   * H5: `git worktree remove` must run from the source repo, not the worktree
   * base. Return the first non-empty `repo_root` for any template using this
   * `cwd_base`. Null when no template carries a repo_root — the caller then
   * falls back to plain `rm -rf`.
   */
  private lookupRepoRoot(cwdBase: string): string | null {
    const row = this.db.rawDb.prepare(
      `SELECT repo_root FROM agent_templates
        WHERE cwd_base = ?
          AND repo_root IS NOT NULL
          AND repo_root != ''
        LIMIT 1`,
    ).get(cwdBase) as { repo_root: string } | undefined;
    return row?.repo_root ?? null;
  }
}

/**
 * Build the host-shell command for removing an orphaned worktree. If a
 * `repoRoot` is known we try `git -C <repoRoot> worktree remove --force`
 * first; falling back to `rm -rf` when the worktree was already
 * unregistered or the repo_root is unknown. Paths are shell-quoted via
 * `shellQuote` to survive special characters in either segment (H5).
 */
function buildWorktreeRemovalCommand(repoRoot: string | null, orphanPath: string): string {
  const orphanQ = shellQuote(orphanPath);
  if (repoRoot) {
    const repoQ = shellQuote(repoRoot);
    return `git -C ${repoQ} worktree remove --force ${orphanQ} || rm -rf ${orphanQ}`;
  }
  return `rm -rf ${orphanQ}`;
}

// ── Shared failure path ───────────────────────────────────────────────────

/**
 * Mark an instance and its `topic_queue` row failed, optionally running the
 * template's `cleanup` hook via the proxy's `exec` command. Mirrors
 * `TopicDelivery.failInstance` but lives outside the kernel so the recovery
 * paths don't have to reach back into a private method.
 *
 * Never throws. Cleanup failures are logged but don't block state updates.
 *
 * Caveat (M3): `buildCleanupEnv` reads template fields from the CURRENT
 * template row. If the template was edited between spawn and crash, env at
 * recovery time may differ from env at spawn. Worktree-derived fields
 * (`worktreePath`, message paths) are read from the instance row, so those
 * are stable. Template-derived fields (`cwd_base`, `repo_root`) are not.
 */
async function failInstance(
  db: Database,
  proxyDispatch: ProxyDispatchFn,
  row: AgentInstanceRow,
  reason: string,
  onEvent: (event: WsInstanceFailedEvent) => void,
  options?: { runCleanup?: boolean; queuePolicy?: 'fail' | 'requeue' },
): Promise<void> {
  const runCleanup = options?.runCleanup ?? true;
  const queuePolicy = options?.queuePolicy ?? 'fail';

  // M1: cleanup MUST be dispatched BEFORE we flip the state to 'failed' — a
  // concurrent sweep that observed the row in 'running' would otherwise see
  // it terminal and skip the cleanup itself. Order here is:
  //   1. dispatch cleanup exec (best-effort, awaited)
  //   2. updateInstanceState('failed', ...)
  //   3. mark/requeue topic_queue
  //   4. emit WS instance_failed
  if (runCleanup) {
    const template = db.getAgentTemplate(row.agentTemplate);
    if (template?.hookCleanup) {
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
  }

  db.updateInstanceState(row.id, 'failed', {
    completedAt: new Date().toISOString(),
    failureReason: reason,
  });
  if (row.queueId != null) {
    if (queuePolicy === 'requeue') {
      const requeued = db.requeueTopicQueueRow(row.queueId);
      if (!requeued) {
        // Row was already terminal — fall back to marking failed.
        db.markTopicQueueCompleted(row.queueId, 'failed');
      } else {
        console.log(
          `[recovery] requeued topic_queue id=${row.queueId} for ${row.id} `
            + `(V3_RECOVERY_QUEUE_POLICY=requeue)`,
        );
      }
    } else {
      db.markTopicQueueCompleted(row.queueId, 'failed');
    }
  }

  // Emit the lifecycle event so any connected dashboards see the transition.
  const finalRow = db.getAgentInstance(row.id) ?? row;
  onEvent({ type: 'instance_failed', instance: finalRow, reason });
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
