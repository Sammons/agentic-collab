# Q1 · address router

## Plan
Introduce three address classes (`agent:`, `topic:`, `approval:`) with a single internal `resolveAddress(raw)` returning a discriminated union. **Wire only `agent:`/bare in this quantum.** `topic:` and `approval:` must parse but resolution returns 503 with body `{ error: "address class not yet wired", class: <class> }`. `agent:<tmpl>/<inst-id>` likewise returns 503 until Q3 makes instances exist. Storage continues to use bare names in `pending_messages.target_agent`. `bin/collab` widens client-side target validation so prefixed addresses skip the bare-name `/api/agents` check.

Spec: `docs/v3-upgrade-prompt.md` §Q1.

## Critic findings (lite fan-out — single hostile reviewer)
- Hostile reviewer returned `BLOCKERS: none`.
- Notes (non-blocking, recorded for follow-up):
  - 503 body uses `class: "agent-instance"` for the `agent:<tmpl>/<inst-id>` case. Spec said "no such instance" for that case but didn't fully specify the error shape — current behaviour is consistent with the other 503 paths.
  - Bare names containing `:` reach the server as the literal target (no client-side check) and get rejected as malformed there. Acceptable.

## Builder report
- Files changed:
  - `src/shared/address.ts` — NEW, 134 lines
  - `src/shared/address.test.ts` — NEW, 147 lines, 49 cases
  - `src/shared/types.ts` — +2 (re-export `Address`)
  - `src/orchestrator/routes.ts` — +44 (wrap two send endpoints)
  - `src/orchestrator/routes.test.ts` — +94, 7 cases
  - `bin/collab` — +5 / -3 (widen target validation)
  - Total: 426 insertions / 3 deletions, 6 files
- Tests added: 56 new (49 address + 7 routes). All green.
- Migrations: none.
- Gates: type check pass (no new error classes vs baseline) · tests +56 new pass / 0 new failures vs `BASELINE_TESTS`.

## Hostile review
- Blockers found: 0
- Iterations: 1
- Final verdict: approved

## Tests + smoke
- New tests: `src/shared/address.test.ts` (49 cases — bare, agent:, agent:tmpl/inst, topic:, approval:, all malformed branches, `addressToString` round-trip), `src/orchestrator/routes.test.ts` (+7 cases — `agent:name` stores bare in `pending_messages.target_agent`, 503 for topic:/approval:/agent-instance, 400 for malformed, dashboard-send same).
- Smoke run: n/a (Q1 alone is not exercisable end-to-end; smoke runs from Q3 onward).

## Final commit
- Merge SHA: `0d86f7c` on `v3-integration`
- Builder branch: `worktree-agent-a90d74d8a0a673dce` (final commit `b8d4233`)

## Backwards-compat invariant gates
- `git diff main -- src/orchestrator/field-registry.ts` → empty ✓
- `agents` table schema unchanged ✓
- `pending_messages.target_agent` stores bare names (test asserted) ✓
- Bare `send(agentId, ...)` continues to work ✓

## Open questions for follow-up
- None blocking. Minor: align the 503 body for `agent:<tmpl>/<inst-id>` with the spec's "no such instance" wording when Q3 wires the agent-instance class.
