import type { AgentRecord, EngineConfigRecord } from '../shared/types.ts';

/**
 * Merge engine config defaults into an agent record.
 * Agent-level fields take priority over engine config fields.
 * Returns a new object — does not mutate inputs.
 */
export function resolveEffectiveConfig(
  agent: AgentRecord,
  config: EngineConfigRecord | null,
): AgentRecord {
  if (!config) return agent;

  return {
    ...agent,
    // engine is NOT merged — the agent's engine field is the lookup key
    model: agent.model ?? config.model,
    thinking: agent.thinking ?? config.thinking,
    permissions: agent.permissions ?? config.permissions,
    hookStart: agent.hookStart ?? config.hookStart,
    hookResume: agent.hookResume ?? config.hookResume,
    hookCompact: agent.hookCompact ?? config.hookCompact,
    hookExit: agent.hookExit ?? config.hookExit,
    hookInterrupt: agent.hookInterrupt ?? config.hookInterrupt,
    hookSubmit: agent.hookSubmit ?? config.hookSubmit,
    launchEnv: agent.launchEnv ?? config.launchEnv,
  };
}
