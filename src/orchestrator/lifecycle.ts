/**
 * Agent lifecycle operations: spawn, resume, suspend, destroy, reload.
 * Integrates with engine adapters, tmux proxy, and persistence.
 *
 * All state mutations happen inside per-agent locks to prevent races.
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

const SPAWN_TIMEOUT_MS = 30_000;
const RENAME_DELAY_MS = 3_000;
const EXIT_WAIT_MS = 10_000;
const POST_SPAWN_ACTIVE_DELAY_MS = 2_000;
const POST_RENAME_TASK_DELAY_MS = 1_000;
const INTERRUPT_KEY_DELAY_MS = 300;

/**
 * Spawn a new agent: create tmux session, paste spawn command, set up watchdog.
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

  // Compute peers before lock to avoid DB query under lock
  const peers = computePeers(ctx, opts.name);

  return ctx.locks.withLock(opts.name, async () => {
    // Re-read inside lock to prevent TOCTOU races
    const agent = ctx.db.getAgent(opts.name);
    if (!agent) throw new Error(`Agent "${opts.name}" not found in registry`);
    if (agent.state !== 'void' && agent.state !== 'failed') {
      throw new Error(`Agent "${opts.name}" is in state "${agent.state}", expected void or failed`);
    }

    const adapter = getAdapter(agent.engine);
    const tmuxSession = `agent-${opts.name}`;

    // Transition to spawning
    let current = ctx.db.updateAgentState(opts.name, 'spawning', agent.version, {
      tmuxSession,
      proxyId: opts.proxyId,
      lastActivity: new Date().toISOString(),
    });

    // 1. Create tmux session
    const createResult = await ctx.proxyDispatch(opts.proxyId, {
      action: 'create_session',
      sessionName: tmuxSession,
      cwd: opts.cwd,
    });
    if (!createResult.ok) {
      ctx.db.updateAgentState(opts.name, 'failed', current.version, {
        failedAt: new Date().toISOString(),
        failureReason: `Failed to create tmux session: ${createResult.error}`,
      });
      ctx.db.logEvent(opts.name, 'spawn_failed', undefined, { reason: createResult.error });
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
      dangerouslySkipPermissions: true,
    });

    await ctx.proxyDispatch(opts.proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: spawnCmd,
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

    // 5. Set up spawn watchdog (30s timeout → failed)
    const watchdogTimer = setTimeout(async () => {
      try {
        await ctx.locks.withLock(opts.name, async () => {
          const latest = ctx.db.getAgent(opts.name);
          if (latest && latest.state === 'spawning') {
            ctx.db.updateAgentState(opts.name, 'failed', latest.version, {
              failedAt: new Date().toISOString(),
              failureReason: 'Spawn timeout (30s)',
            });

            await ctx.proxyDispatch(opts.proxyId, {
              action: 'kill_session',
              sessionName: tmuxSession,
            }).catch(() => { /* best effort */ });

            ctx.db.logEvent(opts.name, 'spawn_failed', undefined, { reason: 'timeout' });
          }
        });
      } catch { /* watchdog is best-effort */ }
    }, SPAWN_TIMEOUT_MS);

    // 6. Transition to active (cancel watchdog before sleep to prevent race)
    clearTimeout(watchdogTimer);
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);
    current = ctx.db.updateAgentState(opts.name, 'active', current.version, {
      lastActivity: new Date().toISOString(),
      spawnCount: current.spawnCount + 1,
      lastContextPct: 0,
    });
    ctx.db.logEvent(opts.name, 'spawned', undefined, { engine: agent.engine, model: opts.model });

    return current;
  });
}

/**
 * Resume a suspended agent.
 */
export async function resumeAgent(
  ctx: LifecycleContext,
  name: string,
  opts?: { task?: string },
): Promise<AgentRecord> {
  const peers = computePeers(ctx, name);

  return ctx.locks.withLock(name, async () => {
    // Re-read inside lock
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canResume(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", expected suspended or failed`);
    }
    const proxyId = requireProxy(agent);

    const adapter = getAdapter(agent.engine);
    const tmuxSession = sessionName(agent);

    // 1. Create new tmux session
    await ctx.proxyDispatch(proxyId, {
      action: 'create_session',
      sessionName: tmuxSession,
      cwd: agent.cwd,
    });

    // 2. Compose system prompt
    const systemPrompt = buildSystemPrompt(ctx, name, peers, agent.persona);

    // 3. Build and paste resume command (or spawn if no session ID)
    let cmd: string;
    if (agent.currentSessionId) {
      cmd = adapter.buildResumeCommand({
        name,
        sessionId: agent.currentSessionId,
        cwd: agent.cwd,
        task: opts?.task,
        appendSystemPrompt: systemPrompt,
      });
    } else {
      cmd = adapter.buildSpawnCommand({
        name,
        cwd: agent.cwd,
        task: opts?.task,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: true,
      });
    }

    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: cmd,
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
    if (opts?.task && agent.currentSessionId) {
      await sleep(POST_RENAME_TASK_DELAY_MS);
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: opts.task,
        pressEnter: true,
      });
    }

    // 6. Update state
    const updated = ctx.db.updateAgentState(name, 'active', agent.version, {
      tmuxSession,
      lastActivity: new Date().toISOString(),
      stateBeforeShutdown: null,
      lastContextPct: 0,
    });

    ctx.db.logEvent(name, 'resumed', undefined, { sessionId: agent.currentSessionId });
    return updated;
  });
}

