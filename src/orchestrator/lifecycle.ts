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
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord, PipelineStep } from '../shared/types.ts';
import { sessionName, requireProxy, canSuspend, canResume } from '../shared/agent-entity.ts';
import { shellQuote, sleep } from '../shared/utils.ts';
import { getAdapter } from './adapters/index.ts';
import { resolvePersonaPath, loadPersona, composeSystemPrompt, getPersonasDir, toHostPath } from './persona.ts';
import { resolveHook } from './hook-resolver.ts';
import type { HookResult, TemplateVars } from './hook-resolver.ts';

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

function prependExports(cmd: string, entries: Array<[string, string]>): string {
  const assignments = entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  return `export ${assignments} && ${cmd}`;
}

/** Wrap a command with base agent exports used by non-launch custom hooks. */
function withAgentEnv(name: string, cmd: string, personaFile?: string | null): string {
  const entries: Array<[string, string]> = [['COLLAB_AGENT', name]];
  if (personaFile) {
    entries.push(['COLLAB_PERSONA_FILE', personaFile]);
  }
  return prependExports(cmd, entries);
}

/** Wrap a launch command with base exports plus persona-defined launch env. */
function withLaunchEnv(agent: AgentRecord, cmd: string, personaFile: string): string {
  const baseEntries: Array<[string, string]> = [
    ['COLLAB_AGENT', agent.name],
    ['COLLAB_PERSONA_FILE', personaFile],
  ];
  const reservedKeys = new Set(baseEntries.map(([key]) => key));
  const launchEntries = Object.entries(agent.launchEnv ?? {})
    .filter(([key]) => !reservedKeys.has(key));
  return prependExports(cmd, [...baseEntries, ...launchEntries]);
}

/**
 * Dispatch a resolved hook result to the proxy.
 * Handles paste, keys, send sequences, pipelines, and skip modes uniformly.
 *
 * When agentName is provided and the pipeline contains capture steps,
 * captured variables are stored in the agent's captured_vars column.
 */
