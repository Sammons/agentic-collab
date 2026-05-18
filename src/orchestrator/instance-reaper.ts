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

import { readFileSync, statSync } from 'node:fs';
import type { Database } from './database.ts';
import type {
  AgentInstanceRow,
  AgentTemplateRow,
  ProxyCommand,
  ProxyResponse,
} from '../shared/types.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { TopicDelivery, TopicDeliveryEvent } from './topic-delivery.ts';
import { shellQuote } from '../shared/utils.ts';
import { buildInstanceEnv } from './instance-env.ts';

export type InstanceReaperOptions = {
  db: Database;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  messageDispatcher: MessageDispatcher;
  /** Used to drain the next queued row on completion. */
  topicDelivery: TopicDelivery;
  /** Sweep interval (default 1500ms). */
  sweepIntervalMs?: number;
  onEvent?: (event: TopicDeliveryEvent | { type: 'instance-completed'; instance: AgentInstanceRow }) => void;
};

const DEFAULT_SWEEP_MS = 1500;

export class InstanceReaper {
  private readonly db: Database;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly messageDispatcher: MessageDispatcher;
  private readonly topicDelivery: TopicDelivery;
  private readonly sweepIntervalMs: number;
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
      size = statSync(row.statusPath).size;
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
      statusRaw = readFileSync(row.statusPath, 'utf8');
      replyRaw = readFileSync(row.replyPath, 'utf8');
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

    const finalRow = this.db.getAgentInstance(row.id);
    if (finalRow) {
      this.onEvent({ type: status === 'ok' ? 'instance-completed' : 'instance-failed', instance: finalRow, reason: finalRow.failureReason ?? '' } as TopicDeliveryEvent);
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