/**
 * Suspend an agent: send exit command, wait, mark as suspended.
 */
export async function suspendAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<AgentRecord> {
  return ctx.locks.withLock(name, async () => {
    // Re-read inside lock
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canSuspend(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", expected active or idle`);
    }
    const proxyId = requireProxy(agent);

    const adapter = getAdapter(agent.engine);

    // Send exit command
    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: sessionName(agent),
      text: adapter.buildExitCommand(),
      pressEnter: true,
    });

    // Wait for process to exit, then verify
    await sleep(EXIT_WAIT_MS);

    const sessionGone = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: sessionName(agent),
    });
    const exited = !sessionGone.ok || sessionGone.data !== true;
    if (!exited) {
      console.warn(`[lifecycle] ${name}: session still alive after exit command, killing`);
      await ctx.proxyDispatch(proxyId, {
        action: 'kill_session',
        sessionName: sessionName(agent),
      });
    }

    const updated = ctx.db.updateAgentState(name, 'suspended', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    ctx.db.logEvent(name, 'suspended');
    return updated;
  });
}

/**
 * Destroy an agent: kill tmux session, remove from registry.
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

  // Immediate mode: execute now
  const peers = computePeers(ctx, name);
  return ctx.locks.withLock(name, async () => {
    // Re-read inside lock
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canSuspend(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", cannot reload`);
    }
    const proxyId = requireProxy(agent);

    const adapter = getAdapter(agent.engine);
    const previousContextPct = agent.lastContextPct;

    // 1. Send exit command
    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: sessionName(agent),
      text: adapter.buildExitCommand(),
      pressEnter: true,
    });

    // 2. Wait for exit
    await sleep(EXIT_WAIT_MS);

    // 3. Kill tmux session
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: sessionName(agent),
    });

    // 4. Create fresh tmux session
    const tmuxSession = `agent-${name}`;
    await ctx.proxyDispatch(proxyId, {
      action: 'create_session',
      sessionName: tmuxSession,
      cwd: agent.cwd,
    });

    // 5. Build resume command
    const systemPrompt = buildSystemPrompt(ctx, name, peers, agent.persona);

    const resumeCmd = agent.currentSessionId
      ? adapter.buildResumeCommand({
          name,
          sessionId: agent.currentSessionId,
          cwd: agent.cwd,
          appendSystemPrompt: systemPrompt,
        })
      : adapter.buildSpawnCommand({
          name,
          cwd: agent.cwd,
          appendSystemPrompt: systemPrompt,
          dangerouslySkipPermissions: true,
        });

    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: resumeCmd,
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
    const taskText = opts?.task ?? agent.reloadTask;
    if (taskText) {
      await sleep(POST_RENAME_TASK_DELAY_MS);
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: `[orchestrator → ${name}] ${taskText}`,
        pressEnter: true,
      });
    }

    // 8. Update registry (re-read for fresh version after sleeps)
    const freshAgent = ctx.db.getAgent(name);
    if (!freshAgent) throw new Error(`Agent "${name}" disappeared during reload`);
    const updated = ctx.db.updateAgentState(name, 'active', freshAgent.version, {
      tmuxSession,
      reloadQueued: 0,
      reloadTask: null,
      spawnCount: agent.spawnCount + 1,
      lastContextPct: 0,
      lastActivity: new Date().toISOString(),
    });

    ctx.db.logEvent(name, 'reloaded', undefined, {
      previousContextPct,
      sessionId: agent.currentSessionId,
    });

    return updated;
  });
}

/**
 * Interrupt an active agent: send escape keys to cancel current operation.
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

    ctx.db.logEvent(name, 'compact_requested');
  });
}

/**
 * Kill an agent: force-stop tmux session, mark as suspended.
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
  const personaPath = resolvePersonaPath(agentName, persona);
  const personaContent = personaPath ? loadPersona(personaPath) : null;

  return composeSystemPrompt({
    agentName,
    personaContent,
    orchestratorHost: ctx.orchestratorHost,
    peers,
  });
}


