/**
 * Agent lifecycle operations: spawn, resume, suspend, destroy, reload.
 * Integrates with engine adapters, tmux proxy, and persistence.
 *
 * Long-running operations (spawn, suspend, resume, reload) use a three-phase
 * locking pattern to avoid holding locks across slow proxy calls and sleeps:
 *
 *   Phase 1 (lock): validate → transition to intermediate state → release
 *   Phase 2 (no lock): slow work (proxy calls, sleeps)
 *   Phase 3 (lock): re-read → validate intermediate state → finalize
 *
 * Intermediate states ('spawning', 'suspending', 'resuming') act as claims —
 * concurrent callers see the agent is in transition and back off.
 * Watchdog timers mark agents 'failed' if operations hang.
 *
 * Short operations (interrupt, compact, kill, deliver) use single-phase locks.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';
import { sessionName, requireProxy, canSuspend, canResume } from '../shared/agent-entity.ts';
import { sleep } from '../shared/utils.ts';
import { getAdapter } from './adapters/index.ts';
import { resolvePersonaPath, loadPersona, composeSystemPrompt } from './persona.ts';

export type LifecycleContext = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
};

// Timeouts and delays — configurable via env vars for tuning in different environments
const SPAWN_TIMEOUT_MS = parseInt(process.env['SPAWN_TIMEOUT_MS'] ?? '30000', 10);
const SUSPEND_TIMEOUT_MS = parseInt(process.env['SUSPEND_TIMEOUT_MS'] ?? '60000', 10);
const RESUME_TIMEOUT_MS = parseInt(process.env['RESUME_TIMEOUT_MS'] ?? '60000', 10);
const RELOAD_TIMEOUT_MS = parseInt(process.env['RELOAD_TIMEOUT_MS'] ?? '90000', 10);
const RENAME_DELAY_MS = parseInt(process.env['RENAME_DELAY_MS'] ?? '3000', 10);
const EXIT_WAIT_MS = parseInt(process.env['EXIT_WAIT_MS'] ?? '10000', 10);
const POST_SPAWN_ACTIVE_DELAY_MS = parseInt(process.env['POST_SPAWN_ACTIVE_DELAY_MS'] ?? '2000', 10);
const POST_RENAME_TASK_DELAY_MS = parseInt(process.env['POST_RENAME_TASK_DELAY_MS'] ?? '1000', 10);
const INTERRUPT_KEY_DELAY_MS = parseInt(process.env['INTERRUPT_KEY_DELAY_MS'] ?? '300', 10);

/** Wrap a CLI command with `export COLLAB_AGENT=<name>` so the agent identity is available. */
function withAgentEnv(name: string, cmd: string): string {
  return `export COLLAB_AGENT=${name} && ${cmd}`;
}

// ── Watchdog helper ──

/**
 * Start a watchdog timer that marks an agent 'failed' if it's still in
 * the given intermediate state after timeoutMs.
 */
export function startWatchdog(
  ctx: LifecycleContext,
  name: string,
  intermediateState: string,
  timeoutMs: number,
  proxyId?: string,
  tmuxSession?: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(async () => {
    try {
      await ctx.locks.withLock(name, async () => {
        const latest = ctx.db.getAgent(name);
        if (latest && latest.state === intermediateState) {
          ctx.db.updateAgentState(name, 'failed', latest.version, {
            failedAt: new Date().toISOString(),
            failureReason: `${intermediateState} timeout (${timeoutMs / 1000}s)`,
          });
          ctx.db.logEvent(name, `${intermediateState}_timeout`, undefined, { timeoutMs });

          // Best-effort kill tmux session
          if (proxyId && tmuxSession) {
            await ctx.proxyDispatch(proxyId, {
              action: 'kill_session',
              sessionName: tmuxSession,
            }).catch((err) => {
              console.warn(`[watchdog] Best-effort kill_session failed for ${name}:`, (err as Error).message);
            });
          }
        }
      });
    } catch (err) {
      console.warn(`[watchdog] Failed for ${name}:`, (err as Error).message);
    }
  }, timeoutMs);
}

/**
 * Spawn a new agent: create tmux session, paste spawn command.
 *
 * Phase 1: validate + transition to 'spawning'
 * Phase 2: create tmux session, paste spawn command, rename, wait
 * Phase 3: validate still 'spawning' + transition to 'active'
 */
