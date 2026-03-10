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

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';
import { sessionName, requireProxy, canSuspend, canResume } from '../shared/agent-entity.ts';
import { sleep } from '../shared/utils.ts';
import { getAdapter } from './adapters/index.ts';
import { resolvePersonaPath, loadPersona, composeSystemPrompt, getPersonasDir, toHostPath } from './persona.ts';
import { resolveHook } from './hook-resolver.ts';
import type { HookResult } from './hook-resolver.ts';

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

/** Wrap a CLI command with agent env vars (COLLAB_AGENT, optionally COLLAB_PERSONA_FILE). */
function withAgentEnv(name: string, cmd: string, personaFile?: string | null): string {
  let env = `export COLLAB_AGENT=${name}`;
  if (personaFile) env += ` COLLAB_PERSONA_FILE=${personaFile}`;
  return `${env} && ${cmd}`;
}

/**
 * Dispatch a resolved hook result to the proxy.
 * Handles paste, keys, send sequences, and skip modes uniformly.
 */
async function dispatchHookResult(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  result: HookResult,
  opts?: { pressEnter?: boolean; keyDelay?: number },
): Promise<void> {
  if (result.mode === 'skip') return;

  if (result.mode === 'keys') {
    for (const key of result.keys) {
      await ctx.proxyDispatch(proxyId, {
        action: 'send_keys',
        sessionName: tmuxSession,
        keys: key,
      });
      if (opts?.keyDelay) await sleep(opts.keyDelay);
    }
    return;
  }

  if (result.mode === 'send') {
    for (const action of result.actions) {
      if ('keystroke' in action) {
        await ctx.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: tmuxSession,
          keys: action.keystroke,
        });
      } else if ('text' in action) {
        await ctx.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: tmuxSession,
          keys: action.text,
        });
      } else if ('paste' in action) {
        await ctx.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: tmuxSession,
          text: action.paste,
          pressEnter: false,
        });
      }
      const waitMs = action.post_wait_ms;
      if (waitMs && waitMs > 0) await sleep(waitMs);
    }
    return;
  }

  // mode === 'paste'
  await ctx.proxyDispatch(proxyId, {
    action: 'paste',
    sessionName: tmuxSession,
    text: result.text,
    pressEnter: opts?.pressEnter ?? true,
  });
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

    return { current, tmuxSession, engine: agent.engine, spawnCount: agent.spawnCount, permissions: agent.permissions, hookStart: agent.hookStart };
  });

  const { tmuxSession, engine, spawnCount, permissions, hookStart } = phase1;
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

    // 2b. Write config profile for engines that use it (e.g. Codex)
    if (adapter.usesConfigProfile && systemPrompt) {
      await ctx.proxyDispatch(opts.proxyId, {
        action: 'write_codex_profile',
        profileName: opts.name,
        developerInstructions: systemPrompt,
      });
    }

    // 3. Generate session ID for engines that support it (Claude --session-id)
    const generatedSessionId = randomUUID();

    // 4. Build and paste spawn command via hook resolver
    const personaFile = resolvePersonaFilePath(opts.name, opts.persona);
    const startResult = resolveHook('start', hookStart, phase1.current, {
      spawnOpts: {
        name: opts.name,
        cwd: opts.cwd,
        model: opts.model,
        thinking: opts.thinking,
        task: opts.task,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: permissions === 'skip',
        sessionId: generatedSessionId,
      },
    });

    // Wrap paste commands with agent env vars
    const wrappedStart = startResult.mode === 'paste'
      ? { mode: 'paste' as const, text: withAgentEnv(opts.name, startResult.text, hookStart ? personaFile : null) }
      : startResult;

    await dispatchHookResult(ctx, opts.proxyId, tmuxSession, wrappedStart);

    // 5. Wait for CLI init, then inject /rename
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

    // 6. Determine session ID to persist.
    // Claude: pre-generated via --session-id (generatedSessionId is always set).
    // Codex/OpenCode: try extracting from pane output; fall back to null.
    let capturedSessionId: string | null = generatedSessionId;
    if (adapter.engine !== 'claude') {
      // Non-Claude engines don't accept --session-id, so the generated one wasn't used.
      // Try extracting from pane output instead.
      capturedSessionId = null;
      try {
        const captureResult = await ctx.proxyDispatch(opts.proxyId, {
          action: 'capture',
          sessionName: tmuxSession,
          lines: 50,
        });
        if (captureResult.ok && typeof captureResult.data === 'string') {
          capturedSessionId = adapter.extractSessionId(captureResult.data);
        }
      } catch {
        // Best-effort — session ID capture failure is non-fatal
      }
    }

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
        currentSessionId: capturedSessionId,
      });
      ctx.db.logEvent(opts.name, 'spawned', undefined, {
        engine,
        model: opts.model,
        sessionId: capturedSessionId,
      });
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
      hookStart: agent.hookStart,
      hookResume: agent.hookResume,
    };
  });

  const { proxyId, tmuxSession, engine, cwd, persona, permissions, currentSessionId, hookStart, hookResume } = phase1;
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

    // 2b. Write config profile for engines that use it (e.g. Codex)
    if (adapter.usesConfigProfile && systemPrompt) {
      await ctx.proxyDispatch(proxyId, {
        action: 'write_codex_profile',
        profileName: name,
        developerInstructions: systemPrompt,
      });
    }

    // 3. Build and paste resume command (or spawn with new session ID if none)
    //    Use hook resolver: hookResume for existing session, hookStart for fresh spawn.
    const personaFile = resolvePersonaFilePath(name, persona);
    let resumeSessionId = currentSessionId;
    const useHookField = currentSessionId ? hookResume : hookStart;
    let resumeResult: HookResult;

    if (currentSessionId) {
      resumeResult = resolveHook('resume', hookResume, phase1.current, {
        resumeOpts: {
          name,
          sessionId: currentSessionId,
          cwd,
          task: adapter.supportsResumePrompt ? opts?.task : undefined,
          appendSystemPrompt: systemPrompt,
        },
      });
    } else {
      // No stored session ID — spawn fresh.
      // Only Claude uses --session-id; other engines ignore it.
      resumeSessionId = adapter.engine === 'claude' ? randomUUID() : null;
      resumeResult = resolveHook('start', hookStart, phase1.current, {
        spawnOpts: {
          name,
          cwd,
          task: opts?.task,
          appendSystemPrompt: systemPrompt,
          dangerouslySkipPermissions: permissions === 'skip',
          sessionId: resumeSessionId,
        },
      });
    }

    // Wrap paste commands with agent env vars
    const wrappedResume = resumeResult.mode === 'paste'
      ? { mode: 'paste' as const, text: withAgentEnv(name, resumeResult.text, useHookField ? personaFile : null) }
      : resumeResult;

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedResume);

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

    // 5. Paste task if provided (and resuming existing session).
    // Skip if the engine consumed the task inline via buildResumeCommand.
    if (opts?.task && currentSessionId && !adapter.supportsResumePrompt) {
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
        currentSessionId: resumeSessionId,
      });
      ctx.db.logEvent(name, 'resumed', undefined, { sessionId: resumeSessionId });
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

    return { current, proxyId, engine: agent.engine, hookExit: agent.hookExit, tmuxSession: sessionName(agent) };
  });

  const { proxyId, engine, hookExit, tmuxSession } = phase1;
  const watchdog = startWatchdog(ctx, name, 'suspending', SUSPEND_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──

    // Send exit command via hook resolver
    const exitResult = resolveHook('exit', hookExit, phase1.current);
    await dispatchHookResult(ctx, proxyId, tmuxSession, exitResult);

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

    // Clean up config profile for engines that use it (e.g. Codex)
    if (agent.proxyId) {
      const adapter = getAdapter(agent.engine);
      if (adapter.usesConfigProfile) {
        await ctx.proxyDispatch(agent.proxyId, {
          action: 'remove_codex_profile',
          profileName: name,
        }).catch(() => {}); // Best-effort cleanup
      }
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
      hookStart: agent.hookStart,
      hookResume: agent.hookResume,
      hookExit: agent.hookExit,
    };
  });

  const {
    proxyId, engine, cwd, persona, permissions, previousContextPct,
    currentSessionId, spawnCount, reloadTask, oldTmuxSession, hookStart, hookResume, hookExit,
  } = phase1;
  const watchdog = startWatchdog(ctx, name, 'suspending', RELOAD_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Send exit command via hook resolver
    const exitResult = resolveHook('exit', hookExit, phase1.current);
    await dispatchHookResult(ctx, proxyId, oldTmuxSession, exitResult);

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

    // 5. Build resume command (or fresh spawn with new session ID if none exists)
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 5b. Write config profile for engines that use it (e.g. Codex)
    if (adapter.usesConfigProfile && systemPrompt) {
      await ctx.proxyDispatch(proxyId, {
        action: 'write_codex_profile',
        profileName: name,
        developerInstructions: systemPrompt,
      });
    }

    const taskText = opts?.task ?? reloadTask;
    // For engines that support inline resume prompts (e.g. Codex), pass the task
    // as a positional CLI argument instead of pasting it separately into tmux.
    // This avoids Codex's unreliable multiline paste handling.
    const inlineTask = adapter.supportsResumePrompt && taskText
      ? `[orchestrator → ${name}] ${taskText}`
      : undefined;

    const personaFile = resolvePersonaFilePath(name, persona);
    let reloadSessionId = currentSessionId;
    const useHookField = currentSessionId ? hookResume : hookStart;
    let reloadResult: HookResult;

    if (currentSessionId) {
      reloadResult = resolveHook('resume', hookResume, phase1.current, {
        resumeOpts: {
          name,
          sessionId: currentSessionId,
          cwd,
          task: inlineTask,
          appendSystemPrompt: systemPrompt,
        },
      });
    } else {
      // No session to resume — spawn fresh.
      reloadSessionId = adapter.engine === 'claude' ? randomUUID() : null;
      reloadResult = resolveHook('start', hookStart, phase1.current, {
        spawnOpts: {
          name,
          cwd,
          task: inlineTask,
          appendSystemPrompt: systemPrompt,
          dangerouslySkipPermissions: permissions === 'skip',
          sessionId: reloadSessionId,
        },
      });
    }

    // Wrap paste commands with agent env vars
    const wrappedReload = reloadResult.mode === 'paste'
      ? { mode: 'paste' as const, text: withAgentEnv(name, reloadResult.text, useHookField ? personaFile : null) }
      : reloadResult;

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedReload);

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

    // 7. Paste reload task if provided (skip if already passed as inline CLI prompt)
    if (taskText && !inlineTask) {
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
        currentSessionId: reloadSessionId,
      });

      ctx.db.logEvent(name, 'reloaded', undefined, {
        previousContextPct,
        sessionId: reloadSessionId,
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

    // Send interrupt via hook resolver
    const interruptResult = resolveHook('interrupt', agent.hookInterrupt, agent);
    await dispatchHookResult(ctx, proxyId, sessionName(agent), interruptResult, { keyDelay: INTERRUPT_KEY_DELAY_MS });

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

    // Send compact command via hook resolver
    const compactResult = resolveHook('compact', agent.hookCompact, agent);
    if (compactResult.mode === 'skip') {
      console.log(`[lifecycle] ${name}: engine "${agent.engine}" does not support compaction — skipping`);
      ctx.db.logEvent(name, 'compact_skipped', undefined, { reason: 'unsupported_engine' });
      return;
    }

    // Wrap custom hook paste commands with agent env vars
    let wrappedCompact = compactResult;
    if (agent.hookCompact && compactResult.mode === 'paste') {
      const personaFile = resolvePersonaFilePath(name, agent.persona);
      wrappedCompact = { mode: 'paste', text: withAgentEnv(name, compactResult.text, personaFile) };
    }
    await dispatchHookResult(ctx, proxyId, sessionName(agent), wrappedCompact);

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

/**
 * Resolve the host-side persona file path for an agent.
 * Used to export COLLAB_PERSONA_FILE when custom hooks are active.
 */
function resolvePersonaFilePath(name: string, persona?: string | null): string | null {
  const dir = getPersonasDir();
  const filename = persona ?? name;
  return toHostPath(join(dir, `${filename}.md`));
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
