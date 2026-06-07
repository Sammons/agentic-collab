/**
 * Topic delivery — v3 Q3 kernel.
 *
 * Drives the topic-publish → spawn → run vertical slice. The completion side
 * (status sweep, reply routing, kill_session, cleanup) lives in
 * `instance-reaper.ts`. Together they form the ephemeral lifecycle.
 *
 * Delivery sequence per `docs/v3-vision.md §"Topic delivery contract"` and
 * `docs/quanta/Q3-plan-revised.md §"Updated delivery sequence"`:
 *
 *   1. db.claimAndCreateInstance — atomic claim + agent_instances insert
 *   2. allocateIpcPaths + write payload to MESSAGE_PATH
 *   3. exec(prepare, cwd=cwdBase, timeoutMs=60_000)
 *   4. create_session(sessionName, cwd=cwdBase)
 *   5. exec("tmux set-environment ...") × N — once per env-contract key
 *   6. resolveHook('start', template.hook_start, syntheticAgent, ...)
 *      + dispatchHookResult — paste the start hook into the session
 *   7. db.updateInstanceState(id, 'running')
 *
 * Steps 5-6 implement ordering invariants #3 and #4 from
 * `docs/v3-upgrade-prompt.md §Q3`: every `tmux set-environment` exec runs
 * after `create_session` and before the first `paste`.
 *
 * On failure at any step, the instance + queue row are marked failed and
 * `cleanup` is best-effort dispatched if `prepare` already ran (step 3+).
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from './database.ts';
import type {
  AgentInstanceRow,
  AgentRecord,
  AgentTemplateRow,
  ProxyCommand,
  ProxyResponse,
  TopicRow,
  WsInstanceFailedEvent,
  WsInstanceSpawnedEvent,
  WsTopicQueueChangedEvent,
} from '../shared/types.ts';
import { shellQuote } from '../shared/utils.ts';
import { resolveHook } from './hook-resolver.ts';
import { dispatchHookResult, type LifecycleContext } from './lifecycle.ts';
import { allocateIpcPaths, buildHostShellEnv, buildTmuxSessionEnv } from './instance-env.ts';
import type { LockManager } from '../shared/lock.ts';

export type TopicDeliveryOptions = {
  db: Database;
  /** Proxy dispatcher reused from main.ts (with dynamic exec timeout). */
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  /** Orchestrator host (for collab CLI back-pointers, env CWD, etc.). */
  orchestratorHost: string;
  /** Root directory under which per-instance IPC files live. */
  ipcRoot: string;
  /**
   * Real LockManager so `dispatchHookResult` can lock the instance pane if
   * captures or pipeline steps demand it. Required — pass the orchestrator's
   * shared LockManager. Tests construct their own with `new LockManager(db.rawDb)`.
   */
  locks: LockManager;
  /** Resolver returning a proxy id to spawn on. Defaults to first registered. */
  resolveProxyId?: () => string | null;
  /**
   * Optional WS broadcast surface — receives typed `WsEvent`-shaped
   * payloads that callers (orchestrator main.ts) forward verbatim through
   * `wss.broadcast(JSON.stringify(event))`. Q4 wired this with snake-case
   * `type` discriminants to match the dashboard's existing conventions.
   */
  onEvent?: (event: TopicDeliveryEvent) => void;
};

/**
 * Subset of `WsEvent` produced by this driver. Lives here (not on
 * `WsEvent` itself) so test harnesses can capture the union without
 * importing the full WS server type. The shapes are intentionally
 * identical to the corresponding `Ws*` types in `shared/types.ts`.
 */
export type TopicDeliveryEvent =
  | WsInstanceSpawnedEvent
  | WsInstanceFailedEvent
  | WsTopicQueueChangedEvent;

/** Concise outcome surface for routes/tests. */
export type PublishResult = {
  ok: true;
  queueId: number;
  templateId: string;
  topicName: string;
} | {
  ok: false;
  reason: string;
};

/**
 * Driver class. `publish()` enqueues a `topic_queue` row; `tryDispatch()`
 * runs the claim-and-spawn loop until concurrency caps are hit or the
 * queue drains. `instance-reaper.ts` calls `tryDispatch` again on each
 * completion so the next queued row spawns immediately.
 */
