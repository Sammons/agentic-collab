/**
 * IPC + env-contract helpers for ephemeral agent instances.
 *
 * Each ephemeral instance gets a private directory under `${IPC_ROOT}/<id>/`
 * containing three files:
 *  - `message`  — JSON payload the agent reads (populated by orchestrator)
 *  - `reply`    — JSON reply the agent writes via `collab complete`
 *  - `status`   — single-line marker the reaper polls (`ok` or `error\n<...>`)
 *
 * `buildInstanceEnv` returns the v3 env contract per
 * docs/v3-vision.md §"Env contract" — a flat key/value record that both
 * `prepare`/`cleanup` (host shell) and `start` (tmux paste) see.
 *
 * The `IPC_ROOT` defaults to `${DB_DIR}/instances` so it sits alongside other
 * orchestrator-managed state; the proxy reads/writes paths via the same
 * filesystem since prepare/cleanup run on the proxy host.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type InstanceIpcPaths = {
  messagePath: string;
  replyPath: string;
  statusPath: string;
};

/**
 * Allocate IPC paths for an instance: creates the directory and writes
 * empty sentinel files for `reply` and `status`. The `message` file is
 * created later by the caller with the actual payload.
 *
 * Calling twice for the same id is idempotent at the directory level; the
 * sentinel files are re-written empty if already present.
 */
export function allocateIpcPaths(instanceId: string, ipcRoot: string): InstanceIpcPaths {
  const dir = join(ipcRoot, instanceId);
  mkdirSync(dir, { recursive: true });
  const messagePath = join(dir, 'message');
  const replyPath = join(dir, 'reply');
  const statusPath = join(dir, 'status');
  // Touch the reply + status files so the reaper's statSync never races.
  writeFileSync(replyPath, '');
  writeFileSync(statusPath, '');
  return { messagePath, replyPath, statusPath };
}

export type BuildEnvOpts = {
  messageId: string;
  messagePath: string;
  replyPath: string;
  statusPath: string;
  worktreePath: string;
  cwdBase: string;
  repoRoot: string;
  agentTemplate: string;
  topicName: string;
  instanceAddr: string;
  replyToAddr: string | null;
  instanceId: string;
  /** Raw message payload string (the JSON publishers sent). */
  messageContent: string;
};

/**
 * Build the env contract record (flat string-to-string) used for host-shell
 * `exec` wrappers (prepare/cleanup). Includes MESSAGE_CONTENT — the raw
 * publish payload — because `/bin/sh -c "KEY=$(printf %s "$VAL"); ..."` style
 * `export` wrapping handles newlines and control chars.
 *
 * DO NOT pass this map directly to `tmux set-environment` — tmux env entries
 * cannot carry newlines safely. Derive the tmux subset via
 * `buildTmuxSessionEnv(buildHostShellEnv(opts))`.
 */
export function buildHostShellEnv(opts: BuildEnvOpts): Record<string, string> {
  return {
    MESSAGE_ID: opts.messageId,
    MESSAGE_PATH: opts.messagePath,
    REPLY_PATH: opts.replyPath,
    STATUS_PATH: opts.statusPath,
    MESSAGE_CONTENT: opts.messageContent,
    WORKTREE_PATH: opts.worktreePath,
    CWD_BASE: opts.cwdBase,
    REPO_ROOT: opts.repoRoot,
    AGENT_TEMPLATE: opts.agentTemplate,
    TOPIC_NAME: opts.topicName,
    INSTANCE_ADDR: opts.instanceAddr,
    REPLY_TO_ADDR: opts.replyToAddr ?? '',
    INSTANCE_ID: opts.instanceId,
  };
}

/**
 * Keys that are safe to push into a tmux session via `tmux set-environment`.
 * Excludes `MESSAGE_CONTENT` (the raw publish payload — may contain newlines,
 * control characters, or be large enough to corrupt tmux env state).
 *
 * Agents access the payload through `$MESSAGE_PATH` instead.
 */
export const TMUX_SAFE_ENV_KEYS = [
  'MESSAGE_ID',
  'MESSAGE_PATH',
  'REPLY_PATH',
  'STATUS_PATH',
  'WORKTREE_PATH',
  'CWD_BASE',
  'REPO_ROOT',
  'AGENT_TEMPLATE',
  'TOPIC_NAME',
  'INSTANCE_ADDR',
  'REPLY_TO_ADDR',
  'INSTANCE_ID',
] as const;

/**
 * Derive the tmux-safe subset of a host-shell env record. Strips
 * MESSAGE_CONTENT (and any other key not in `TMUX_SAFE_ENV_KEYS`).
 */
export function buildTmuxSessionEnv(hostEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of TMUX_SAFE_ENV_KEYS) {
    if (key in hostEnv) {
      out[key] = hostEnv[key]!;
    }
  }
  return out;
}

/**
 * @deprecated Use `buildHostShellEnv` (full env) or
 * `buildTmuxSessionEnv(buildHostShellEnv(opts))` (tmux-safe subset). Retained
 * so the reaper's cleanup wrapper, which only needs the host-shell view, can
 * keep its existing call shape.
 */
export function buildInstanceEnv(opts: BuildEnvOpts): Record<string, string> {
  return buildHostShellEnv(opts);
}
