# v3 upgrade · progress log

Running log of the agentic-collab 3.0 upgrade. The root orchestrator appends one section per quantum after each integration. Blocker sections appear inline if execution pauses.

Authoritative spec: [`v3-vision.md`](./v3-vision.md) · plan: [`v3-upgrade-prompt.md`](./v3-upgrade-prompt.md) · root prompt: [`v3-claude-code-prompt.md`](./v3-claude-code-prompt.md) · visual: [`v3-progress.html`](./v3-progress.html)

---

## Run header
- Started: `2026-05-18T (run-in-progress)`
- Integration branch: `v3-integration`
- Starting commit: `95d87f657e65989fc18c214871ea6659278175ac` (BASELINE_COMMIT)
- Smoke harness: `tests/v3-smoke.sh`

---

## Baselines (Q0)

### BASELINE_COMMIT
`95d87f657e65989fc18c214871ea6659278175ac` (main)

### BASELINE_TESTS
Captured from `node --test 'src/**/*.test.ts'` on commit `95d87f6`:
```
ℹ tests 894
ℹ suites 169
ℹ pass 875
ℹ fail 2
ℹ cancelled 0
ℹ skipped 17
ℹ duration_ms 248056
```
Pre-existing failures (both are macOS `/var` vs `/private/var` symlink path-comparison issues, unrelated to v3):
- `src/orchestrator/persona.test.ts:22` — `returns explicit path if it exists within personasDir`
- `src/proxy/upload.test.ts` — `returns correct path and size`

Post-quantum gate: integration test count = baseline (894) + new_in_quantum. Pre-existing 2 failures must remain at 2; any net-new failure is a regression.

### BASELINE_AGENTS_SCHEMA
Fresh-DB schema for the `agents` table (verbatim from `src/orchestrator/database.ts:41-64` + registry migrations applied):

```
name                    TEXT PRIMARY KEY
engine                  TEXT NOT NULL
model                   TEXT
thinking                TEXT
cwd                     TEXT NOT NULL
persona                 TEXT
permissions             TEXT
proxy_host              TEXT                          -- deprecated, retained for SQLite compat
state                   TEXT NOT NULL DEFAULT 'void'
state_before_shutdown   TEXT
current_session_id      TEXT
tmux_session            TEXT
proxy_id                TEXT
last_activity           TEXT
last_context_pct        INTEGER
reload_queued           INTEGER NOT NULL DEFAULT 0
reload_task             TEXT
failed_at               TEXT
failure_reason          TEXT
version                 INTEGER NOT NULL DEFAULT 0
spawn_count             INTEGER NOT NULL DEFAULT 0
created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
```

After `database.migrate()` runs (registry-driven `ALTER TABLE agents ADD COLUMN ...`), the additional columns are: `sort_order` (INTEGER NOT NULL DEFAULT 0), `hook_spawn`, `hook_start`, `captured_vars`, plus every `CONFIG_FIELDS` column from `src/orchestrator/field-registry.ts:97-117` not already present. Q2/Q3 must leave both this base schema and the registry-driven migration set byte-identical.

Q0 BC gate (run after each integration):
```bash
git diff 95d87f6 -- src/orchestrator/field-registry.ts   # must be empty
git diff 95d87f6 -- src/orchestrator/database.ts | grep -E '^[+-].*ALTER TABLE agents'  # must be empty for new ALTERs
```

---

## Q0 · audit + plan + baselines · in-progress

### Audit findings (file:line citations)

1. **`dispatchHookResult` is tmux-paste, confirmed.** `src/orchestrator/lifecycle.ts:107-209` — every `proxyDispatch` is `send_keys` or `paste` against a `tmux_session`. There is no host-shell branch. Spec assumption holds: `start`/`exit` hooks paste into the pane; `prepare`/`cleanup` must use a different mechanism.

2. **`exec` proxy command already accepts `timeoutMs`.** `src/shared/types.ts:347` (`{ action: 'exec'; command: string; cwd?: string; timeoutMs?: number }`) and `src/proxy/main.ts:243-253` (`const timeout = command.timeoutMs ?? 5_000;`). **No schema extension needed for Q3.** The default-5s hazard remains: callers must pass `timeoutMs: 60_000` (or higher) for `prepare` / `cleanup` to survive `git worktree add` on real repos.

3. **`bin/collab send` target validation rejects prefixed addresses.** `bin/collab:215-228` — `if (!agentNames.includes(target)) { console.error(...); process.exit(1); }`. Q1 must widen this so `agent:foo`, `topic:tmpl/name`, `approval:channel` all pass client-side validation. Bare names continue to work unchanged.