export class TopicDelivery {
  private readonly db: Database;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly ipcRoot: string;
  private readonly resolveProxyId: () => string | null;
  private readonly onEvent: (event: TopicDeliveryEvent) => void;
  private readonly lifecycleCtx: LifecycleContext;

  constructor(opts: TopicDeliveryOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.ipcRoot = opts.ipcRoot;
    this.resolveProxyId = opts.resolveProxyId ?? (() => {
      const proxies = this.db.listProxies();
      return proxies.length > 0 ? proxies[0]!.proxyId : null;
    });
    this.onEvent = opts.onEvent ?? (() => {});
    this.lifecycleCtx = {
      db: this.db,
      locks: opts.locks,
      proxyDispatch: this.proxyDispatch,
      orchestratorHost: opts.orchestratorHost,
    };
  }

  /**
   * Public entry-point for a `topic:` send. Validates the template + topic
   * exist, enqueues a row, kicks off dispatch.
   */
  async publish(opts: {
    agentTemplate: string;
    topicName: string;
    payload: string;
    replyToAddr?: string | null;
    inReplyTo?: string | null;
  }): Promise<PublishResult> {
    const template = this.db.getAgentTemplate(opts.agentTemplate);
    if (!template) {
      return { ok: false, reason: `template "${opts.agentTemplate}" not found` };
    }
    if (template.persistent) {
      return { ok: false, reason: `template "${opts.agentTemplate}" is persistent — not addressable by topic:` };
    }
    const topics = this.db.getTopicsForTemplate(opts.agentTemplate);
    const topic = topics.find((t) => t.name === opts.topicName);
    if (!topic) {
      return { ok: false, reason: `topic "${opts.topicName}" not declared on template "${opts.agentTemplate}"` };
    }

    const row = this.db.enqueueTopicMessage({
      agentTemplate: opts.agentTemplate,
      topicName: opts.topicName,
      payload: opts.payload,
      replyToAddr: opts.replyToAddr ?? null,
      inReplyTo: opts.inReplyTo ?? null,
    });

    this.broadcastDepth(opts.agentTemplate, opts.topicName);

    // Fire-and-forget dispatch loop. Failures inside `tryDispatch` get
    // reflected through the instance row + event channel, not the publish
    // response (publish is fire-and-forget per v3 contract).
    this.tryDispatch(template, topic).catch((err) => {
      console.error(`[topic-delivery] tryDispatch failed for ${opts.agentTemplate}/${opts.topicName}:`, (err as Error).message);
    });

    return { ok: true, queueId: row.id, templateId: opts.agentTemplate, topicName: opts.topicName };
  }

  /**
   * Drain the topic's queue subject to its per-topic concurrency cap. Called
   * after publish and after each completion. Multiple concurrent topics can
   * dispatch in parallel — only the per-topic cap is enforced here.
   */
  async tryDispatch(template: AgentTemplateRow, topic: TopicRow): Promise<void> {
    while (true) {
      const proxyId = this.resolveProxyId();
      if (!proxyId) {
        console.warn(`[topic-delivery] No proxy registered — deferring dispatch for ${template.id}/${topic.name}`);
        return;
      }

      const instanceId = generateInstanceId();
      const suffix = generateSuffix();
      const instanceAddr = `agent:${template.id}-${suffix}`;
      const tmuxSession = `inst-${template.id}-${suffix}`.slice(0, 200); // tmux 256 char limit safety
      const ipc = allocateIpcPaths(instanceId, this.ipcRoot);

      const cwdBase = template.cwdBase ?? '';
      const repoRoot = template.repoRoot ?? cwdBase;
      const worktreePath = renderCwdTemplate(template.cwdTemplate, { messageId: instanceId, cwdBase });

      // Invariant #1: the live-count check lives INSIDE this transaction.
      // claimAndCreateInstance returns null both when the queue is empty AND
      // when the concurrency cap is hit — either way we stop draining.
      const claim = this.db.claimAndCreateInstance({
        agentTemplate: template.id,
        topicName: topic.name,
        instanceId,
        instanceAddr,
        tmuxSession,
        proxyId,
        messageId: instanceId,
        messagePath: ipc.messagePath,
        replyPath: ipc.replyPath,
        statusPath: ipc.statusPath,
        worktreePath,
        suffix,
        concurrency: topic.concurrency,
      });
      if (!claim) return; // queue empty OR concurrency cap hit — done draining

      const { queue, instance } = claim;
      this.broadcastDepth(template.id, topic.name);

      // Step 2: write the actual payload to MESSAGE_PATH.
      try {
        writeFileSync(ipc.messagePath, queue.payload);
      } catch (err) {
        this.failInstance(instance, queue.id, `failed to write MESSAGE_PATH: ${(err as Error).message}`, false);
        continue;
      }

      // Build two env views. `hostShellEnv` includes MESSAGE_CONTENT for
      // prepare/cleanup `exec` host-shell wrappers (newlines and control
      // chars survive shell quoting). `tmuxSessionEnv` excludes
      // MESSAGE_CONTENT — payloads with newlines or large size would corrupt
      // `tmux set-environment`. Agents read payload from $MESSAGE_PATH.
      const hostShellEnv = buildHostShellEnv({
        messageId: instance.messageId,
        messagePath: instance.messagePath,
        replyPath: instance.replyPath,
        statusPath: instance.statusPath,
        worktreePath: worktreePath ?? '',
        cwdBase,
        repoRoot,
        agentTemplate: template.id,
        topicName: topic.name,
        instanceAddr,
        replyToAddr: queue.replyToAddr,
        instanceId,
        messageContent: queue.payload,
      });
      const tmuxSessionEnv = buildTmuxSessionEnv(hostShellEnv);

      // ──────────────────────────────────────────────────────────────
      // Fire-and-forget the per-instance spawn so the loop can drain other
      // topics in parallel even when one spawn is in its slow prepare step.
      // ──────────────────────────────────────────────────────────────
      this.claimAndSpawn({ template, topic, instance, hostShellEnv, tmuxSessionEnv, queueId: queue.id, proxyId }).catch((err) => {
        console.error(`[topic-delivery] claimAndSpawn failed for ${instance.id}:`, (err as Error).message);
      });
    }
  }

