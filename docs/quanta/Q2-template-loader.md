# Q2 · template loader

## Plan
Extend `persona.ts` to load `persistent`, `cwd_base`, `cwd_template`, `repo_root`, `prepare`, `cleanup`, and `topics: [...]` from frontmatter. Persist into NEW `agent_templates` and `topics` tables via a NEW `template-sync.ts` routine — **never** through `field-registry.buildUpsertOptsFromFrontmatter` (which targets the `agents` table). Branch the `cwd`-required gate so `persistent: false` skips it and routes to the template sync; existing persona files (no `persistent` field) load identically to today.

Spec: `docs/v3-upgrade-prompt.md` §Q2.

## Critic findings (lite fan-out — single hostile reviewer)
- Hostile reviewer returned `BLOCKERS: none`.
- Notes (non-blocking, recorded for follow-up):
  - The "agents column set unchanged" test compares column names only, not types/defaults. The actual schema literal in `database.ts:43-65` is byte-identical to main — manually verified. Worth tightening the assertion in a later pass.
  - `template-sync.ts` accepts an empty `topics: []` silently for ephemeral templates. Spec said "(legal but warn)"; the warn was not implemented. Defer.
  - `isEphemeralTemplate` matches only `false` and `'false'` (string); a YAML `persistent: 0` or `persistent: no` would be treated as persistent. Acceptable given current parser behaviour but worth flagging if YAML parsing is tightened.
  - Conflicting `cwd` vs `cwd_base` on the same persona is not warned about. Defer.

## Builder report
- Files changed:
  - `src/orchestrator/persona.ts` — +268 / -12 (frontmatter type, topics parser, branched gate, `trySyncTemplate` call on every persona)
  - `src/orchestrator/template-sync.ts` — NEW, 143 lines
  - `src/orchestrator/database.ts` — +169 (CREATE TABLE × 2 + 5 query methods)
  - `src/orchestrator/database.test.ts` — +118, 5 cases
  - `src/orchestrator/persona.test.ts` — +72, 3 cases
  - `src/orchestrator/template-sync.test.ts` — NEW, 364 lines, 11 cases
  - `src/shared/types.ts` — +44 (`AgentTemplateRow`, `TopicRow`)
  - Total: 1166 insertions / 12 deletions, 7 files
- Tests added: 19 new (11 template-sync + 3 persona + 5 database). All green.
- Migrations: `CREATE TABLE IF NOT EXISTS agent_templates (...)` and `CREATE TABLE IF NOT EXISTS topics (...)`. **No `ALTER TABLE agents`. No edits to `field-registry.ts`.**
- Gates: type check (no new error classes vs baseline) · tests +19 new pass / 0 new failures vs `BASELINE_TESTS`.

## Hostile review
- Blockers found: 0
- Iterations: 1
- Final verdict: approved

## Tests + smoke
- New tests: see file list above. Key cases — `persistent: false` + topics + cwd_base → agent_templates row + topics rows, no agents row; reload diff (topic removed/added/concurrency changed); missing cwd_base on ephemeral throws; persona-sync warn-and-skip; `buildMigrationStatements()` output unchanged across the sync call.
- Smoke run: n/a (runs from Q3 onward).

## Final commit
- Merge SHA: `92d4171` on `v3-integration`
- Builder branch: `worktree-agent-a5512a6a946589fe0` (final commit `61580ef`)

## Backwards-compat invariant gates
- `git diff main -- src/orchestrator/field-registry.ts` → empty ✓
- `agents` table schema literal unchanged ✓
- `agent_templates` + `topics` tables exist after fresh init ✓
- Persona file with no `persistent` field → continues to populate `agents` row identically (tested) ✓

## Open questions for follow-up
- Tighten the schema-equality test to compare types/defaults/nullability, not just column names.
- Warn (not silent-accept) on:
  - Ephemeral template with empty `topics: []`.
  - Conflicting `cwd` vs `cwd_base` on the same persona.
- Consider widening `isEphemeralTemplate` to accept additional YAML falsy spellings (`0`, `no`, `off`) if the project tightens YAML compliance later.
