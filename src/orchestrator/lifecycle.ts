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
import type { AccountStore } from './accounts.ts';
import { resolveEffectiveConfig } from './engine-config-resolver.ts';

export type LifecycleContext = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  accountStore?: AccountStore;
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

/** Wrap a launch command with base exports plus persona-defined launch env. */
function withLaunchEnv(agent: AgentRecord, cmd: string, personaFile: string, accountHome?: string): string {
  const baseEntries: Array<[string, string]> = [
    ['COLLAB_AGENT', agent.name],
    ['COLLAB_PERSONA_FILE', personaFile],
  ];
  // Inject HOME override for account-based credential isolation
  if (accountHome) {
    baseEntries.push(['HOME', accountHome]);
  }
  const reservedKeys = new Set(baseEntries.map(([key]) => key));
  const launchEntries = Object.entries(agent.launchEnv ?? {})
    .filter(([key]) => !reservedKeys.has(key));
  return prependExports(cmd, [...baseEntries, ...launchEntries]);
}

/** Wrap the first shell step in a pipeline with agent env vars (same as withLaunchEnv for paste mode). */
function wrapFirstShellStep(steps: PipelineStep[], agent: AgentRecord, personaFile: string, accountHome?: string): PipelineStep[] {
  const idx = steps.findIndex(s => s.type === 'shell');
  if (idx === -1) return steps;
  const step = steps[idx] as { type: 'shell'; command: string };
  const wrapped = [...steps];
  wrapped[idx] = { type: 'shell', command: withLaunchEnv(agent, step.command, personaFile, accountHome) };
  return wrapped;
}