  /**
   * Run steps 3-7 of the delivery sequence (prepare → create_session →
   * set-environment × N → paste(start) → mark running). Failures roll the
   * instance to `failed` and run cleanup best-effort if prepare ran.
   */
  private async claimAndSpawn(opts: {
    template: AgentTemplateRow;
    topic: TopicRow;
    instance: AgentInstanceRow;
    /** Full env including MESSAGE_CONTENT — used in `exec` host-shell wrappers. */
    hostShellEnv: Record<string, string>;
    /** Subset excluding MESSAGE_CONTENT — used for `tmux set-environment`. */
    tmuxSessionEnv: Record<string, string>;
    queueId: number;
    proxyId: string;
  }): Promise<void> {
    const { template, topic, instance, hostShellEnv, tmuxSessionEnv, queueId, proxyId } = opts;
    const cwdBase = template.cwdBase ?? '';
    const tmuxSession = instance.tmuxSession;

    // Step 3 — prepare via host shell exec (no tmux). Apply env via the
    // proxy `exec` env contract: prepend `KEY=value` assignments so the
    // child process and any forked shells see the contract values. The
    // host shell handles newlines/quoting in MESSAGE_CONTENT correctly.
    const prepareSrc = topic.hookPrepareOverride ?? template.hookPrepare;
    let prepareRan = false;
    if (prepareSrc) {
      const prepareWrapped = wrapWithEnv(prepareSrc, hostShellEnv);
      try {
        const r = await this.proxyDispatch(proxyId, {
          action: 'exec',
          command: prepareWrapped,
          cwd: cwdBase,
          timeoutMs: 60_000,
        });
        if (!r.ok) {
          this.failInstance(instance, queueId, `prepare failed: ${r.error ?? 'unknown'}`, false);
          return;
        }
        prepareRan = true;
      } catch (err) {
        this.failInstance(instance, queueId, `prepare threw: ${(err as Error).message}`, false);
        return;
      }
    }

    // Step 4 — create_session against cwd_base (a real directory).
    try {
      const r = await this.proxyDispatch(proxyId, {
        action: 'create_session',
        sessionName: tmuxSession,
        cwd: cwdBase,
      });
      if (!r.ok) {
        this.failInstance(instance, queueId, `create_session failed: ${r.error ?? 'unknown'}`, prepareRan, { template, env: hostShellEnv, proxyId, cwdBase });
        return;
      }
    } catch (err) {
      this.failInstance(instance, queueId, `create_session threw: ${(err as Error).message}`, prepareRan, { template, env: hostShellEnv, proxyId, cwdBase });
      return;
    }

    // Step 5 — push the env contract into the tmux session via
    // `tmux set-environment`. Each call dispatched as `exec` per Q3 plan §B1.
    // All set-environment calls must precede the first `paste` — invariant #4.
    // MESSAGE_CONTENT is intentionally EXCLUDED from this loop (payloads with
    // newlines or control chars corrupt tmux env); agents read it from
    // `$MESSAGE_PATH` instead.
    try {
      await this.dispatchTmuxSetEnv(proxyId, tmuxSession, tmuxSessionEnv);
    } catch (err) {
      this.failInstance(instance, queueId, `tmux set-environment failed: ${(err as Error).message}`, prepareRan, { template, env: hostShellEnv, proxyId, cwdBase, killSession: tmuxSession });
      return;
    }

    // Step 6 — resolve and paste the `start` hook. Uses the unified resolver
    // so structured / file: / preset: forms all work. We pass the full host
    // env as templateVars so {{MESSAGE_CONTENT}} interpolation still works
    // when start hooks need the payload literally.
    const startSrc = topic.hookStartOverride ?? template.hookStart;
    const syntheticAgent = buildSyntheticAgent(template);
    try {
      const result = resolveHook('start', startSrc ?? null, syntheticAgent, { templateVars: hostShellEnv });
      await dispatchHookResult(this.lifecycleCtx, proxyId, tmuxSession, result, { pressEnter: true });
    } catch (err) {
      this.failInstance(instance, queueId, `start hook failed: ${(err as Error).message}`, prepareRan, { template, env: hostShellEnv, proxyId, cwdBase, killSession: tmuxSession });
      return;
    }

    // Step 7 — mark running. Reaper takes over from here. Emit
    // `instance_spawned` with the post-update row so subscribers see the
    // running state directly (Q4 contract).
    this.db.updateInstanceState(instance.id, 'running');
    const refreshed = this.db.getAgentInstance(instance.id);
    if (refreshed) {
      this.onEvent({ type: 'instance_spawned', instance: refreshed });
    }

    // Step 8 — Q6 monitor sidecar pairing. If the topic declares a
    // `monitor_template`, spawn the monitor alongside the worker using the
    // same kernel (prepare → create_session → set-env × N → start hook), but
    // with `$TARGET_TMUX_SESSION` set to the worker's tmux session.
    //
    // Cycle protection: only the original worker spawn pairs a monitor.
    // A monitor (`monitorOfInstance` non-null) NEVER spawns its own monitor,
    // even if its template happens to declare one. This guards against
    // infinite recursion if someone wires up monitor-of-monitor by mistake.
    if (topic.monitorTemplate && instance.monitorOfInstance === null) {
      try {
        await this.spawnMonitor({
          workerInstance: refreshed ?? instance,
          monitorTemplateId: topic.monitorTemplate,
          proxyId,
        });
      } catch (err) {
        // Monitor is best-effort — worker continues regardless.
        console.warn(`[topic-delivery] monitor spawn failed for worker ${instance.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Spawn a monitor sidecar paired with a worker. Runs the same lifecycle as
   * a regular topic spawn (prepare → create_session → set-env × N → start),
   * but inserts a plain `agent_instances` row (no topic_queue claim) and
   * passes `TARGET_TMUX_SESSION` in the tmux env so the monitor's start hook
   * can attach to the worker's pane (capture-pane / send-keys).
   *
   * Failures here log a warning and mark the monitor row failed; the worker
   * is untouched.
   */
  private async spawnMonitor(opts: {
    workerInstance: AgentInstanceRow;
    monitorTemplateId: string;
    proxyId: string;
  }): Promise<void> {
    const { workerInstance, monitorTemplateId, proxyId } = opts;
    const monitorTemplate = this.db.getAgentTemplate(monitorTemplateId);
    if (!monitorTemplate) {
      console.warn(`[topic-delivery] monitor template "${monitorTemplateId}" not found — skipping monitor for worker ${workerInstance.id}`);
      return;
    }
    if (monitorTemplate.persistent) {
      console.warn(`[topic-delivery] monitor template "${monitorTemplateId}" is persistent — only ephemeral templates can be monitors; skipping for worker ${workerInstance.id}`);
      return;
    }

    const monitorId = generateInstanceId();
    const monitorSuffix = generateSuffix();
    const monitorAddr = `agent:${monitorTemplate.id}-${monitorSuffix}`;
    const monitorTmuxSession = `inst-${monitorTemplate.id}-${monitorSuffix}`.slice(0, 200);
    const monitorIpc = allocateIpcPaths(monitorId, this.ipcRoot);
    const cwdBase = monitorTemplate.cwdBase ?? '';
    const repoRoot = monitorTemplate.repoRoot ?? cwdBase;
    const worktreePath = renderCwdTemplate(monitorTemplate.cwdTemplate, {
      messageId: monitorId,
      cwdBase,
    });

    // Insert the monitor row BEFORE any proxy command so address resolution
    // and `findMonitorForWorker` work as soon as the row commits.
    let monitorRow: AgentInstanceRow;
    try {
      monitorRow = this.db.createMonitorInstance({
        id: monitorId,
        agentTemplate: monitorTemplate.id,
        monitorOfInstance: workerInstance.id,
        instanceAddr: monitorAddr,
        tmuxSession: monitorTmuxSession,
        worktreePath,
        messagePath: monitorIpc.messagePath,
        replyPath: monitorIpc.replyPath,
        statusPath: monitorIpc.statusPath,
        proxyId,
        suffix: monitorSuffix,
      });
    } catch (err) {
      console.warn(`[topic-delivery] failed to insert monitor row for worker ${workerInstance.id}: ${(err as Error).message}`);
      return;
    }

    // Build envs. Monitors have no publish payload, so MESSAGE_CONTENT is
    // intentionally empty. `TARGET_TMUX_SESSION` is added to the tmux env via
    // buildTmuxSessionEnv(...) — the host-shell env doesn't include it because
    // prepare/cleanup run on the host filesystem and have no concept of the
    // worker session.
    const hostShellEnv = buildHostShellEnv({
      messageId: monitorId,
      messagePath: monitorRow.messagePath,
      replyPath: monitorRow.replyPath,
      statusPath: monitorRow.statusPath,
      worktreePath: worktreePath ?? '',
      cwdBase,
      repoRoot,
      agentTemplate: monitorTemplate.id,
      topicName: '',
      instanceAddr: monitorAddr,
      replyToAddr: null,
      instanceId: monitorId,
      messageContent: '',
    });
    const tmuxSessionEnv = buildTmuxSessionEnv(hostShellEnv, {
      targetTmuxSession: workerInstance.tmuxSession,
    });

    // Step 3 — prepare via host shell exec.
    const prepareSrc = monitorTemplate.hookPrepare;
    let prepareRan = false;
    if (prepareSrc) {
      const prepareWrapped = wrapWithEnv(prepareSrc, hostShellEnv);
      try {
        const r = await this.proxyDispatch(proxyId, {
          action: 'exec',
          command: prepareWrapped,
          cwd: cwdBase,
          timeoutMs: 60_000,
        });
        if (!r.ok) {
          this.failMonitor(monitorRow, `prepare failed: ${r.error ?? 'unknown'}`, false);
          return;
        }
        prepareRan = true;
      } catch (err) {
        this.failMonitor(monitorRow, `prepare threw: ${(err as Error).message}`, false);
        return;
      }
    }

    // Step 4 — create_session against cwd_base.
    try {
      const r = await this.proxyDispatch(proxyId, {
        action: 'create_session',
        sessionName: monitorTmuxSession,
        cwd: cwdBase,
      });
      if (!r.ok) {
        this.failMonitor(monitorRow, `create_session failed: ${r.error ?? 'unknown'}`, prepareRan, { template: monitorTemplate, env: hostShellEnv, proxyId, cwdBase });
        return;
      }
    } catch (err) {
      this.failMonitor(monitorRow, `create_session threw: ${(err as Error).message}`, prepareRan, { template: monitorTemplate, env: hostShellEnv, proxyId, cwdBase });
      return;
    }

    // Step 5 — set-env × N (includes TARGET_TMUX_SESSION).
    try {
      await this.dispatchTmuxSetEnv(proxyId, monitorTmuxSession, tmuxSessionEnv);
    } catch (err) {
      this.failMonitor(monitorRow, `tmux set-environment failed: ${(err as Error).message}`, prepareRan, { template: monitorTemplate, env: hostShellEnv, proxyId, cwdBase, killSession: monitorTmuxSession });
      return;
    }

    // Step 6 — start hook paste.
    const syntheticAgent = buildSyntheticAgent(monitorTemplate);
    try {
      const result = resolveHook('start', monitorTemplate.hookStart ?? null, syntheticAgent, { templateVars: hostShellEnv });
      await dispatchHookResult(this.lifecycleCtx, proxyId, monitorTmuxSession, result, { pressEnter: true });
    } catch (err) {
      this.failMonitor(monitorRow, `start hook failed: ${(err as Error).message}`, prepareRan, { template: monitorTemplate, env: hostShellEnv, proxyId, cwdBase, killSession: monitorTmuxSession });
      return;
    }

    // Mark running.
    this.db.updateInstanceState(monitorRow.id, 'running');
    const refreshed = this.db.getAgentInstance(monitorRow.id);
    if (refreshed) {
      this.onEvent({ type: 'instance_spawned', instance: refreshed });
    }
  }

  /**
   * Failure path specific to monitor spawn. Mirrors `failInstance` but
   * doesn't touch any topic_queue row (monitors have none) and emits the
   * `instance_failed` event with a synthetic monitor reason.
   */
  private failMonitor(
    monitorRow: AgentInstanceRow,
    reason: string,
    runCleanup: boolean,
    cleanupOpts?: { template: AgentTemplateRow; env: Record<string, string>; proxyId: string; cwdBase: string; killSession?: string },
  ): void {
    console.warn(`[topic-delivery] monitor ${monitorRow.id} failed: ${reason}`);
    this.db.updateInstanceState(monitorRow.id, 'failed', {
      completedAt: new Date().toISOString(),
      failureReason: reason,
    });
    const refreshed = this.db.getAgentInstance(monitorRow.id) ?? monitorRow;
    this.onEvent({ type: 'instance_failed', instance: refreshed, reason });

    if (runCleanup && cleanupOpts && cleanupOpts.template.hookCleanup) {
      const cleanupWrapped = wrapWithEnv(cleanupOpts.template.hookCleanup, cleanupOpts.env);
      this.proxyDispatch(cleanupOpts.proxyId, {
        action: 'exec',
        command: cleanupWrapped,
        cwd: cleanupOpts.cwdBase,
        timeoutMs: 60_000,
      }).catch((err) => {
        console.warn(`[topic-delivery] best-effort monitor cleanup failed for ${monitorRow.id}: ${(err as Error).message}`);
      });
    }
    if (cleanupOpts?.killSession) {
      this.proxyDispatch(cleanupOpts.proxyId, {
        action: 'kill_session',
        sessionName: cleanupOpts.killSession,
      }).catch(() => { /* ignore */ });
    }
  }

  /**
   * Dispatch one `exec(tmux set-environment ...)` per key. All before the
   * first `paste(start)` — see invariant #4.
   */
  private async dispatchTmuxSetEnv(proxyId: string, sessionName: string, env: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(env)) {
      const command = `tmux set-environment -t ${shellQuote(sessionName)} ${shellQuote(key)} ${shellQuote(value)}`;
      const r = await this.proxyDispatch(proxyId, {
        action: 'exec',
        command,
        timeoutMs: 5_000,
      });
      if (!r.ok) {
        throw new Error(`set-env ${key}: ${r.error ?? 'unknown'}`);
      }
    }
  }

  /**
   * Mark an instance failed, mark the topic_queue row failed, optionally run
   * cleanup best-effort, optionally kill the tmux session.
   */
  private failInstance(
    instance: AgentInstanceRow,
    queueId: number,
    reason: string,
    runCleanup: boolean,
    cleanupOpts?: { template: AgentTemplateRow; env: Record<string, string>; proxyId: string; cwdBase: string; killSession?: string },
  ): void {
    console.error(`[topic-delivery] instance ${instance.id} failed: ${reason}`);
    this.db.updateInstanceState(instance.id, 'failed', {
      completedAt: new Date().toISOString(),
      failureReason: reason,
    });
    this.db.markTopicQueueCompleted(queueId, 'failed');
    // Q4: emit `topic_queue_changed` after the queue-row state flips so
    // subscribers see depth recover even when spawn fails early.
    this.broadcastDepth(instance.agentTemplate, instance.spawnedFromTopic ?? '');
    const refreshed = this.db.getAgentInstance(instance.id) ?? instance;
    this.onEvent({ type: 'instance_failed', instance: refreshed, reason });

    if (runCleanup && cleanupOpts && cleanupOpts.template.hookCleanup) {
      const cleanupWrapped = wrapWithEnv(cleanupOpts.template.hookCleanup, cleanupOpts.env);
      this.proxyDispatch(cleanupOpts.proxyId, {
        action: 'exec',
        command: cleanupWrapped,
        cwd: cleanupOpts.cwdBase,
        timeoutMs: 60_000,
      }).catch((err) => {
        console.warn(`[topic-delivery] best-effort cleanup failed for ${instance.id}: ${(err as Error).message}`);
      });
    }
    if (cleanupOpts?.killSession) {
      this.proxyDispatch(cleanupOpts.proxyId, {
        action: 'kill_session',
        sessionName: cleanupOpts.killSession,
      }).catch(() => { /* ignore */ });
    }
  }

  /**
   * Emit `topic_queue_changed` with the current queued depth per Q4 spec.
   * Depth is the count of `topic_queue` rows in `status='queued'` for the
   * given (template, topic) pair — i.e. work still waiting to be claimed,
   * not live instances. Guard against empty topic names (defensive — the
   * fail path constructs them from row data that may be null on malformed
   * runs).
   */
  private broadcastDepth(agentTemplate: string, topicName: string): void {
    if (!topicName) return;
    const depth = this.db.countQueuedTopicMessages(agentTemplate, topicName);
    this.onEvent({ type: 'topic_queue_changed', agentTemplate, topic: topicName, depth });
  }
}

/**
 * Random base64url-ish id, 16 chars. Stable enough to fit `NAME_RE` /
 * `INSTANCE_ID_RE` (alnum start, [a-zA-Z0-9_-] body).
 */
function generateInstanceId(): string {
  const uuid = randomUUID().replace(/-/g, '');
  return uuid.slice(0, 16);
}

/**
 * Generate a 6-char hex suffix for human-readable ephemeral naming.
 * e.g., "7f3a2b" → instance displays as "researcher-7f3a2b"
 */
function generateSuffix(): string {
  const uuid = randomUUID().replace(/-/g, '');
  return uuid.slice(0, 6).toLowerCase();
}

/** Render `cwd_template` placeholders. Supports `{{message_id}}`. */
function renderCwdTemplate(template: string | null, vars: { messageId: string; cwdBase: string }): string | null {
  if (!template) return null;
  return template
    .replace(/\{\{\s*message_id\s*\}\}/g, vars.messageId)
    .replace(/\{\{\s*cwd_base\s*\}\}/g, vars.cwdBase);
}

/**
 * Prepend env-contract assignments to a host-shell command. The proxy
 * `exec` command spawns this through `execSync`, which forks `/bin/sh -c`,
 * so leading `KEY=value` assignments propagate to the child.
 */
function wrapWithEnv(command: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  return `export ${assignments}; ${command}`;
}

/**
 * Build a minimal `AgentRecord` shim for the resolver. Only engine + model
 * are read by `resolvePreset` when `start: null` falls through to adapter
 * defaults; all other fields default to null/0/'active' to keep typing happy.
 */
function buildSyntheticAgent(template: AgentTemplateRow): AgentRecord {
  return {
    name: template.id,
    engine: template.engine as AgentRecord['engine'],
    model: template.model,
    thinking: null,
    cwd: template.cwdBase ?? '',
    persona: null,
    permissions: null,
    agentGroup: null,
    launchEnv: null,
    account: null,
    sortOrder: 0,
    hookStart: template.hookStart,
    hookResume: null,
    hookCompact: null,
    hookExit: template.hookExit,
    hookInterrupt: null,
    hookReload: null,
    hookSubmit: null,
    state: 'active',
    stateBeforeShutdown: null,
    currentSessionId: null,
    tmuxSession: null,
    proxyId: null,
    lastActivity: null,
    lastContextPct: null,
    reloadQueued: 0,
    reloadTask: null,
    failedAt: null,
    failureReason: null,
    capturedVars: null,
    customButtons: null,
    indicators: null,
    icon: null,
    agentTelegram: null,
    version: 0,
    spawnCount: 0,
    createdAt: '',
  };
}

// Silence unused-import warning — `dirname`/`join` are kept for callers that
// may want to compose IPC paths from this module directly.
void dirname;
void join;