export async function spawnAgent(
  ctx: LifecycleContext,
  opts: {
    name: string;
    engine: string;
    model?: string;
    thinking?: string;
    cwd: string;
    persona?: string;
    proxyId: string;
    task?: string;
  },
): Promise<AgentRecord> {
  if (!opts.proxyId) throw new Error(`Agent "${opts.name}" has no proxy assigned`);

  const peers = computePeers(ctx, opts.name);

  // ── Phase 1: validate + transition to 'spawning' ──
  const phase1 = await ctx.locks.withLock(opts.name, async () => {
    const agent = ctx.db.getAgent(opts.name);
    if (!agent) throw new Error(`Agent "${opts.name}" not found in registry`);
    if (agent.state !== 'void' && agent.state !== 'failed') {
      throw new Error(`Agent "${opts.name}" is in state "${agent.state}", expected void or failed`);
    }

    const tmuxSession = `agent-${opts.name}`;
    const current = ctx.db.updateAgentState(opts.name, 'spawning', agent.version, {
      tmuxSession,
      proxyId: opts.proxyId,
      lastActivity: new Date().toISOString(),
    });

    return { current, tmuxSession, engine: agent.engine, spawnCount: agent.spawnCount, permissions: agent.permissions };
  });

  const { tmuxSession, engine, spawnCount, permissions } = phase1;
  const watchdog = startWatchdog(ctx, opts.name, 'spawning', SPAWN_TIMEOUT_MS, opts.proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Create tmux session
    const createResult = await ctx.proxyDispatch(opts.proxyId, {
      action: 'create_session',
      sessionName: tmuxSession,
      cwd: opts.cwd,
    });
    if (!createResult.ok) {
      // Re-acquire lock to mark failed
      await ctx.locks.withLock(opts.name, async () => {
        const latest = ctx.db.getAgent(opts.name);
        if (latest && latest.state === 'spawning') {
          ctx.db.updateAgentState(opts.name, 'failed', latest.version, {
            failedAt: new Date().toISOString(),
            failureReason: `Failed to create tmux session: ${createResult.error}`,
          });
          ctx.db.logEvent(opts.name, 'spawn_failed', undefined, { reason: createResult.error });
        }
      });
      throw new Error(`Spawn failed: ${createResult.error}`);
    }

    // 2. Compose system prompt with persona
    const systemPrompt = buildSystemPrompt(ctx, opts.name, peers, opts.persona);

    // 3. Build and paste spawn command
    const spawnCmd = adapter.buildSpawnCommand({
      name: opts.name,
      cwd: opts.cwd,
      model: opts.model,
      thinking: opts.thinking,
      task: opts.task,
      appendSystemPrompt: systemPrompt,
      dangerouslySkipPermissions: permissions === 'skip',
    });

    await ctx.proxyDispatch(opts.proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: withAgentEnv(opts.name, spawnCmd),
      pressEnter: true,
    });

    // 4. Wait for CLI init, then inject /rename
    await sleep(RENAME_DELAY_MS);
    const renameCmd = adapter.buildRenameCommand(opts.name);
    if (renameCmd) {
      await ctx.proxyDispatch(opts.proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: renameCmd,
        pressEnter: true,
      });
    }

    // Let the CLI fully initialize before finalizing state
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);

    // ── Phase 3: finalize (lock) ──
    return await ctx.locks.withLock(opts.name, async () => {
      const latest = ctx.db.getAgent(opts.name);
      if (!latest) throw new Error(`Agent "${opts.name}" disappeared during spawn`);

      // If state changed (e.g. killed during spawn), return current state
      if (latest.state !== 'spawning') {
        ctx.db.logEvent(opts.name, 'spawn_interrupted', undefined, { finalState: latest.state });
        return latest;
      }

      const updated = ctx.db.updateAgentState(opts.name, 'active', latest.version, {
        lastActivity: new Date().toISOString(),
        spawnCount: spawnCount + 1,
        lastContextPct: 0,
      });
      ctx.db.logEvent(opts.name, 'spawned', undefined, { engine, model: opts.model });
      return updated;
    });
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Resume a suspended agent.
 *
 * Phase 1: validate + transition to 'resuming'
 * Phase 2: create tmux session, paste resume command, rename, optional task
 * Phase 3: validate still 'resuming' + transition to 'active'
 */