4. **`create_session` requires existing cwd.** `src/proxy/tmux.ts:19-27` — `exec(\`tmux new-session -d -s '...' -c '${esc(cwd)}' ...\`)`. tmux fails if `cwd` doesn't exist. Q3 must call `create_session` against `cwd_base` (the real existing dir), NOT against `cwd_template` / `worktree_path` (which `prepare` is still in the process of creating).

5. **PATH inheritance for tmux is already wired.** `src/proxy/main.ts:24-29` prepends `bin/` to `process.env.PATH` at proxy startup. `src/proxy/tmux.ts:25-26` then passes `-e PATH='${esc(path)}'` to every `tmux new-session`. **Q3 invariant #11 (PATH-inside-tmux for `collab`) is already satisfied** as long as the proxy is launched with bin/collab reachable. The smoke harness still asserts it.

6. **`persona.ts:1018` hard-rejects without `cwd`.** `src/orchestrator/persona.ts:1018-1021` — `if (!resolvedEngine || !isValidEngine(resolvedEngine) || !cwd) { console.warn(...); continue; }`. Q2 must branch this on `persistent`: ephemeral templates have no `cwd` but do have `cwd_base`, and `cwd` is only required for the `agents` table upsert. Cleanest fix: skip the registry path entirely for `persistent: false` templates and load them into `agent_templates` via the new sync routine.