/** Wrap a resolved hook result with agent env vars for launch operations (spawn/resume/reload). */
function wrapLaunchResult(result: HookResult, agent: AgentRecord, personaFile: string, accountHome?: string): HookResult {
  if (result.mode === 'paste') {
    return { mode: 'paste', text: withLaunchEnv(agent, result.text, personaFile, accountHome) };
  }
  if (result.mode === 'pipeline') {
    return { ...result, steps: wrapFirstShellStep(result.steps, agent, personaFile, accountHome) };
  }
  return result;
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
      } else if (step.type === 'keystroke') {
        await ctx.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: tmuxSession,
          keys: step.key,
        });
        // Brief delay after keystrokes to let terminal process them before
        // the next step — prevents Escape from eating the first character of
        // a subsequent paste (e.g. "/exit" → "xit")
        await sleep(100);
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
            const regexStr = step.regex === 'uuid'
              ? '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
              : step.regex;
            const re = new RegExp(regexStr);
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
      } else if (step.type === 'wait') {
        await sleep(step.ms);
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

// ── Shared launch-sequence helpers ──
// Extracted from spawn/resume/reload to reduce duplication.

/** Sleep, then inject the engine's /rename command (if any) into the tmux session. */
async function injectRename(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  adapter: ReturnType<typeof getAdapter>,
  name: string,
): Promise<void> {
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
}

/** Create a tmux session and write a config profile for engines that use one (e.g. Codex). */
async function createSessionAndWriteProfile(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  cwd: string,
  adapter: ReturnType<typeof getAdapter>,
  name: string,
  systemPrompt: string | null,
): Promise<ProxyResponse> {
  const createResult = await ctx.proxyDispatch(proxyId, {
    action: 'create_session',
    sessionName: tmuxSession,
    cwd,
  });
  if (createResult.ok && adapter.usesConfigProfile && systemPrompt) {
    await ctx.proxyDispatch(proxyId, {
      action: 'write_codex_profile',
      profileName: name,
      developerInstructions: systemPrompt,
    });
  }
  return createResult;
}

/**
 * Re-lock the agent, verify it is still in the expected intermediate state,
 * and transition to 'active'. Returns the updated record, or the current
 * record unchanged if the state was altered concurrently.
 */
async function finalizeToActive(
  ctx: LifecycleContext,
  name: string,
  intermediateState: string,
  interruptedEventName: string,
  updateExtra: Record<string, unknown>,
  eventName: string,
  eventMeta?: Record<string, unknown>,
  operationLabel?: string,
): Promise<AgentRecord> {
  const label = operationLabel ?? intermediateState;
  return await ctx.locks.withLock(name, async () => {
    const latest = ctx.db.getAgent(name);
    if (!latest) throw new Error(`Agent "${name}" disappeared during ${label}`);
    if (latest.state !== intermediateState) {
      ctx.db.logEvent(name, interruptedEventName, undefined, { finalState: latest.state });
      return latest;
    }
    const updated = ctx.db.updateAgentState(name, 'active', latest.version, updateExtra);
    ctx.db.logEvent(name, eventName, undefined, eventMeta);
    return updated;
  });
}

/**
 * Resolve whether to use the resume hook (existing session) or start hook (fresh spawn).
 * Shared by resumeAgent and reloadAgent.
 *
 * When sessionId is non-null, uses hookResume with resumeTask.
 * Otherwise generates a new UUID (for Claude) and uses hookStart with startTask.
 *
 * Mutates templateVars.SESSION_ID in the fresh-spawn branch.
 * Returns the hook result and the (possibly new) sessionId.
 */
function resolveResumeOrStartHook(params: {
  adapter: ReturnType<typeof getAdapter>;
  hookResume: AgentRecord['hookResume'];
  hookStart: AgentRecord['hookStart'];
  agentRecord: AgentRecord;
  sessionId: string | null;
  name: string;
  cwd: string;
  resumeTask: string | undefined;
  startTask: string | undefined;
  systemPrompt: string | null;
  permissions: string | null;
  templateVars: TemplateVars;
}): { result: HookResult; sessionId: string | null } {
  if (params.sessionId) {
    const result = resolveHook('resume', params.hookResume, params.agentRecord, {
      resumeOpts: {
        name: params.name,
        sessionId: params.sessionId,
        cwd: params.cwd,
        task: params.resumeTask,
        appendSystemPrompt: params.systemPrompt,
      },
      templateVars: params.templateVars,
    });
    return { result, sessionId: params.sessionId };
  }
  // No stored session — spawn fresh. Only Claude uses --session-id.
  const newSessionId = params.adapter.engine === 'claude' ? randomUUID() : null;
  params.templateVars.SESSION_ID = newSessionId ?? undefined;
  const result = resolveHook('start', params.hookStart, params.agentRecord, {
    spawnOpts: {
      name: params.name,
      cwd: params.cwd,
      task: params.startTask,
      appendSystemPrompt: params.systemPrompt,
      dangerouslySkipPermissions: params.permissions === 'skip',
      sessionId: newSessionId,
    },
    templateVars: params.templateVars,
  });
  return { result, sessionId: newSessionId };
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

  const { tmuxSession, spawnCount } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;

  const watchdog = startWatchdog(ctx, opts.name, 'spawning', SPAWN_TIMEOUT_MS, opts.proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Compose system prompt with persona (no proxy dependency)
    const systemPrompt = buildSystemPrompt(ctx, opts.name, peers, opts.persona);

    // 2. Create tmux session + write config profile
    const createResult = await createSessionAndWriteProfile(
      ctx, opts.proxyId, tmuxSession, opts.cwd, adapter, opts.name, systemPrompt,
    );
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
    const startResult = resolveHook('start', hookStart, effectiveCurrent, {
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

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(opts.name, phase1.current.account);
      if (home) {
        accountHome = home;
        console.log(`[lifecycle] ${opts.name}: using account "${phase1.current.account}" (HOME=${home})`);
      } else {
        console.warn(`[lifecycle] ${opts.name}: account "${phase1.current.account}" not found or missing credentials`);
      }
    }

    // Wrap launch command with agent env vars
    const wrappedStart = wrapLaunchResult(startResult, effectiveCurrent, personaFile, accountHome);

    await dispatchHookResult(ctx, opts.proxyId, tmuxSession, wrappedStart, { agentName: opts.name });

    // 5. Wait for CLI init, then inject /rename
    await injectRename(ctx, opts.proxyId, tmuxSession, adapter, opts.name);

    // Let the CLI fully initialize before finalizing state
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);

    // ── Phase 3: finalize (lock) ──
    return await finalizeToActive(ctx, opts.name, 'spawning', 'spawn_interrupted', {
      lastActivity: new Date().toISOString(),
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      currentSessionId: generatedSessionId,
    }, 'spawned', {
      engine,
      model: opts.model,
      sessionId: generatedSessionId,
    }, 'spawn');
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

  const { proxyId, tmuxSession, cwd, persona, currentSessionId } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;
  const hookResume = effectiveCurrent.hookResume;

  const watchdog = startWatchdog(ctx, name, 'resuming', RESUME_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Compose system prompt (no proxy dependency)
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 2. Reuse existing tmux session if it survived suspend (preserves Watch-tab
    //    attachments and any manual operator tweaks). Only create fresh if gone.
    const hasResult = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: tmuxSession,
    }).catch(() => ({ ok: false, data: false }));
    const sessionExists = hasResult.ok && hasResult.data === true;

    if (!sessionExists) {
      const createResult = await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);
      if (!createResult.ok) {
        await ctx.locks.withLock(name, async () => {
          const latest = ctx.db.getAgent(name);
          if (latest && latest.state === 'resuming') {
            ctx.db.updateAgentState(name, 'failed', latest.version, {
              failedAt: new Date().toISOString(),
              failureReason: `Failed to create tmux session: ${createResult.error ?? 'unknown'}`,
            });
            ctx.db.logEvent(name, 'resume_failed', undefined, { reason: createResult.error });
          }
        });
        throw new Error(`Resume failed: could not create tmux session for "${name}": ${createResult.error ?? 'unknown'}`);
      }
    } else {
      // Session alive — write updated config profile if needed
      const personaAdapter = getAdapter(engine);
      if (personaAdapter.usesConfigProfile && systemPrompt) {
        await ctx.proxyDispatch(proxyId, {
          action: 'write_codex_profile',
          profileName: name,
          developerInstructions: systemPrompt,
        }).catch(() => {});
      }
    }

    // 4. Build and paste resume command (or spawn with new session ID if none)
    //    Use hook resolver: hookResume for existing session, hookStart for fresh spawn.
    const personaFile = resolvePersonaFilePath(name, persona);

    // SESSION_ID resolution: DB currentSessionId → capturedVars.SESSION_ID → null (fresh spawn)
    const resolvedSessionId = currentSessionId
      ?? phase1.current.capturedVars?.['SESSION_ID']
      ?? null;
    const resumeTemplateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: resolvedSessionId ?? undefined,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: phase1.current.capturedVars ?? undefined,
    };

    if (!currentSessionId) {
      console.log(`[lifecycle] ${name}: no stored session ID, will spawn fresh via hookStart`);
    }

    const { result: resumeResult, sessionId: resumeSessionId } = resolveResumeOrStartHook({
      adapter,
      hookResume,
      hookStart,
      agentRecord: effectiveCurrent,
      sessionId: currentSessionId,
      name,
      cwd,
      resumeTask: adapter.supportsResumePrompt ? opts?.task : undefined,
      startTask: opts?.task,
      systemPrompt,
      permissions,
      templateVars: resumeTemplateVars,
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    // Wrap launch command with agent env vars
    const wrappedResume = wrapLaunchResult(resumeResult, effectiveCurrent, personaFile, accountHome);

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedResume, { agentName: name });

    // 5. /rename injection
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);

    // 6. Paste task if provided (and resuming existing session).
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
    return await finalizeToActive(ctx, name, 'resuming', 'resume_interrupted', {
      tmuxSession,
      lastActivity: new Date().toISOString(),
      stateBeforeShutdown: null,
      lastContextPct: 0,
      currentSessionId: resumeSessionId,
    }, 'resumed', { sessionId: resumeSessionId }, 'resume');
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

  const { proxyId, tmuxSession } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const hookExit = effectiveCurrent.hookExit;

  const watchdog = startWatchdog(ctx, name, 'suspending', SUSPEND_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──

    // Send exit command via hook resolver
    const exitResult = resolveHook('exit', hookExit, effectiveCurrent);
    await dispatchHookResult(ctx, proxyId, tmuxSession, exitResult, { agentName: name });

    // Wait for process to exit, then verify
    await sleep(EXIT_WAIT_MS);

    // Session ID capture is now handled by capture steps in the exit pipeline.
    // If the exit hook included a capture step with var=SESSION_ID, it's already
    // stored in captured_vars and currentSessionId by dispatchHookResult.

    // Check if session is still alive — but don't kill it.
    // Preserve the tmux session so the user can inspect final state via Watch tab.
    // The session will be cleaned up on next spawn or destroy.
    const sessionGone = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: tmuxSession,
    });
    const exited = !sessionGone.ok || sessionGone.data !== true;
    if (!exited) {
      console.log(`[lifecycle] ${name}: session still alive after exit — preserving for inspection`);
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
        }).catch((err) => { console.warn('[cleanup] Config profile removal failed:', (err as Error).message); });
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
    proxyId, cwd, persona, previousContextPct,
    currentSessionId, spawnCount, reloadTask, oldTmuxSession,
  } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;
  const hookResume = effectiveCurrent.hookResume;
  const hookExit = effectiveCurrent.hookExit;

  const watchdog = startWatchdog(ctx, name, 'suspending', RELOAD_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Send exit command via hook resolver
    const exitResult = resolveHook('exit', hookExit, effectiveCurrent);
    await dispatchHookResult(ctx, proxyId, oldTmuxSession, exitResult, { agentName: name });

    // 2. Wait for exit
    await sleep(EXIT_WAIT_MS);

    // Session ID capture is now handled by capture steps in the exit pipeline.

    // 3. Kill tmux session
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: oldTmuxSession,
    });

    // 4. Compose system prompt (no proxy dependency)
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 5. Create fresh tmux session + write config profile
    const tmuxSession = `agent-${name}`;
    await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);

    const taskText = opts?.task ?? reloadTask;
    // For engines that support inline resume prompts (e.g. Codex), pass the task
    // as a positional CLI argument instead of pasting it separately into tmux.
    // This avoids Codex's unreliable multiline paste handling.
    const inlineTask = adapter.supportsResumePrompt && taskText
      ? `[orchestrator → ${name}] ${taskText}`
      : undefined;

    const personaFile = resolvePersonaFilePath(name, persona);
    // Read-after-write outside lock: the exit pipeline's capture step wrote
    // capturedVars atomically via updateAgentCapturedVar (SQL UPDATE) during
    // Phase 2's dispatchHookResult. This read is intentionally outside the
    // Phase 3 lock — the captured var is already persisted, and no concurrent
    // operation clears capturedVars between exit dispatch and this point.
    const postExitAgent = ctx.db.getAgent(name);
    const existingSessionId = postExitAgent?.capturedVars?.['SESSION_ID'] ?? currentSessionId;

    const reloadTemplateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: existingSessionId ?? name,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: postExitAgent?.capturedVars ?? phase1.current.capturedVars ?? undefined,
    };

    const { result: reloadResult, sessionId: reloadSessionId } = resolveResumeOrStartHook({
      adapter,
      hookResume,
      hookStart,
      agentRecord: effectiveCurrent,
      sessionId: existingSessionId,
      name,
      cwd,
      resumeTask: inlineTask,
      startTask: inlineTask,
      systemPrompt,
      permissions,
      templateVars: reloadTemplateVars,
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    // Wrap launch command with agent env vars
    const wrappedReload = wrapLaunchResult(reloadResult, effectiveCurrent, personaFile, accountHome);

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedReload, { agentName: name });

    // 6. /rename injection
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);

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
    return await finalizeToActive(ctx, name, 'suspending', 'reload_interrupted', {
      tmuxSession: `agent-${name}`,
      reloadQueued: 0,
      reloadTask: null,
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      lastActivity: new Date().toISOString(),
      currentSessionId: reloadSessionId,
    }, 'reloaded', {
      previousContextPct,
      sessionId: reloadSessionId,
    }, 'reload');
  } finally {
    clearTimeout(watchdog);
  }
}

