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
 * Build the env contract record (flat string-to-string) injected into the
 * tmux session via `tmux set-environment` AND passed to the host-shell
 * prepare/cleanup hooks as their child-process env.
 */
export function buildInstanceEnv(opts: BuildEnvOpts): Record<string, string> {
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
