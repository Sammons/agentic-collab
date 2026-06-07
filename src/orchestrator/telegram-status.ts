/**
 * RFC-008 PR-E: per-agent Telegram bot-status derivation.
 *
 * Pure status logic so the dashboard indicator and the GET /api/telegram/status
 * route agree by construction. Kept token-free: the inputs are non-secret
 * binding config (`agentTelegram`) plus two booleans (`hasToken`, `polling`) —
 * the resolved token NEVER enters this module.
 */
import type { AgentRecord, AgentTelegramConfig } from '../shared/types.ts';

/** One agent's Telegram bot state, as surfaced by GET /api/telegram/status. */
export type TelegramAgentStatus = {
  agent: string;
  /** True when the persona declares a `telegram:` block (agentTelegram != null). */
  configured: boolean;
  /** Effective inbound flag (defaults true when configured; false = outbound-only). */
  inbound: boolean;
  /** Routing mode, or null when unconfigured. */
  routing: string | null;
  /** Default outbound chat id, or null when unconfigured. */
  chatId: string | null;
  /** Whether an encrypted token row exists (never the token itself). */
  hasToken: boolean;
  /** Whether a poll loop is currently running for this agent. */
  polling: boolean;
  /** Derived rollup state for the dashboard dot. */
  status: 'running' | 'idle' | 'token-missing' | 'disabled';
};

/**
 * Derive one agent's bot status from its binding config + two runtime booleans.
 *
 * Rule (mirrors reconcileTelegramBots' desired-set gating):
 *   - `disabled`      — not configured, OR inbound === false (outbound-only).
 *   - `token-missing` — configured + inbound, but no encrypted token row.
 *   - `running`       — configured + inbound + token + a live poll loop.
 *   - `idle`          — configured + inbound + token, but not polling
 *                       (dedup-skipped against a destination/another agent, or
 *                       pre-reconcile after a restart).
 *
 * NEVER consumes or returns the token — `hasToken` is the only token-derived input.
 */
export function deriveTelegramStatus(
  agent: Pick<AgentRecord, 'name' | 'agentTelegram'>,
  hasToken: boolean,
  polling: boolean,
): TelegramAgentStatus {
  const cfg: AgentTelegramConfig | null = agent.agentTelegram;
  const configured = cfg != null;
  // The frontmatter `inbound` is parsed as a string-or-boolean upstream; treat
  // an explicit `false` (boolean or the literal string 'false') as outbound-only.
  const inbound = configured && cfg.inbound !== false && (cfg.inbound as unknown) !== 'false';

  let status: TelegramAgentStatus['status'];
  if (!configured || !inbound) {
    status = 'disabled';
  } else if (!hasToken) {
    status = 'token-missing';
  } else if (polling) {
    status = 'running';
  } else {
    status = 'idle';
  }

  return {
    agent: agent.name,
    configured,
    inbound,
    routing: cfg?.routing ?? null,
    chatId: cfg?.chatId ?? null,
    hasToken,
    polling,
    status,
  };
}