export async function resumeAgent(
  ctx: LifecycleContext,
  name: string,
  opts?: { task?: string },
): Promise<AgentRecord> {
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'resuming' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canResume(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", expected suspended or failed`);
    }
    const proxyId = requireProxy(agent);
    const tmuxSession = sessionName(agent);

    const current = ctx.db.updateAgentState(name, 'resuming', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      tmuxSession,
      engine: agent.engine,
      cwd: agent.cwd,
      persona: agent.persona,
      permissions: agent.permissions,
      currentSessionId: agent.currentSessionId,
    };
  });

  const { proxyId, tmuxSession, engine, cwd, persona, permissions, currentSessionId } = phase1;
  const watchdog = startWatchdog(ctx, name, 'resuming', RESUME_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Create new tmux session
    await ctx.proxyDispatch(proxyId, {
      action: 'create_session',
      sessionName: tmuxSession,
      cwd,
    });

    // 2. Compose system prompt
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 3. Build and paste resume command (or spawn if no session ID)
    let cmd: string;
    if (currentSessionId) {
      cmd = adapter.buildResumeCommand({
        name,
        sessionId: currentSessionId,
        cwd,
        task: opts?.task,
        appendSystemPrompt: systemPrompt,
      });
    } else {
      cmd = adapter.buildSpawnCommand({
        name,
        cwd,
        task: opts?.task,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: permissions === 'skip',
      });
    }

    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: withAgentEnv(name, cmd),
      pressEnter: true,
    });

    // 4. /rename injection
    await sleep(RENAME_DELAY_MS);
    const renameCmd = adapter.buildRenameCommand(name);
    if (renameCmd) {
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: renameCmd,
        pressEnter: true,
      });
    }

    // 5. Paste task if provided (and resuming existing session)
    if (opts?.task && currentSessionId) {
      await sleep(POST_RENAME_TASK_DELAY_MS);
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: opts.task,
        pressEnter: true,
      });
    }

    // ── Phase 3: finalize (lock) ──
    return await ctx.locks.withLock(name, async () => {
      const latest = ctx.db.getAgent(name);
      if (!latest) throw new Error(`Agent "${name}" disappeared during resume`);

      if (latest.state !== 'resuming') {
        ctx.db.logEvent(name, 'resume_interrupted', undefined, { finalState: latest.state });
        return latest;
      }

      const updated = ctx.db.updateAgentState(name, 'active', latest.version, {
        tmuxSession,
        lastActivity: new Date().toISOString(),
        stateBeforeShutdown: null,
        lastContextPct: 0,
      });
      ctx.db.logEvent(name, 'resumed', undefined, { sessionId: currentSessionId });
      return updated;
    });
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Suspend an agent: send exit command, wait, mark as suspended.
 *
 * Phase 1: validate + transition to 'suspending'
 * Phase 2: paste exit, wait, verify session gone, optional kill
 * Phase 3: validate still 'suspending' + transition to 'suspended'
 */
export async function suspendAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<AgentRecord> {
  // ── Phase 1: validate + transition to 'suspending' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canSuspend(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", expected active or idle`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'suspending', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return { current, proxyId, engine: agent.engine, tmuxSession: sessionName(agent) };
  });

  const { proxyId, engine, tmuxSession } = phase1;
  const watchdog = startWatchdog(ctx, name, 'suspending', SUSPEND_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // Send exit command
    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: adapter.buildExitCommand(),
      pressEnter: true,
    });

    // Wait for process to exit, then verify
    await sleep(EXIT_WAIT_MS);

    const sessionGone = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: tmuxSession,
    });
    const exited = !sessionGone.ok || sessionGone.data !== true;
    if (!exited) {
      console.warn(`[lifecycle] ${name}: session still alive after exit command, killing`);
      await ctx.proxyDispatch(proxyId, {
        action: 'kill_session',
        sessionName: tmuxSession,
      });
    }

    // ── Phase 3: finalize (lock) ──
    return await ctx.locks.withLock(name, async () => {
      const latest = ctx.db.getAgent(name);
      if (!latest) throw new Error(`Agent "${name}" disappeared during suspend`);

      if (latest.state !== 'suspending') {
        ctx.db.logEvent(name, 'suspend_interrupted', undefined, { finalState: latest.state });
        return latest;
      }

      const updated = ctx.db.updateAgentState(name, 'suspended', latest.version, {
        lastActivity: new Date().toISOString(),
      });
      ctx.db.logEvent(name, 'suspended');
      return updated;
    });
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Destroy an agent: kill tmux session, remove from registry.
 * Single-phase lock — fast operation.
 */
