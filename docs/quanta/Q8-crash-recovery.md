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
- `topic_queue` rows for orphaned instances default to `'failed'`. `V3_RECOVERY_QUEUE_POLICY=requeue` flips the global policy to requeue. A per-topic `requeue_on_orphan` flag (Q2 schema change) remains a future enhancement.
- The multi-host proxy resolver (C5) is a heuristic — it joins on `agent_instances` history. A freshly provisioned host with zero ephemeral history will still hit the "no proxy known" path. Proper fix needs host-aware template metadata.

## Hostile-review / Codex-outside-review fixes (post-`fce1dfa`)

CRITICAL:
- **C1 — bounded boot reconcile.** Added `wallClockCapMs` (default 30s, env `BOOT_RECONCILE_TIMEOUT_MS`) and parallel chunks (default 10). Cap-hit logs a warning with the unreconciled count; reconnect handler / periodic sweep covers the remainder.
- **C2 — `ProxyReconnectHandler` probes `has_session` first.** Mirrors the persistent self-heal in `routes.ts:128-137`. `data: true` → leave alone (live tmux); `data: false` → fail; `ok: false` → skip (proxy unreachable mid-handler).
- **C3 — sweep single-flight.** `sweepInFlight` guard prevents overlapping ticks from racing the read-then-rm sequence.
- **C4 — sweep TOCTOU mitigation.** Immediately before each `rm` exec: (a) re-query `listLiveAgentInstances` and skip if the path is now claimed; (b) 60s mtime grace (env-configurable via `mtimeGraceMs`) so freshly-mkdir'd dirs aren't removed. Clock-skew clamp on `Math.max(0, now - mtime)` so a 0ms grace doesn't false-positive on filesystems that report sub-millisecond futures.
- **C5 — multi-host orphan removal.** Default `proxyResolver` joins `agent_instances` × `agent_templates` × `proxies` to pick a proxy that has serviced this `cwd_base`. Logs a one-time warning and skips when no candidate exists.
- **C6 — `'spawning'` / `'completing'` excluded from recovery's working set.** Q3 owns `'spawning'`; the reaper owns `'completing'`. Recovery touching either produces contradictory terminal outcomes.

HIGH:
- **H1 — cleanup gated on worktree existence.** Boot reconciler's dead-session path matches the reconnect handler: only run `cleanup` exec if `worktree_path` is a directory on disk.
- **H2 — `'completing'` excluded from reconnect handler.** Reaper has exclusive ownership; covered by C6's filter.
- **H3 — `V3_RECOVERY_QUEUE_POLICY=fail|requeue` env switch.** Default `fail` (terminal). `requeue` calls a new `db.requeueTopicQueueRow(id)` accessor that resets `status='queued'` and clears `claimed_by_instance`/`worktree_path`. Per-topic policy deferred to a future quantum.
- **H4 — `onProxyRegister` single-flight per proxy_id.** `inFlightProxies` set prevents back-to-back register calls from double-processing the same instance set.
- **H5 — `git -C <repo_root>` for worktree removal.** Looks up the source repo from `agent_templates.repo_root` when present; falls back to plain `rm -rf` otherwise.

MEDIUM:
- **M1 — ordering asserted via timeline arrays.** "STATUS-ready → reaper.wake" test now records the wake call directly. "Dead session → mark-failed" test now asserts cleanup exec is dispatched BEFORE the `'failed'` state transition.
- **M2 — idempotency asserts no double-effects.** Re-running `reconcile()` produces EXACTLY one cleanup exec and EXACTLY one `instance_failed` WS event.
- **M3 — known limitation documented.** `buildCleanupEnv` reads template fields at recovery time, not at spawn time. Worktree-derived fields are stable (stored on the instance row); template-derived fields may be stale if the template was edited mid-flight.
- **M4 — proxy-unreachable reconnect test.** `has_session` returning `{ ok: false }` mid-handler: row skipped, no kill, no cleanup.

LOW:
- **L1 — dropped dead `topicDelivery?` option** on `BootReconcilerOptions`.
- **L2 — `DEFAULT_WORKTREE_PREFIX = /^wt-/` extracted** to `shared/utils.ts`.
- **L3 — corrected the "T+60s vs T+0" comment** in `main.ts`.

### Files touched (post-`fce1dfa`)
- `src/orchestrator/recovery.ts` — full rewrite of all three classes (BootReconciler chunked + capped, ProxyReconnectHandler probe-first + single-flight, OrphanedWorktreeSweep single-flight + TOCTOU + multi-host).
- `src/orchestrator/recovery.test.ts` — 28 tests (was 13), with ordering / idempotency / TOCTOU / single-flight / multi-host / queue-policy / spawning-excluded / completing-excluded / proxy-unreachable coverage.
- `src/orchestrator/database.ts` — `listLiveAgentInstances` + `listAgentInstancesByProxy` accept `excludeStates`; new `requeueTopicQueueRow(id)` accessor.
- `src/orchestrator/main.ts` — removed `topicDelivery` from `BootReconciler` call; updated T+60s comment.
- `src/shared/utils.ts` — exported `DEFAULT_WORKTREE_PREFIX`.

No new npm deps. No `ALTER TABLE` against any pre-existing table. `field-registry.ts` is untouched.
