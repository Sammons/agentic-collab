/**
 * Agent entity helpers — canonical accessors for common agent patterns.
 * Eliminates scattered inline logic for session names, proxy checks, and state groups.
 */

import type { AgentRecord } from './types.ts';

/** Canonical tmux session name for an agent. */
export function sessionName(agent: AgentRecord): string {
  return agent.tmuxSession ?? `agent-${agent.name}`;
}

/** Returns proxyId or throws if the agent has no proxy assigned. */
export function requireProxy(agent: AgentRecord): string {
  if (!agent.proxyId) {
    throw new Error(`Agent "${agent.name}" has no proxy assigned`);
  }
  return agent.proxyId;
}

/** Agent is in a running state (has or should have a tmux session). */
export function isRunning(agent: AgentRecord): boolean {
  return agent.state === 'active' || agent.state === 'idle' || agent.state === 'spawning';
}

/** Agent can be suspended (active or idle). */
export function canSuspend(agent: AgentRecord): boolean {
  return agent.state === 'active' || agent.state === 'idle';
}

/** Agent can be resumed (suspended or failed). */
export function canResume(agent: AgentRecord): boolean {
  return agent.state === 'suspended' || agent.state === 'failed';
}
