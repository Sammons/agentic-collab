/**
 * Instance reaper — v3 Q3 ephemeral lifecycle completion side.
 *
 * Polls `$STATUS_PATH` for each live `agent_instances` row every
 * `SWEEP_INTERVAL_MS`. When a status file is non-empty:
 *   1. Mark instance `completing`.
 *   2. Read $REPLY_PATH, build a reply envelope, enqueue it for the
 *      original publisher (BARE address) and call `messageDispatcher.tryDeliver`.
 *   3. proxy `kill_session`.
 *   4. proxy `exec(cleanup, cwd=cwdBase, timeoutMs=60_000)` — best-effort.
 *   5. Mark instance `completed` (or `failed` if status said error).
 *   6. Mark topic_queue row completed.
 *   7. Call topicDelivery.tryDispatch to drain the next queued row.
 *
 * Ordering invariants:
 *  - #5: $STATUS_PATH + $REPLY_PATH read BEFORE `kill_session`.
 *  - #6: `kill_session` precedes `cleanup`.
 *
 * Single-flight guard prevents `wake(id)` and the sweep timer from
 * double-processing the same instance.
 */

import * as fs from 'node:fs';
import type { Database } from './database.ts';
import type {
  AgentInstanceRow,
  AgentTemplateRow,
  ProxyCommand,
  ProxyResponse,
  WsInstanceCompletedEvent,
  WsInstanceFailedEvent,
  WsTopicQueueChangedEvent,
} from '../shared/types.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { TopicDelivery } from './topic-delivery.ts';
import { shellQuote } from '../shared/utils.ts';
import { buildInstanceEnv } from './instance-env.ts';

/**
 * Narrow fs surface the reaper uses. Tests can inject a wrapper that records
 * the order of `statSync` / `readFileSync` calls to verify invariant #5
 * (status + reply read BEFORE `kill_session` dispatch).
 */
export type ReaperFsAdapter = {
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  statSync: (path: string) => { size: number };
};

const defaultFsAdapter: ReaperFsAdapter = {
  readFileSync: (p, e) => fs.readFileSync(p, e),
  statSync: (p) => fs.statSync(p),
};

export type InstanceReaperOptions = {
  db: Database;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  messageDispatcher: MessageDispatcher;
  /** Used to drain the next queued row on completion. */
  topicDelivery: TopicDelivery;
  /** Sweep interval (default 1500ms). */
  sweepIntervalMs?: number;
  /**
   * Test-only seam: inject an fs adapter to observe read ordering vs the
   * proxy command timeline (invariant #5). Production always uses
   * `defaultFsAdapter` which forwards to `node:fs`.
   */
  fsAdapter?: ReaperFsAdapter;
  /**
   * Typed event surface. Mirrors `WsEvent` shapes for the events this
   * module produces (`instance_completed`, `instance_failed`, and the
   * `topic_queue_changed` recompute triggered by the completion sweep).
   */
  onEvent?: (event: ReaperEvent) => void;
};

/**
 * Subset of `WsEvent` produced by the reaper. Mirrors `TopicDeliveryEvent`
 * in shape so `main.ts` can plug a single `wss.broadcastEvent` into either.
 */
export type ReaperEvent =
  | WsInstanceCompletedEvent
  | WsInstanceFailedEvent
  | WsTopicQueueChangedEvent;

const DEFAULT_SWEEP_MS = 1500;

export class InstanceReaper {
  private readonly db: Database;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly messageDispatcher: MessageDispatcher;
  private readonly topicDelivery: TopicDelivery;
  private readonly sweepIntervalMs: number;
  private readonly fs: ReaperFsAdapter;
  private readonly onEvent: NonNullable<InstanceReaperOptions['onEvent']>;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Single-flight set. wake() and sweep() add/remove ids here. */
  private readonly inFlight = new Set<string>();

