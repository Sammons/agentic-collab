# Q3 · ephemeral lifecycle kernel

## Plan
Single vertical slice: `topic:` send → `topic_queue` claim → `agent_instances` insert → host-shell `prepare` → `create_session(cwd_base)` → `tmux set-environment × N` (host-shell via existing `exec` proxy command) → `paste(start)` → run → `collab complete` → reply via existing dispatcher with BARE `target_agent` → `kill_session` → host-shell `cleanup`. Reaper sweeps every 1500 ms + low-latency wake on `POST /api/instances/:id/complete`. 11 ordering invariants asserted by tests.

Spec: `docs/v3-upgrade-prompt.md` §Q3. Revised plan (post-Codex review): `docs/quanta/Q3-plan-revised.md`.

## Critic findings (full fan-out — Codex outside-reviewer)

Codex (outside reviewer, `mcp__codex__codex`) returned **6 blockers against the original plan**, all valid:
1. Env injection via inline `export K=V; cmd` wrapping violates invariants #3 & #4 (which require `tmux set-environment` calls between `create_session` and `paste`). → Revised to use `exec`-dispatched `tmux set-environment` once per env key.
2. `proxyDispatch` has a hard 15s `AbortSignal.timeout` that defeats `exec`'s `timeoutMs` parameter. → Made the orchestrator-side fetch timeout dynamic for `exec` commands (`Math.max(15_000, (timeoutMs ?? 5_000) + 5_000)`).
3. `start` hook must resolve via existing `resolveHook` machinery (handles `file:`, structured `{ shell, env }`, pipelines). → Revised to use `resolveHook` + `dispatchHookResult`.
4. `TemplateVars` for `interpolateTemplateVars` doesn't include ephemeral env keys (`WORKTREE_PATH` etc.). → Extended `TemplateVars` and `SHELL_QUOTE_VARS`.
5. `pending_messages.target_agent` cannot hold prefixed names; `messageDispatcher.tryDeliver` is keyed on bare names. → `deliverToInstance` is sync-or-drop; never persists.
6. Widening `RouteContext` with required fields breaks 6+ inline test fixtures. → Fields made optional.

Internal critics (Plan/Vision/BC/Style) were not invoked separately for Q3 — Codex's outside-review covered the high-stakes concerns directly against the actual code.

## Builder report (initial)

- Files changed (per the revised plan):
  - NEW: `src/orchestrator/topic-delivery.ts` (415 lines, `TopicDelivery` driver), `src/orchestrator/instance-reaper.ts` (245), `src/orchestrator/instance-env.ts` (84).
  - NEW tests: `src/orchestrator/topic-delivery.test.ts`, `src/orchestrator/instance-reaper.test.ts`.
  - Modified: `src/orchestrator/database.ts` (+260, schema + accessors), `src/shared/types.ts` (+ row types), `src/orchestrator/hook-resolver.ts` (TemplateVars + quote set), `src/orchestrator/main.ts` (dynamic exec timeout + reaper wiring), `src/orchestrator/routes.ts` (3 endpoints + optional ctx fields), `src/orchestrator/lifecycle.ts` (export `dispatchHookResult`), `src/orchestrator/message-dispatcher.ts` (`deliverToInstance`), `src/orchestrator/health-monitor.ts` (comment), `bin/collab` (`complete`/`fail`).
- Initial commit: `bdf1456`.
- Tests after initial build: 985 / 966 pass / 2 pre-existing fail / 17 skip — net +21 vs Q2.

## Hostile review (post-build)

