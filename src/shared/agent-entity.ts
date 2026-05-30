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
 * Thrown when an agent cannot be placed on a proxy: either no proxy is known
 * at all, or the persona-pinned proxy is not currently registered. Carries the
 * pin (when relevant) so background callers can record a precise failure reason.
 */
export class ProxyUnavailableError extends Error {
  readonly agentName: string;
  readonly pin: string | null;
  constructor(agentName: string, pin: string | null) {
    super(
      pin
        ? `Agent "${agentName}": pinned proxy "${pin}" is not registered`
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
 * `registeredProxies` is optional so the pure helper stays unit-testable; live
 * lifecycle callers pass `new Set(db.listProxies().map(p => p.proxyId))`.
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
