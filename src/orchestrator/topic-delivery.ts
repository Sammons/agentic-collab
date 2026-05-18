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
} from '../shared/types.ts';
import { shellQuote } from '../shared/utils.ts';
import { resolveHook } from './hook-resolver.ts';
import { dispatchHookResult, type LifecycleContext } from './lifecycle.ts';
import { allocateIpcPaths, buildInstanceEnv } from './instance-env.ts';

export type TopicDeliveryOptions = {
  db: Database;
  /** Proxy dispatcher reused from main.ts (with dynamic exec timeout). */
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  /** Orchestrator host (for collab CLI back-pointers, env CWD, etc.). */
  orchestratorHost: string;
  /** Root directory under which per-instance IPC files live. */
  ipcRoot: string;
  /** Resolver returning a proxy id to spawn on. Defaults to first registered. */
  resolveProxyId?: () => string | null;
  /** Optional WS broadcast for `instance-spawned` / `instance-failed` events. */
  onEvent?: (event: TopicDeliveryEvent) => void;
};

export type TopicDeliveryEvent =
  | { type: 'instance-spawned'; instance: AgentInstanceRow }
  | { type: 'instance-failed'; instance: AgentInstanceRow; reason: string }
  | { type: 'topic-queue-changed'; agentTemplate: string; topicName: string; depth: number };

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
      // Lifecycle uses its own LockManager etc. — we only use dispatchHookResult
      // which reads from ctx.proxyDispatch only. Pass minimal shim.
      locks: undefined as unknown as LifecycleContext['locks'],
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
      const live = this.db.countLiveInstancesForTopic(template.id, topic.name);
      if (live >= topic.concurrency) return;

      const proxyId = this.resolveProxyId();
      if (!proxyId) {
        console.warn(`[topic-delivery] No proxy registered — deferring dispatch for ${template.id}/${topic.name}`);
        return;
      }

      const instanceId = generateInstanceId();
      const instanceAddr = `agent:${template.id}/${instanceId}`;
      const tmuxSession = `inst-${template.id}-${instanceId}`;
      const ipc = allocateIpcPaths(instanceId, this.ipcRoot);

      const cwdBase = template.cwdBase ?? '';
      const repoRoot = template.repoRoot ?? cwdBase;
      const worktreePath = renderCwdTemplate(template.cwdTemplate, { messageId: instanceId, cwdBase });

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
      });
      if (!claim) return; // queue is empty — done draining

      const { queue, instance } = claim;
      this.broadcastDepth(template.id, topic.name);

      // Step 2: write the actual payload to MESSAGE_PATH.
      try {
        writeFileSync(ipc.messagePath, queue.payload);
      } catch (err) {
        this.failInstance(instance, queue.id, `failed to write MESSAGE_PATH: ${(err as Error).message}`, false);
        continue;
      }

      // Build the env contract used for prepare/start interpolation AND for
      // tmux set-environment between create_session and paste(start).
      const env = buildInstanceEnv({
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

      // ──────────────────────────────────────────────────────────────
      // Fire-and-forget the per-instance spawn so the loop can drain other
      // topics in parallel even when one spawn is in its slow prepare step.
      // ──────────────────────────────────────────────────────────────
      this.claimAndSpawn({ template, topic, instance, env, queueId: queue.id, proxyId }).catch((err) => {
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
    env: Record<string, string>;
    queueId: number;
    proxyId: string;
  }): Promise<void> {
    const { template, topic, instance, env, queueId, proxyId } = opts;
    const cwdBase = template.cwdBase ?? '';
    const tmuxSession = instance.tmuxSession;

    // Step 3 — prepare via host shell exec (no tmux). Apply env via the
    // proxy `exec` env contract: prepend `KEY=value` assignments so the
    // child process and any forked shells see the contract values.
    const prepareSrc = topic.hookPrepareOverride ?? template.hookPrepare;
    let prepareRan = false;
    if (prepareSrc) {
      const prepareWrapped = wrapWithEnv(prepareSrc, env);
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
        this.failInstance(instance, queueId, `create_session failed: ${r.error ?? 'unknown'}`, prepareRan, { template, env, proxyId, cwdBase });
        return;
      }
    } catch (err) {
      this.failInstance(instance, queueId, `create_session threw: ${(err as Error).message}`, prepareRan, { template, env, proxyId, cwdBase });
      return;
    }

    // Step 5 — push the env contract into the tmux session via
    // `tmux set-environment`. Each call dispatched as `exec` per Q3 plan §B1.
    // All set-environment calls must precede the first `paste` — invariant #4.
    try {
      await this.dispatchTmuxSetEnv(proxyId, tmuxSession, env);
    } catch (err) {
      this.failInstance(instance, queueId, `tmux set-environment failed: ${(err as Error).message}`, prepareRan, { template, env, proxyId, cwdBase, killSession: tmuxSession });
      return;
    }

    // Step 6 — resolve and paste the `start` hook. Uses the unified resolver
    // so structured / file: / preset: forms all work.
    const startSrc = topic.hookStartOverride ?? template.hookStart;
    const syntheticAgent = buildSyntheticAgent(template);
    try {
      const result = resolveHook('start', startSrc ?? null, syntheticAgent, { templateVars: env });
      await dispatchHookResult(this.lifecycleCtx, proxyId, tmuxSession, result, { pressEnter: true });
    } catch (err) {
      this.failInstance(instance, queueId, `start hook failed: ${(err as Error).message}`, prepareRan, { template, env, proxyId, cwdBase, killSession: tmuxSession });
      return;
    }

    // Step 7 — mark running. Reaper takes over from here.
    this.db.updateInstanceState(instance.id, 'running');
    const refreshed = this.db.getAgentInstance(instance.id);
    if (refreshed) {
      this.onEvent({ type: 'instance-spawned', instance: refreshed });
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
    const refreshed = this.db.getAgentInstance(instance.id) ?? instance;
    this.onEvent({ type: 'instance-failed', instance: refreshed, reason });

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

  private broadcastDepth(agentTemplate: string, topicName: string): void {
    const depth = this.db.countLiveInstancesForTopic(agentTemplate, topicName);
    this.onEvent({ type: 'topic-queue-changed', agentTemplate, topicName, depth });
  }
}

/**
 * Random base64url-ish id, 24 chars. Stable enough to fit `NAME_RE` /
 * `INSTANCE_ID_RE` (alnum start, [a-zA-Z0-9_-] body).
 */
function generateInstanceId(): string {
  const uuid = randomUUID().replace(/-/g, '');
  return uuid.slice(0, 16);
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
    version: 0,
    spawnCount: 0,
    createdAt: '',
  };
}

// Silence unused-import warning — `dirname`/`join` are kept for callers that
// may want to compose IPC paths from this module directly.
void dirname;
void join;