async function dispatchHookResult(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  result: HookResult,
  opts?: { pressEnter?: boolean; keyDelay?: number; agentName?: string },
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

  if (result.mode === 'pipeline') {
    for (const step of result.steps) {
      if (step.type === 'keystrokes') {
        await dispatchHookResult(ctx, proxyId, tmuxSession, { mode: 'send', actions: step.actions }, opts);
      } else if (step.type === 'shell') {
        await ctx.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: tmuxSession,
          text: step.command,
          pressEnter: opts?.pressEnter ?? true,
        });
      } else if (step.type === 'capture') {
        const captureResult = await ctx.proxyDispatch(proxyId, {
          action: 'capture',
          sessionName: tmuxSession,
          lines: step.lines,
        });
        if (opts?.agentName && captureResult.ok && typeof captureResult.data === 'string') {
          try {
            const re = new RegExp(step.regex);
            const match = re.exec(captureResult.data);
            if (match && match[1]) {
              const captured = match[1].trim();
              ctx.db.updateAgentCapturedVar(opts.agentName, step.var, captured);
              console.log(`[lifecycle] ${opts.agentName}: captured $${step.var} = ${captured}`);
              // When capturing SESSION_ID, also update currentSessionId for legacy resume flow
              if (step.var === 'SESSION_ID') {
                const latest = ctx.db.getAgent(opts.agentName!);
                if (latest) {
                  ctx.db.updateAgentState(opts.agentName!, latest.state, latest.version, {
                    currentSessionId: captured,
                  });
                }
              }
            }
          } catch (err) {
            console.warn(`[lifecycle] ${opts.agentName}: capture regex failed for $${step.var}:`, (err as Error).message);
          }
        }
      }
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
    const templateVars: TemplateVars = {
      AGENT_NAME: opts.name,
      AGENT_CWD: opts.cwd,
      SESSION_ID: generatedSessionId,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: phase1.current.capturedVars ?? undefined,
    };
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
      templateVars,
    });

    // Wrap paste commands with agent env vars
    const wrappedStart = startResult.mode === 'paste'
      ? { mode: 'paste' as const, text: withLaunchEnv(phase1.current, startResult.text, personaFile) }
      : startResult;

    await dispatchHookResult(ctx, opts.proxyId, tmuxSession, wrappedStart, { agentName: opts.name });

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

    // 6. Session ID: use the pre-generated one from --session-id.
    // Session detection is now handled by capture steps in exit/start pipelines
    // (deprecated: detectSessionId / detect_session_regex).
    const capturedSessionId: string | null = generatedSessionId;

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
    let resumeResult: HookResult;

    const resumeTemplateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: currentSessionId ?? undefined,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: phase1.current.capturedVars ?? undefined,
    };

    if (currentSessionId) {
      resumeResult = resolveHook('resume', hookResume, phase1.current, {
        resumeOpts: {
          name,
          sessionId: currentSessionId,
          cwd,
          task: adapter.supportsResumePrompt ? opts?.task : undefined,
          appendSystemPrompt: systemPrompt,
        },
        templateVars: resumeTemplateVars,
      });
    } else {
      // No stored session ID — spawn fresh.
      // Only Claude uses --session-id; other engines ignore it.
      resumeSessionId = adapter.engine === 'claude' ? randomUUID() : null;
      resumeTemplateVars.SESSION_ID = resumeSessionId ?? undefined;
      resumeResult = resolveHook('start', hookStart, phase1.current, {
        spawnOpts: {
          name,
          cwd,
          task: opts?.task,
          appendSystemPrompt: systemPrompt,
          dangerouslySkipPermissions: permissions === 'skip',
          sessionId: resumeSessionId,
        },
        templateVars: resumeTemplateVars,
      });
    }

    // Wrap paste commands with agent env vars
    const wrappedResume = resumeResult.mode === 'paste'
      ? { mode: 'paste' as const, text: withLaunchEnv(phase1.current, resumeResult.text, personaFile) }
      : resumeResult;

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedResume, { agentName: name });

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

    // 6. Session detection is now handled by capture steps in pipelines.
    // (deprecated: detectSessionId / detect_session_regex)

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
    await dispatchHookResult(ctx, proxyId, tmuxSession, exitResult, { agentName: name });

    // Wait for process to exit, then verify
    await sleep(EXIT_WAIT_MS);

    // Session ID capture is now handled by capture steps in the exit pipeline.
    // If the exit hook included a capture step with var=SESSION_ID, it's already
    // stored in captured_vars and currentSessionId by dispatchHookResult.

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

    // Delete persona file so persona sync doesn't resurrect the agent
    const personaFilename = agent.persona ?? name;
    const personaPath = join(getPersonasDir(), `${personaFilename}.md`);
    if (existsSync(personaPath)) {
      unlinkSync(personaPath);
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
    await dispatchHookResult(ctx, proxyId, oldTmuxSession, exitResult, { agentName: name });

    // 2. Wait for exit
    await sleep(EXIT_WAIT_MS);

    // Session ID capture is now handled by capture steps in the exit pipeline.

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
    // Check if the exit pipeline captured a session ID via capture step
    const postExitAgent = ctx.db.getAgent(name);
    let reloadSessionId = postExitAgent?.capturedVars?.['SESSION_ID'] ?? currentSessionId;
    let reloadResult: HookResult;

    const reloadTemplateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: reloadSessionId ?? undefined,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: phase1.current.capturedVars ?? undefined,
    };

    if (reloadSessionId) {
      reloadResult = resolveHook('resume', hookResume, phase1.current, {
        resumeOpts: {
          name,
          sessionId: reloadSessionId,
          cwd,
          task: inlineTask,
          appendSystemPrompt: systemPrompt,
        },
        templateVars: reloadTemplateVars,
      });
    } else {
      // No session to resume — spawn fresh.
      reloadSessionId = adapter.engine === 'claude' ? randomUUID() : null;
      reloadTemplateVars.SESSION_ID = reloadSessionId ?? undefined;
      reloadResult = resolveHook('start', hookStart, phase1.current, {
        spawnOpts: {
          name,
          cwd,
          task: inlineTask,
          appendSystemPrompt: systemPrompt,
          dangerouslySkipPermissions: permissions === 'skip',
          sessionId: reloadSessionId,
        },
        templateVars: reloadTemplateVars,
      });
    }

    // Wrap paste commands with agent env vars
    const wrappedReload = reloadResult.mode === 'paste'
      ? { mode: 'paste' as const, text: withLaunchEnv(phase1.current, reloadResult.text, personaFile) }
      : reloadResult;

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedReload, { agentName: name });

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
    await dispatchHookResult(ctx, proxyId, sessionName(agent), interruptResult, { keyDelay: INTERRUPT_KEY_DELAY_MS, agentName: name });

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
    await dispatchHookResult(ctx, proxyId, sessionName(agent), wrappedCompact, { agentName: name });

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
 * Execute a custom button pipeline for an agent.
 * Looks up the named button in the agent's custom_buttons JSON,
 * resolves the pipeline steps, and dispatches them.
 */
export async function executeCustomButton(
  ctx: LifecycleContext,
  name: string,
  buttonName: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!agent.customButtons) throw new Error(`Agent "${name}" has no custom buttons`);

    const proxyId = requireProxy(agent);
    let buttons: Record<string, unknown>;
    try {
      buttons = JSON.parse(agent.customButtons) as Record<string, unknown>;
    } catch {
      throw new Error(`Agent "${name}" has invalid custom_buttons JSON`);
    }

    const steps = buttons[buttonName];
    if (!steps || !Array.isArray(steps)) {
      throw new Error(`Custom button "${buttonName}" not found for agent "${name}"`);
    }

    const templateVars = {
      AGENT_NAME: name,
      AGENT_CWD: agent.cwd,
      SESSION_ID: agent.currentSessionId ?? undefined,
      capturedVars: agent.capturedVars ?? undefined,
    };
    const result = resolveHook('exit', steps as PipelineStep[], agent, { templateVars });
    await dispatchHookResult(ctx, proxyId, sessionName(agent), result, { agentName: name });

    ctx.db.logEvent(name, 'custom_button', undefined, { button: buttonName });
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
    try {
      const hookResult = resolveHook('submit', agent.hookSubmit, agent, { task: text });
      // Wrap proxyDispatch to throw on failure so dispatchHookResult propagates errors
      const throwingCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (pid, cmd) => {
          const result = await ctx.proxyDispatch(pid, cmd);
          if (!result.ok) throw new Error(result.error ?? 'Proxy dispatch failed');
          return result;
        },
      };
      await dispatchHookResult(throwingCtx, proxyId, sessionName(agent), hookResult, { agentName: agent.name });
    } catch (err) {
      error = (err as Error).message ?? 'Unknown delivery error';
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
 * Used for launch-time COLLAB_PERSONA_FILE exports and custom hook wrappers.
 */
function resolvePersonaFilePath(name: string, persona?: string | null): string {
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