export async function destroyAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);

    if (agent.proxyId && agent.tmuxSession) {
      await ctx.proxyDispatch(agent.proxyId, {
        action: 'kill_session',
        sessionName: agent.tmuxSession,
      });
    }

    ctx.db.deleteAgent(name);
    ctx.db.logEvent(name, 'destroyed');
  });
}

/**
 * Execute a reload: exit current session, resume with fresh context.
 *
 * Queue mode: single-phase lock, sets reloadQueued flag.
 * Immediate mode:
 *   Phase 1: validate + transition to 'suspending'
 *   Phase 2: exit, wait, kill, create fresh session, paste resume, rename, optional task
 *   Phase 3: validate still 'suspending' + transition to 'active'
 */
export async function reloadAgent(
  ctx: LifecycleContext,
  name: string,
  opts?: { immediate?: boolean; task?: string },
): Promise<AgentRecord> {
  // Queue mode: set flag and return
  if (!opts?.immediate) {
    return ctx.locks.withLock(name, async () => {
      const agent = ctx.db.getAgent(name);
      if (!agent) throw new Error(`Agent "${name}" not found`);
      if (!canSuspend(agent)) {
        throw new Error(`Agent "${name}" is in state "${agent.state}", cannot queue reload`);
      }
      const updated = ctx.db.updateAgentState(name, agent.state, agent.version, {
        reloadQueued: 1,
        reloadTask: opts?.task ?? null,
      });
      ctx.db.logEvent(name, 'reload_queued');
      return updated;
    });
  }

  // Immediate mode: three-phase
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'suspending' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canSuspend(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", cannot reload`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'suspending', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      engine: agent.engine,
      cwd: agent.cwd,
      persona: agent.persona,
      permissions: agent.permissions,
      previousContextPct: agent.lastContextPct,
      currentSessionId: agent.currentSessionId,
      spawnCount: agent.spawnCount,
      reloadTask: agent.reloadTask,
      oldTmuxSession: sessionName(agent),
    };
  });

  const {
    proxyId, engine, cwd, persona, permissions, previousContextPct,
    currentSessionId, spawnCount, reloadTask, oldTmuxSession,
  } = phase1;
  const watchdog = startWatchdog(ctx, name, 'suspending', RELOAD_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Send exit command
    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: oldTmuxSession,
      text: adapter.buildExitCommand(),
      pressEnter: true,
    });

    // 2. Wait for exit
    await sleep(EXIT_WAIT_MS);

    // 3. Kill tmux session
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: oldTmuxSession,
    });

    // 4. Create fresh tmux session
    const tmuxSession = `agent-${name}`;
    await ctx.proxyDispatch(proxyId, {
      action: 'create_session',
      sessionName: tmuxSession,
      cwd,
    });

    // 5. Build resume command
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    const resumeCmd = currentSessionId
      ? adapter.buildResumeCommand({
          name,
          sessionId: currentSessionId,
          cwd,
          appendSystemPrompt: systemPrompt,
        })
      : adapter.buildSpawnCommand({
          name,
          cwd,
          appendSystemPrompt: systemPrompt,
          dangerouslySkipPermissions: permissions === 'skip',
        });

    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: withAgentEnv(name, resumeCmd),
      pressEnter: true,
    });

    // 6. /rename injection
    await sleep(RENAME_DELAY_MS);
    const renameCmd = adapter.buildRenameCommand(name);
    if (renameCmd) {
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: renameCmd,
        pressEnter: true,
      });
    }

    // 7. Paste reload task if provided
    const taskText = opts?.task ?? reloadTask;
    if (taskText) {
      await sleep(POST_RENAME_TASK_DELAY_MS);
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: `[orchestrator → ${name}] ${taskText}`,
        pressEnter: true,
      });
    }

    // ── Phase 3: finalize (lock) ──
    return await ctx.locks.withLock(name, async () => {
      const latest = ctx.db.getAgent(name);
      if (!latest) throw new Error(`Agent "${name}" disappeared during reload`);

      if (latest.state !== 'suspending') {
        ctx.db.logEvent(name, 'reload_interrupted', undefined, { finalState: latest.state });
        return latest;
      }

      const updated = ctx.db.updateAgentState(name, 'active', latest.version, {
        tmuxSession: `agent-${name}`,
        reloadQueued: 0,
        reloadTask: null,
        spawnCount: spawnCount + 1,
        lastContextPct: 0,
        lastActivity: new Date().toISOString(),
      });

      ctx.db.logEvent(name, 'reloaded', undefined, {
        previousContextPct,
        sessionId: currentSessionId,
      });

      return updated;
    });
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Interrupt an active agent: send escape keys to cancel current operation.
 * Single-phase lock — fast operation.
 */