const RECOVER_TIMEOUT_MS = parseInt(process.env['RECOVER_TIMEOUT_MS'] ?? '60000', 10);

/**
 * Recover a failed agent by killing its old session and starting fresh.
 * Sends a reconstruction prompt that tells the agent to read its own durable
 * state (collab queue, persona, git log) rather than trying to restore the
 * ephemeral session transcript.
 *
 * Accepts agents in 'failed' state only. Three-phase locking.
 */
export async function recoverAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<AgentRecord> {
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'spawning' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (agent.state !== 'failed') {
      throw new Error(`Agent "${name}" is in state "${agent.state}", recovery requires 'failed'`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'spawning', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      cwd: agent.cwd,
      persona: agent.persona,
      spawnCount: agent.spawnCount,
      oldTmuxSession: sessionName(agent),
    };
  });

  const { proxyId, cwd, persona, spawnCount, oldTmuxSession } = phase1;

  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;

  const watchdog = startWatchdog(ctx, name, 'spawning', RECOVER_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Kill old tmux session (best-effort — it may already be gone)
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: oldTmuxSession,
    }).catch(() => {});

    // 2. Compose system prompt
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 3. Create fresh tmux session
    const tmuxSession = `agent-${name}`;
    await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);

    // 4. Build spawn command with new session ID
    const generatedSessionId = randomUUID();
    const personaFile = resolvePersonaFilePath(name, persona);
    const templateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: generatedSessionId,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
    };

    const recoveryTask = [
      'Your previous session was lost. Reconstruct your context from durable state:',
      '1. Your persona and role are already loaded via system prompt',
      `2. Check recent git activity: \`git log --oneline -20\``,
      '3. Check for any pending collab messages: \`collab list-agents\` to see peer status',
      '4. Notify the operator you have recovered: \`collab send operator --topic recovery "Session recovered, reconstructing context"\`',
      'Resume your work from where you left off.',
    ].join('\n');

    const startResult = resolveHook('start', hookStart, effectiveCurrent, {
      spawnOpts: {
        name,
        cwd,
        task: recoveryTask,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: permissions === 'skip',
        sessionId: generatedSessionId,
      },
      templateVars,
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    const wrappedStart = wrapLaunchResult(startResult, effectiveCurrent, personaFile, accountHome);
    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedStart, { agentName: name });

    // 5. Inject rename
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);

    // ── Phase 3: finalize ──
    return await finalizeToActive(ctx, name, 'spawning', 'recover_interrupted', {
      tmuxSession,
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      lastActivity: new Date().toISOString(),
      currentSessionId: generatedSessionId,
    }, 'recovered', {
      engine,
      sessionId: generatedSessionId,
      reason: 'auto-recovery from failed state',
    }, 'recover');
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

    // Resolve engine config defaults for hook fields
    const engineConfig = ctx.db.getEngineConfig(agent.engine);
    const effectiveAgent = resolveEffectiveConfig(agent, engineConfig);

    // Send interrupt via hook resolver
    const interruptResult = resolveHook('interrupt', effectiveAgent.hookInterrupt, effectiveAgent);
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

    // Resolve engine config defaults for hook fields
    const engineConfig = ctx.db.getEngineConfig(agent.engine);
    const effectiveAgent = resolveEffectiveConfig(agent, engineConfig);

    // Send compact command via hook resolver
    const compactResult = resolveHook('compact', effectiveAgent.hookCompact, effectiveAgent);
    if (compactResult.mode === 'skip') {
      console.log(`[lifecycle] ${name}: engine "${effectiveAgent.engine}" does not support compaction — skipping`);
      ctx.db.logEvent(name, 'compact_skipped', undefined, { reason: 'unsupported_engine' });
      return;
    }

    // Compact is not a launch hook — no env wrapping needed.
    // COLLAB_AGENT is already set in the tmux session env from spawn.
    await dispatchHookResult(ctx, proxyId, sessionName(agent), compactResult, { agentName: name });

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

    const proxyId = requireProxy(agent);

    // Merge custom buttons: engine config defaults + agent-level overrides
    const buttons: Record<string, unknown> = {};
    const engineConfig = ctx.db.getEngineConfig(agent.engine);
    if (engineConfig?.customButtons) {
      try { Object.assign(buttons, JSON.parse(engineConfig.customButtons)); } catch {}
    }
    if (agent.customButtons) {
      try { Object.assign(buttons, JSON.parse(agent.customButtons)); } catch {}
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
 * Execute an indicator action by parsing the agent's indicators JSON,
 * finding the named indicator and action, and dispatching the pipeline steps.
 */
export async function executeIndicatorAction(
  ctx: LifecycleContext,
  name: string,
  indicatorId: string,
  actionName: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!agent.indicators) throw new Error(`Agent "${name}" has no indicators`);

    const proxyId = requireProxy(agent);
    let defs: Array<{ id: string; regex?: string; actions?: Record<string, unknown> }>;
    try {
      defs = JSON.parse(agent.indicators) as Array<{ id: string; regex?: string; actions?: Record<string, unknown> }>;
    } catch {
      throw new Error(`Agent "${name}" has invalid indicators JSON`);
    }

    const indicator = defs.find(d => d.id === indicatorId);
    if (!indicator) throw new Error(`Indicator "${indicatorId}" not found for agent "${name}"`);
    if (!indicator.actions) throw new Error(`Indicator "${indicatorId}" has no actions`);

    // Capture pane output and run the indicator regex to get capture groups for $N interpolation
    let match: RegExpExecArray | null = null;
    if (indicator.regex) {
      try {
        const captureResult = await ctx.proxyDispatch(proxyId, {
          action: 'capture',
          sessionName: sessionName(agent),
          lines: 50,
        });
        if (captureResult.ok && typeof captureResult.data === 'string') {
          match = new RegExp(indicator.regex).exec(captureResult.data);
        }
      } catch { /* best effort */ }
    }

    // Find the action — try exact match first, then try interpolated match
    let steps = indicator.actions[actionName] as PipelineStep[] | undefined;
    if ((!steps || !Array.isArray(steps)) && match) {
      // The action key in the DB may be $1, $2, etc. — find the matching definition key
      for (const [key, val] of Object.entries(indicator.actions)) {
        const interpolatedKey = key.replace(/\$(\d+)/g, (_m, idx) => match![parseInt(idx, 10)] ?? '');
        if (interpolatedKey === actionName && Array.isArray(val)) {
          // Interpolate $N in the pipeline steps too
          steps = (val as PipelineStep[]).map(step => {
            if (step.type === 'keystroke') return { ...step, key: step.key.replace(/\$(\d+)/g, (_m, idx) => match![parseInt(idx, 10)] ?? '') };
            if (step.type === 'shell') return { ...step, command: step.command.replace(/\$(\d+)/g, (_m, idx) => match![parseInt(idx, 10)] ?? '') };
            return step;
          });
          break;
        }
      }
    }

    if (!steps || !Array.isArray(steps)) {
      throw new Error(`Action "${actionName}" not found on indicator "${indicatorId}" for agent "${name}"`);
    }

    const templateVars = {
      AGENT_NAME: name,
      AGENT_CWD: agent.cwd,
      SESSION_ID: agent.currentSessionId ?? undefined,
      capturedVars: agent.capturedVars ?? undefined,
    };
    const result = resolveHook('exit', steps, agent, { templateVars });
    await dispatchHookResult(ctx, proxyId, sessionName(agent), result, { agentName: name });

    ctx.db.logEvent(name, 'indicator_action', undefined, { indicator: indicatorId, action: actionName });
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

  // Resolve engine config defaults for hook fields
  const engineConfig = ctx.db.getEngineConfig(agent.engine);
  const effectiveAgent = resolveEffectiveConfig(agent, engineConfig);

  await ctx.locks.withLock(agent.name, async () => {
    try {
      const hookResult = resolveHook('submit', effectiveAgent.hookSubmit, effectiveAgent, { task: text });
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