  constructor(opts: InstanceReaperOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.messageDispatcher = opts.messageDispatcher;
    this.topicDelivery = opts.topicDelivery;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.fs = opts.fsAdapter ?? defaultFsAdapter;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        console.error('[instance-reaper] sweep failed:', (err as Error).message);
      });
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Low-latency wake — called from the `/api/instances/:id/complete` route
   * when an agent signals via `collab complete`. Falls back to the sweep
   * timer if the POST is missed.
   */
  async wake(instanceId: string): Promise<void> {
    const row = this.db.getAgentInstance(instanceId);
    if (!row) return;
    await this.tryFinalize(row);
  }

  /** Iterate every live instance and finalize any whose status path is ready. */
  async sweep(): Promise<void> {
    const rows = this.db.listLiveAgentInstances();
    for (const row of rows) {
      // Only running/completing rows finalize (spawning is too early — the
      // status file may be present from allocation but empty).
      if (row.state !== 'running' && row.state !== 'completing') continue;
      await this.tryFinalize(row).catch((err) => {
        console.error(`[instance-reaper] finalize ${row.id} failed:`, (err as Error).message);
      });
    }
  }

  /**
   * Finalize one instance if its status file is ready. Single-flight via
   * `inFlight` set so wake + sweep can't both run for the same id.
   *
   * Returns true if finalization ran (success or failure), false if not ready.
   */
  async tryFinalize(row: AgentInstanceRow): Promise<boolean> {
    if (this.inFlight.has(row.id)) return false;
    this.inFlight.add(row.id);
    try {
      return await this.finalizeInner(row);
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  private async finalizeInner(row: AgentInstanceRow): Promise<boolean> {
    // Step 1: status file present + non-empty?
    let size: number;
    try {
      size = this.fs.statSync(row.statusPath).size;
    } catch {
      return false; // not yet written
    }
    if (size === 0) return false;

    // Re-read row to make sure another worker hasn't already finalized.
    const fresh = this.db.getAgentInstance(row.id);
    if (!fresh) return false;
    if (fresh.state !== 'running' && fresh.state !== 'completing') return false;

    // ─── Invariant #5: read status + reply BEFORE kill_session ───
    let statusRaw: string;
    let replyRaw: string;
    try {
      statusRaw = this.fs.readFileSync(row.statusPath, 'utf8');
      replyRaw = this.fs.readFileSync(row.replyPath, 'utf8');
    } catch (err) {
      console.error(`[instance-reaper] read failed for ${row.id}: ${(err as Error).message}`);
      return false;
    }
    const firstLine = statusRaw.split('\n', 1)[0]!.trim();
    const status: 'ok' | 'error' = firstLine === 'ok' ? 'ok' : 'error';

    // Step 3: claim 'completing' so wake() and sweep stop racing.
    this.db.updateInstanceState(row.id, 'completing');

    // Step 4: enqueue reply to bare original publisher. Instance-targeted
    // messages never persist in pending_messages — but this is a reply TO a
    // bare agent name (the original publisher), so persistence is fine.
    const replyToAddr = fresh.replyToAddr ?? row.replyToAddr;
    if (replyToAddr) {
      const targetBare = bareNameFromAddress(replyToAddr);
      if (targetBare) {
        const envelope = buildReplyEnvelope(row.messageId, replyRaw, status);
        try {
          this.db.enqueueMessage({
            sourceAgent: row.instanceAddr,
            targetAgent: targetBare,
            envelope,
          });
          // Fire-and-forget delivery attempt. Persistent dispatcher handles retries.
          this.messageDispatcher.tryDeliver(targetBare).catch(() => { /* swallowed */ });
        } catch (err) {
          console.warn(`[instance-reaper] reply enqueue failed for ${row.id}: ${(err as Error).message}`);
        }
      } else {
        console.warn(`[instance-reaper] dropping reply for ${row.id}: replyToAddr "${replyToAddr}" has no bare-name target`);
      }
    }

    // ─── Invariant #6: kill_session precedes cleanup ───
    try {
      const r = await this.proxyDispatch(row.proxyId, {
        action: 'kill_session',
        sessionName: row.tmuxSession,
      });
      if (!r.ok) {
        console.warn(`[instance-reaper] kill_session warning for ${row.id}: ${r.error ?? 'unknown'}`);
      }
    } catch (err) {
      console.warn(`[instance-reaper] kill_session threw for ${row.id}: ${(err as Error).message}`);
    }

    // Step 5: run cleanup hook (best-effort).
    const template = this.db.getAgentTemplate(row.agentTemplate);
    if (template?.hookCleanup) {
      const env = buildInstanceEnv({
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
        replyToAddr: replyToAddr ?? null,
        instanceId: row.id,
        messageContent: '',
      });
      try {
        const cleanupWrapped = wrapWithEnv(template.hookCleanup, env);
        const cleanupCmd: ProxyCommand = template.cwdBase
          ? { action: 'exec', command: cleanupWrapped, cwd: template.cwdBase, timeoutMs: 60_000 }
          : { action: 'exec', command: cleanupWrapped, timeoutMs: 60_000 };
        const r = await this.proxyDispatch(row.proxyId, cleanupCmd);
        if (!r.ok) {
          console.warn(`[instance-reaper] cleanup failed for ${row.id}: ${r.error ?? 'unknown'}`);
        }
      } catch (err) {
        console.warn(`[instance-reaper] cleanup threw for ${row.id}: ${(err as Error).message}`);
      }
    }

    // Step 6 + 7: mark instance + topic_queue terminal.
    const finalState = status === 'ok' ? 'completed' : 'failed';
    this.db.updateInstanceState(row.id, finalState, {
      completedAt: new Date().toISOString(),
      failureReason: status === 'ok' ? null : (statusRaw.split('\n').slice(1).join('\n') || 'agent reported error'),
    });
    if (row.queueId != null) {
      this.db.markTopicQueueCompleted(row.queueId, finalState);
    }

    // Q6: tear down a paired monitor sidecar, if any. Only workers (rows
    // with `monitor_of_instance === null`) trigger monitor teardown — the
    // monitor itself reaching terminal state goes through the normal flow
    // and doesn't recurse. The teardown runs `kill_session` and `cleanup`
    // for the monitor and marks its row `completed` (or `failed` on cleanup
    // error). This happens AFTER the worker's own teardown above so the
    // worker's user-facing reply lands first.
    if (row.monitorOfInstance === null) {
      const monitor = this.db.findMonitorForWorker(row.id);
      if (monitor) {
        await this.tearDownMonitor(monitor);
      }
    }

    // Q4: emit typed lifecycle events. `instance_completed` carries the
    // post-finalize row so subscribers can render terminal state without a
    // round-trip; `instance_failed` additionally exposes `reason` so
    // dashboards can surface the failure message without inspecting the row.
    const finalRow = this.db.getAgentInstance(row.id);
    if (finalRow) {
      if (status === 'ok') {
        this.onEvent({ type: 'instance_completed', instance: finalRow });
      } else {
        this.onEvent({ type: 'instance_failed', instance: finalRow, reason: finalRow.failureReason ?? null });
      }
    }
    // And recompute the queue depth — completion likely freed a slot.
    if (row.spawnedFromTopic) {
      const depth = this.db.countQueuedTopicMessages(row.agentTemplate, row.spawnedFromTopic);
      this.onEvent({
        type: 'topic_queue_changed',
        agentTemplate: row.agentTemplate,
        topic: row.spawnedFromTopic,
        depth,
      });
    }

    // Step 8: drain next queued row.
    if (template) {
      const topics = this.db.getTopicsForTemplate(template.id);
      const topic = topics.find((t) => t.name === (row.spawnedFromTopic ?? ''));
      if (topic) {
        this.topicDelivery.tryDispatch(template as AgentTemplateRow, topic).catch((err) => {
          console.error(`[instance-reaper] post-complete tryDispatch failed: ${(err as Error).message}`);
        });
      }
    }
    return true;
  }

  /**
   * Q6: tear down a monitor sidecar paired with a completed worker.
   *
   * Order: `kill_session` first (matches invariant #6 — engine processes
   * may have files open), then `cleanup` exec, then mark the monitor row
   * `completed` (or `failed` if cleanup errored). Emits the corresponding
   * lifecycle event. Monitors NEVER produce a reply message — they have no
   * `reply_to_addr` and no queue row, so no reply routing happens here.
   *
   * If the monitor was already finalized (e.g. it called `collab complete`
   * before the worker), this is a no-op via the `findMonitorForWorker`
   * filter on `state NOT IN ('completed','failed')`.
   */
  private async tearDownMonitor(monitor: AgentInstanceRow): Promise<void> {
    // Single-flight: protect against a `collab complete` racing this path.
    if (this.inFlight.has(monitor.id)) return;
    this.inFlight.add(monitor.id);
    try {
      // Re-read in case another path already finalized.
      const fresh = this.db.getAgentInstance(monitor.id);
      if (!fresh) return;
      if (fresh.state === 'completed' || fresh.state === 'failed') return;

      // ─── kill_session first ───
      try {
        const r = await this.proxyDispatch(monitor.proxyId, {
          action: 'kill_session',
          sessionName: monitor.tmuxSession,
        });
        if (!r.ok) {
          console.warn(`[instance-reaper] monitor kill_session warning for ${monitor.id}: ${r.error ?? 'unknown'}`);
        }
      } catch (err) {
        console.warn(`[instance-reaper] monitor kill_session threw for ${monitor.id}: ${(err as Error).message}`);
      }

      // ─── cleanup hook (best-effort) ───
      const monitorTemplate = this.db.getAgentTemplate(monitor.agentTemplate);
      let cleanupError: string | null = null;
      if (monitorTemplate?.hookCleanup) {
        const env = buildInstanceEnv({
          messageId: monitor.messageId,
          messagePath: monitor.messagePath,
          replyPath: monitor.replyPath,
          statusPath: monitor.statusPath,
          worktreePath: monitor.worktreePath ?? '',
          cwdBase: monitorTemplate.cwdBase ?? '',
          repoRoot: monitorTemplate.repoRoot ?? monitorTemplate.cwdBase ?? '',
          agentTemplate: monitor.agentTemplate,
          topicName: '',
          instanceAddr: monitor.instanceAddr,
          replyToAddr: null,
          instanceId: monitor.id,
          messageContent: '',
        });
        try {
          const cleanupWrapped = wrapWithEnv(monitorTemplate.hookCleanup, env);
          const cleanupCmd: ProxyCommand = monitorTemplate.cwdBase
            ? { action: 'exec', command: cleanupWrapped, cwd: monitorTemplate.cwdBase, timeoutMs: 60_000 }
            : { action: 'exec', command: cleanupWrapped, timeoutMs: 60_000 };
          const r = await this.proxyDispatch(monitor.proxyId, cleanupCmd);
          if (!r.ok) {
            cleanupError = r.error ?? 'cleanup returned non-ok';
            console.warn(`[instance-reaper] monitor cleanup failed for ${monitor.id}: ${cleanupError}`);
          }
        } catch (err) {
          cleanupError = (err as Error).message;
          console.warn(`[instance-reaper] monitor cleanup threw for ${monitor.id}: ${cleanupError}`);
        }
      }

      // Mark monitor terminal. `ok` on clean cleanup or no cleanup hook;
      // `failed` if the cleanup itself errored.
      const monitorFinal: 'completed' | 'failed' = cleanupError ? 'failed' : 'completed';
      this.db.updateInstanceState(monitor.id, monitorFinal, {
        completedAt: new Date().toISOString(),
        failureReason: cleanupError,
      });
      const monitorFinalRow = this.db.getAgentInstance(monitor.id);
      if (monitorFinalRow) {
        if (monitorFinal === 'completed') {
          this.onEvent({ type: 'instance_completed', instance: monitorFinalRow });
        } else {
          this.onEvent({ type: 'instance_failed', instance: monitorFinalRow, reason: cleanupError });
        }
      }
    } finally {
      this.inFlight.delete(monitor.id);
    }
  }
}

/** Strip optional `agent:` prefix from a bare-or-prefixed address. */
function bareNameFromAddress(addr: string): string | null {
  if (addr.startsWith('agent:')) {
    const rest = addr.slice('agent:'.length);
    // Instance addresses contain `/`. Replies route to bare agents only —
    // anything that doesn't look like a flat name is dropped.
    if (rest.includes('/')) return null;
    return rest.length > 0 ? rest : null;
  }
  if (addr.startsWith('topic:') || addr.startsWith('approval:')) return null;
  return addr.length > 0 ? addr : null;
}

function buildReplyEnvelope(messageId: string, replyRaw: string, status: 'ok' | 'error'): string {
  // Trim trailing newline but preserve internal structure.
  const trimmed = replyRaw.replace(/\n+$/, '');
  const tag = status === 'ok' ? 'reply' : 'reply-error';
  return `[${tag} for ${messageId}] ${trimmed}`;
}

function wrapWithEnv(command: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  return `export ${assignments}; ${command}`;
}