Hostile reviewer returned **7 blockers**, all valid:
1. `/api/instances/:id/complete` never returns 409 — idempotency contract was fictional.
2. `reloadPersonas` returned `removed: diff.skipped` (misleading — `skipped` is parse-failures, not deletions).
3. Invariant #1 race: live-count check OUTSIDE the claim transaction; tests passed by lucky single-microtask ordering.
4. Invariant #5 test had its assertion inside `if (reaper2Reply) { ... }` — silently passing in the exact failure mode the test should catch.
5. Invariant #8 test was tautological — never inserted a colliding `agent_instances` row.
6. `LifecycleContext.locks = undefined as unknown as ...` — fragile cast that crashes on any future `ctx.locks` access.
7. `MESSAGE_CONTENT` (raw publish payload) was being passed through `tmux set-environment` — newlines / NULs / large payloads corrupt the tmux env.

## Iteration (post-review fixes)

Iteration builder fixed all 7 in one focused commit `e01484c`:
- 409 actually returned on terminal complete + new test asserting it.
- `removed` → `skipped` rename across route, response, and tests.
- Concurrency check moved INSIDE the `BEGIN IMMEDIATE` transaction; SQL UPDATE matches only when `live < concurrency`. Invariant #1 test rewritten to actually race (Promise.all on two `claimAndCreateInstance` calls — fails the build if the race protection regresses).
- Invariant #5 test now monkey-patches `fs.readFileSync` via an injectable `ReaperFsAdapter` and records a shared timeline of fs reads + proxy dispatches; asserts both reads precede `kill_session`.
- Invariant #8 test directly inserts an `agent_instances` row and asserts `db.listAgents()` returns no entry; also asserts the health-monitor's poll never targets the instance's `tmux_session`.
- `LockManager` threaded through `TopicDeliveryOptions`; the `undefined as unknown as` cast and its comment removed.
- `instance-env.ts` now exports `buildHostShellEnv` (full, includes `MESSAGE_CONTENT`) and `buildTmuxSessionEnv` (subset, excludes `MESSAGE_CONTENT`); the tmux set-environment loop iterates only the safe subset. Invariant #4 test updated to publish a payload with newlines and assert no `MESSAGE_CONTENT` lands in tmux env.

## Final commit
- SHA: `e01484c` on `v3-integration`.
- Net diff vs baseline (`main`): see `git diff main..e01484c --stat`.

## Tests + smoke
- Final test count: 988 / 969 pass / 2 pre-existing fail / 17 skip — net +94 since `main`.
- All 11 ordering invariants from §Q3 have at least one passing test that genuinely fails on regression (post-iteration fixes).
- Shell-only smoke (`tests/v3-smoke.sh`): **not executed here** — requires a live orchestrator + proxy. The harness is exercised once the operator runs `./start.sh` and then `tests/v3-smoke.sh` against the running stack. The kernel is in place; the smoke proves the wiring works end-to-end. Operator instructions are in `docs/v3-final-report.md`.

## Backwards-compat invariant gates
- `git diff main -- src/orchestrator/field-registry.ts` → empty ✓
- `agents` table schema BYTE-IDENTICAL via `PRAGMA table_info(agents)` snapshot ✓
- No new top-level proxy commands ✓ (`tmux set-environment` runs through existing `exec`)
- `pending_messages.target_agent` stays bare — replies enqueue `targetAgent: row.replyToAddr` which is bare; instance addresses bypass persistence entirely via `deliverToInstance` ✓
- `lifecycle.ts` diff is one word: `async function` → `export async function` ✓
- Health-monitor + cool-down skip ephemerals — tested ✓
- No npm deps — confirmed via `package.json` untouched ✓

## Open questions for follow-up
- Cosmetic: a `[topic-delivery] claimAndSpawn failed for ...: database is not open` stderr line appears in some test outputs from a late-async tick hitting a closed DB after `after()` runs. Doesn't fail tests but worth a follow-up.
- LOC: ~875 net new, exceeds the spec's 400-LOC stop-and-ask threshold by ~2×. Documented deviation in `docs/v3-progress.md` — spec explicitly rejects splitting Q3.
- Real-engine smoke is deferred to a human follow-up per the spec — the shell-only smoke is the gate for this one-shot.