export async function interruptAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const proxyId = requireProxy(agent);

    const adapter = getAdapter(agent.engine);
    const keys = adapter.interruptKeys();

    for (const key of keys) {
      await ctx.proxyDispatch(proxyId, {
        action: 'send_keys',
        sessionName: sessionName(agent),
        keys: key,
      });
      await sleep(INTERRUPT_KEY_DELAY_MS);
    }

    ctx.db.logEvent(name, 'interrupted');
  });
}

/**
 * Send compact command to an agent.
 * Single-phase lock — fast operation.
 */
export async function compactAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const proxyId = requireProxy(agent);

    const adapter = getAdapter(agent.engine);

    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: sessionName(agent),
      text: adapter.buildCompactCommand(),
      pressEnter: true,
    });

    // Transition to active so the agent doesn't appear idle during compaction.
    // The health monitor will detect idle again once compaction finishes.
    if (agent.state === 'idle') {
      ctx.db.updateAgentState(name, 'active', agent.version, {
        lastActivity: new Date().toISOString(),
      });
    }

    ctx.db.logEvent(name, 'compact_requested');
  });
}

/**
 * Kill an agent: force-stop tmux session, mark as suspended.
 * Single-phase lock — fast operation. Works on any state (including transitional).
 */
export async function killAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const proxyId = requireProxy(agent);

    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: sessionName(agent),
    });

    ctx.db.updateAgentState(name, 'suspended', agent.version, {
      tmuxSession: null,
      lastActivity: new Date().toISOString(),
    });

    ctx.db.logEvent(name, 'killed');
  });
}

/**
 * Deliver a message to an agent via proxy paste, under lock.
 * Returns null on success, or an error string on failure.
 * Single-phase lock — fast operation.
 */
export async function deliverToAgent(
  ctx: LifecycleContext,
  agent: AgentRecord,
  text: string,
): Promise<string | null> {
  const proxyId = requireProxy(agent);
  let error: string | null = null;

  await ctx.locks.withLock(agent.name, async () => {
    const result = await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: sessionName(agent),
      text,
      pressEnter: true,
    });

    if (!result.ok) {
      error = result.error ?? 'Unknown delivery error';
    }
  });

  return error;
}

// ── Helpers ──

/**
 * Compute peers list. Call BEFORE acquiring a lock to avoid holding
 * the lock while querying all agents.
 */
function computePeers(ctx: LifecycleContext, agentName: string): string[] {
  return ctx.db.listAgents()
    .filter((a) => a.name !== agentName && a.state !== 'void' && a.state !== 'failed')
    .map((a) => a.name);
}

function buildSystemPrompt(
  ctx: LifecycleContext,
  agentName: string,
  peers: string[],
  persona?: string | null,
): string {
  // persona from DB is typically just a name (e.g. "almanac-lead"), not a path.
  // Only pass as explicit path if it looks like one; otherwise let convention resolve.
  const explicitPath = persona && (persona.includes('/') || persona.endsWith('.md')) ? persona : null;
  const personaPath = resolvePersonaPath(agentName, explicitPath);
  const personaContent = personaPath ? loadPersona(personaPath) : null;

  return composeSystemPrompt({
    agentName,
    personaContent,
    orchestratorHost: ctx.orchestratorHost,
    peers,
  });
}