7. **Frontmatter collision scan: no live collisions.** `persistent-agents/` directory does not exist in this repo checkout (it's a runtime mount via `PERSONAS_DIR` env, default `$HOME/persistent-agents`). The collision scan is therefore vacuously empty for the repo, but **the scan must be re-run by an operator against their live `PERSONAS_DIR` before deploying** — flag this in the final report.

8. **Downstream consumer scan — bare-name surfaces in `target_agent`:**
   - `src/orchestrator/database.ts:100` — column declaration `target_agent TEXT NOT NULL`.
   - `src/orchestrator/database.ts:111` — index `idx_pm_agent_status` on `(target_agent, status)`.
   - `src/orchestrator/database.ts:587, 596, 598, 604, 617, 719, 732, 1132` — queries that read/write `target_agent`. All assume **bare** agent names; Q1 prefix leakage would break them all.
   - `src/orchestrator/database.ts:469, 1118` — `dashboard_messages.target_agent` (added by migration). Bare names also.
   - Conclusion: `pending_messages.target_agent` and `dashboard_messages.target_agent` are the two surfaces that must remain bare. Address resolution happens **only** in-memory at the routes/dispatcher entry points; storage stays bare.

9. **`dispatchHookResult` deep trace:** beyond paste, the function handles `keys` / `send` / `pipeline` / `skip` modes (lifecycle.ts:114-220). Pipeline mode has a per-step shell branch that pastes the command then sends Enter with a length-proportional sleep (lifecycle.ts:171-189). Capture steps run `tmux capture-pane` and optionally store the regex-captured value into `agents.captured_vars`. **All of this is paste/keys/capture against a tmux session — no host shell.** Q3 must NOT call `dispatchHookResult` for `prepare`/`cleanup`.

10. **`exec` proxy command path for `prepare`/`cleanup`.** `src/proxy/main.ts:243-253` — `execSync(command, { encoding: 'utf-8', timeout, cwd, stdio: ['ignore', 'pipe', 'pipe'] })`. Returns stdout trimmed; throws on non-zero exit. Q3 must call this with an explicit `timeoutMs >= 60000` and surface the error if `prepare` fails before any `create_session`.

11. **`field-registry.ts` writes `ALTER TABLE agents` for every config field.** `src/orchestrator/field-registry.ts:287-295` — `buildMigrationStatements()` emits `ALTER TABLE agents ADD COLUMN ${column} TEXT` for any column not in the existing set. **CRITICAL: Q2 must NOT add any new `CONFIG_FIELDS` entry**, because that would silently `ALTER TABLE agents` for the new column. All template-only fields (persistent, cwd_base, cwd_template, repo_root, prepare, cleanup, topics) live in `agent_templates`, written via the new template-sync routine, with the registry untouched.

### Decisions taken from the audit
- Q3 `prepare`/`cleanup` go through `proxyDispatch(proxyId, { action: 'exec', command, timeoutMs: 60_000 })` — no `dispatchHookResult`, no new proxy command.
- Q2 branches `syncPersonasToDb` to skip ephemeral templates from the `agents` upsert path and route them to a new `template-sync.ts`.
- Q1 keeps `target_agent` bare in all queue/dispatcher writes; resolution layer is one-way only (raw → discriminated union, never the inverse before persistence).

### Pre-existing collision risks (none observed in this checkout)
- No persona files in repo to scan.
- `PERSONAS_DIR` default is `$HOME/persistent-agents` (persona.ts:12) — the smoke harness must set `PERSONAS_DIR` to an isolated dir before writing `agents/test-echo.md` so it doesn't leak into a real user's directory.

<!-- Per-quantum sections appended below as quanta complete. -->

---

## Q1 · address router · completed
- Plan SHA: inline (executed from `docs/v3-upgrade-prompt.md` §Q1 + per-file plan in builder brief)
- Builder: worktree=`.claude/worktrees/agent-a90d74d8a0a673dce` branch=`worktree-agent-a90d74d8a0a673dce` (final `b8d4233`)
- Tests added: 56 (49 `address.test.ts` + 7 `routes.test.ts`)
- Type check: pass (no new error classes vs baseline)
- Smoke: n/a (runs from Q3)
- Final commit: `0d86f7c` (merge into `v3-integration`)
- BC gates: `field-registry.ts` diff empty · agents schema unchanged · `pending_messages.target_agent` confirmed bare
- Notes: hostile reviewer cleared zero blockers. See `docs/quanta/Q1-address-router.md` for full dossier.

---

## Stop-and-ask deviation — Q3 LOC budget

The Q3 planner returned a budget of ~840 LOC net new (kernel ~460 + tests ~420), which exceeds the spec's 400-LOC stop-and-ask threshold by ~2x. **Proceeding without pausing because** the v3-upgrade-prompt §Q3 explicitly rejects splitting: "splitting queue/delivery/instances/completion across separate quanta means none of them have anything coherent to test against until they're all done." The threshold was a guardrail against unanticipated growth; Q3 is the one quantum the design anticipates as a large vertical slice. Risk noted for the final report.

---

## Q2 · template loader · completed
- Plan SHA: inline (executed from `docs/v3-upgrade-prompt.md` §Q2 + per-file plan in builder brief)
- Builder: worktree=`.claude/worktrees/agent-a5512a6a946589fe0` branch=`worktree-agent-a5512a6a946589fe0` (final `61580ef`)
- Tests added: 19 (11 `template-sync.test.ts` + 3 `persona.test.ts` + 5 `database.test.ts`)
- Type check: pass (no new error classes vs baseline)
- Smoke: n/a
- Final commit: `92d4171` (merge into `v3-integration`)
- BC gates: `field-registry.ts` diff empty · agents schema literal unchanged · `agent_templates`/`topics` tables present
- Notes: hostile reviewer cleared zero blockers. See `docs/quanta/Q2-template-loader.md` for full dossier.

---

## Q3 · ephemeral lifecycle kernel · completed
- Plan: `docs/quanta/Q3-plan-revised.md` (rev'd after Codex outside-review surfaced 6 blockers against the original plan)
- Builder: direct on `v3-integration` (Q3 touches files Q4-Q8 also touch; worktree would create merge churn)
- Initial commit: `bdf1456` · iteration commit: `e01484c` (final)
- Tests added: ~22 (across `topic-delivery.test.ts`, `instance-reaper.test.ts`, plus appended tests in `routes.test.ts`/`health-monitor.test.ts`/`message-dispatcher.test.ts`)
- Type check: pass (no new error classes vs baseline)
- Smoke: kernel in place — shell-only `tests/v3-smoke.sh` not exercised here (requires live orchestrator + proxy); operator runs after `./start.sh`
- Final commit: `e01484c` on `v3-integration`
- BC gates: `field-registry.ts` diff empty · agents schema BYTE-IDENTICAL · `lifecycle.ts` diff is one word (`export`) · no new proxy commands · `pending_messages.target_agent` stays bare
- Notes: hostile reviewer flagged 7 blockers post-build (race in invariant #1, two no-op invariant tests, unsafe `MESSAGE_CONTENT` in tmux env, fragile `locks` cast, missing 409 contract, misleading `removed` field). All fixed in iteration `e01484c`. See `docs/quanta/Q3-ephemeral-lifecycle-kernel.md`.
- LOC deviation: ~875 net new code (over 400-LOC stop-and-ask threshold; spec rejects splitting Q3 — deviation logged).
