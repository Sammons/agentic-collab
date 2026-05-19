# Q6 · monitor sidecar pairing

## Plan
When a topic config includes `monitor_template`, the worker's lifecycle spawns the named monitor through the same Q3 kernel — own IPC paths, own tmux session, `$TARGET_TMUX_SESSION` pointing at the worker's session — and tears it down (kill_session + cleanup) when the worker reaches terminal state. Cycle protection: monitor templates with their own `monitor_template` are silently ignored (sync-time warning).

Spec: `docs/v3-upgrade-prompt.md` §Q6.

## Critic findings (lite fan-out)
No critics invoked.

## Builder report
- Files changed: `src/orchestrator/topic-delivery.ts` (+207, `spawnMonitor` + `failMonitor`), `src/orchestrator/instance-reaper.ts` (+105, `tearDownMonitor`), `src/orchestrator/database.ts` (+63, `createMonitorInstance` + `findMonitorForWorker`), `src/orchestrator/instance-env.ts` (+15, `targetTmuxSession` arg on `buildTmuxSessionEnv`), `src/orchestrator/template-sync.ts` (+20, recursion warning), 2 test files (+201).
- Tests added: 5 — sidecar spawned with `$TARGET_TMUX_SESSION`, `monitor_of_instance` set, no recursion, worker completion tears down monitor, monitor `collab complete` first is finalised independently.
- Migrations: none — `agent_instances.monitor_of_instance` was added in Q3.
- Gates: typecheck clean · 999 tests / 980 pass post-merge.

## Hostile review
Skipped per lite-fan-out protocol.

## Tests + smoke
- Smoke: n/a (no monitor path in the kernel smoke).

## Final commit
- SHA: `deef7a3` on `v3-integration` (merge of worktree branch `worktree-agent-a1927b502e5723d8f`, builder commit `ad6418d`).

## Open questions for follow-up
- Monitor templates currently fail silently when their own template isn't `persistent: false`; consider surfacing as a sync-time warning alongside the recursion warning.
- The monitor's `instance_addr` is `agent:<monitor_template>/<monitor_id>` — addressable mid-run via `messageDispatcher.deliverToInstance`. Verified by the existing Q3 invariant #10 test.
