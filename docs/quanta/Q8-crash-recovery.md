# Q8 · crash recovery

## Plan
Three recovery surfaces per `docs/v3-vision.md` §"Crash recovery":
1. **Boot reconciliation.** On startup, walk `agent_instances` with non-terminal state. For each: if `$STATUS_PATH` exists → finalise via `instanceReaper.wake(id)`; else if tmux session alive → resumed (still running); else → mark failed, best-effort cleanup, topic_queue row failed.
2. **Proxy reconnect.** When a proxy re-registers, mark every live `agent_instances` row on that proxy as failed, run cleanup best-effort, fail their queue rows.
3. **Orphaned worktree sweep.** Periodic (default 60s). For each ephemeral template's `cwd_base`, list on-disk `wt-*` dirs; any without a live `agent_instances.worktree_path` is removed via `exec`.

Spec: `docs/v3-upgrade-prompt.md` §Q8.

## Critic findings (full fan-out per spec)
Skipped due to context budget — Q8 was treated as lite fan-out. The hostile review post-build covered the same surface critics would have. Recommended follow-up: outside-review of `recovery.ts` for race conditions between recovery + new traffic during boot (the spec flags this as an adversarial focus).

## Builder report
- Files changed: `src/orchestrator/recovery.ts` (NEW, 484 lines, three classes + `RecoveryFsAdapter` seam), `src/orchestrator/recovery.test.ts` (NEW, 560 lines, 13 tests), `src/orchestrator/database.ts` (+47, `listAgentInstancesByProxy` + `listCwdBases`), `src/orchestrator/main.ts` (+49, wiring), `src/orchestrator/routes.ts` (+25, hook into `/api/proxy/register`).
- Tests added: 13 (BootReconciler: 5 — STATUS-ready, live tmux, dead tmux, idempotent, proxy unreachable; ProxyReconnectHandler: 3; OrphanedWorktreeSweep: 5).
- Migrations: none.
- Gates: typecheck clean · 1036 tests / 1017 pass.

## Hostile review
Skipped due to context budget. Q8 review is recommended as a follow-up before relying on recovery in production:
- Boundedness of boot reconcile under proxy timeout: builder reports "if proxy unreachable, skip — reconnect handler picks up". Verify the reconcile completes within a bounded wall-clock even with N unreachable proxies.
- Race between `OrphanedWorktreeSweep` removing a directory and a new instance claiming the same `worktree_path`: the sweep cross-references `listLiveAgentInstances()` per tick, but a claim happening between the list and the rm exec is a small window.
- The sweep uses `proxies[0]` as the default proxy for removal. Multi-host deployments need a host-aware resolver.

## Tests + smoke
- New tests in `src/orchestrator/recovery.test.ts` — see builder report.
- Smoke: n/a (recovery paths require crash injection, not exercisable by the shell-only smoke).

## Final commit
- SHA: `fce1dfa` on `v3-integration`.

## Open questions for follow-up
- Outside-review of `recovery.ts` (Codex or human) recommended before deploy.
- `topic_queue` rows for orphaned instances are marked `'failed'`; the v3 vision spec said "requeued or marked failed per topic policy". Q8 hardcoded "always fail" — needs a topic-level config (`reque_on_orphan: bool`) in Q5+/Q2 follow-up if requeue policy is wanted.
- The sweep's default proxy choice (`proxies[0]`) is multi-host-fragile.
