/**
 * Agent entity helpers — canonical accessors for common agent patterns.
 * Eliminates scattered inline logic for session names, proxy checks, and state groups.
 */

import type { AgentRecord } from './types.ts';

/** Canonical tmux session name for an agent. */
export function sessionName(agent: AgentRecord): string {
  return agent.tmuxSession ?? `agent-${agent.name}`;
}

/**
 * Thrown when an agent cannot be placed on a proxy: either no proxy is known at
 * all, the persona-pinned proxy is not currently registered, or the agent's
 * assigned `proxyId` references a proxy that is no longer registered (stale
 * placement). Carries the offending proxy id in `pin` (when relevant) so
 * background callers can record a precise failure reason.
 */
export class ProxyUnavailableError extends Error {
  readonly agentName: string;
  readonly pin: string | null;
  constructor(agentName: string, pin: string | null) {
    super(
      pin
        ? `Agent "${agentName}": proxy "${pin}" is not registered`
        : `Agent "${agentName}" has no proxy assigned`,
    );
    this.name = 'ProxyUnavailableError';
    this.agentName = agentName;
    this.pin = pin;
  }
}

/**
 * Resolve the proxy an agent must run on, for every lifecycle operation.
 *
 * `proxyPin` (persona frontmatter `proxy:`) is authoritative over the runtime
 * `proxyId` — so a stale or migrated `proxyId` can never place a pinned agent
 * on the wrong proxy. When a pin is set and `registeredProxies` is provided,
 * the pin must be live or this throws (fail-loud, RFC-003 §2/§2a).
 *
 * An un-pinned agent's `proxyId` is likewise validated against
 * `registeredProxies` when provided: a stale `proxyId` pointing at a proxy that
 * is no longer registered throws the same typed `ProxyUnavailableError` rather
 * than being returned blindly. Returning it would only defer the failure to a
 * cryptic downstream dispatch error ("Proxy X not registered") and leave the
 * agent wedged in `failed`; the typed error names the stale proxy so callers
 * and operators get a clear "placed on unregistered proxy" signal. We do NOT
 * auto-pick a different proxy — host affinity is not knowable here, so the
 * explicit error is the correct outcome.
 *
 * `registeredProxies` is optional so the pure helper stays unit-testable; live
 * lifecycle callers pass `new Set(db.listProxies().map(p => p.proxyId))`. When
 * it is omitted, the un-pinned path preserves the prior behavior and returns
 * `proxyId` without validation.
 */
export function requireProxy(agent: AgentRecord, registeredProxies?: ReadonlySet<string>): string {
  if (agent.proxyPin) {
    if (registeredProxies && !registeredProxies.has(agent.proxyPin)) {
      throw new ProxyUnavailableError(agent.name, agent.proxyPin);
    }
    return agent.proxyPin;
  }
  if (!agent.proxyId) {
    throw new ProxyUnavailableError(agent.name, null);
  }
  if (registeredProxies && !registeredProxies.has(agent.proxyId)) {
    throw new ProxyUnavailableError(agent.name, agent.proxyId);
  }
  return agent.proxyId;
}

/** Agent is in a running state (has or should have a tmux session). */
export function isRunning(agent: AgentRecord): boolean {
  return agent.state === 'active' || agent.state === 'idle' || agent.state === 'spawning' || agent.state === 'resuming';
}

/** Agent is in a transitional state (operation in progress). */
export function isTransitioning(agent: AgentRecord): boolean {
  return agent.state === 'spawning' || agent.state === 'resuming' || agent.state === 'suspending';
}

/** Agent can be suspended (active or idle). */
export function canSuspend(agent: AgentRecord): boolean {
  return agent.state === 'active' || agent.state === 'idle';
}

/** Agent can be resumed (suspended or failed). */
export function canResume(agent: AgentRecord): boolean {
  return agent.state === 'suspended' || agent.state === 'failed';
}
