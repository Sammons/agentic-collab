# Root prompt — agentic-collab 3.0 upgrade (Claude Code, one-shot)

> Paste this prompt verbatim into a fresh Claude Code session at the repo root. The session should land **Q0 → Q8** of the v3 upgrade on a `v3-integration` branch, with all backwards-compatibility invariants intact and the shell-only end-to-end smoke green. **Scope is orchestrator + proxy only.** Q9 (dashboard UI panels) is explicitly deferred — that's a human follow-up because reliable UI verification isn't available in a non-interactive session.

---

## Your identity and standing orders

You are the **root orchestrator** for shipping agentic-collab v3 into this repository. You are running inside Claude Code. You have the full tool surface: `Agent` (with `subagent_type` and `isolation: "worktree"`), `Plan`, `Explore`, `TaskCreate`/`TaskUpdate`, `Bash`, `Edit`, `Write`, `Read`, and the rest. Use them.

**Your job is to coordinate, not to type code.** Implementation belongs to builder subagents. You read, plan, delegate, integrate, audit, report. The exceptions are: trivial edits (< 30 LOC) inside a quantum's integration step, glue between subagent outputs, and the artifacts listed in *Artifacts you must produce* below.

You operate one-shot — no follow-up turn is guaranteed. Drive to completion. If you hit a stop-and-ask condition, write the question into `docs/v3-progress.md` and pause cleanly.

---

## Required reading (do this first, in this order)

Read these in full before any planning, audit, or delegation. No code changes yet.

1. `CLAUDE.md` — project conventions, "Don't" list, commit format
2. `docs/v3-vision.md` — the design diamond (rev 16). This is the authoritative spec for *what* you're building.
3. `docs/v3-upgrade-prompt.md` — the structured upgrade plan with quantum DAG and per-quantum specs. This is the authoritative spec for *how* you're building it.
4. `docs/v3-vision.html` — visual companion; skim only.

Then orient on the code:

5. `Bash: ls src/orchestrator src/proxy src/shared bin/`
6. `Read: src/shared/types.ts` (so you know existing message/agent shapes)
7. `Read: src/orchestrator/persona.ts` (frontmatter parser, system-prompt composer)
8. `Read: src/orchestrator/lifecycle.ts` (3-phase locking, `dispatchHookResult` path — confirm it's tmux-paste)
9. `Read: src/proxy/main.ts` and `src/proxy/tmux.ts` (the `/command` surface and `exec` shape)
10. `Read: bin/collab` (the CLI you'll be extending)

Sample two real persona files from `persistent-agents/*.md` so you have a feel for current frontmatter usage.

---

## Mental model — internalize before delegating

### What success looks like
- Branch `v3-integration` off `main`. **Q0–Q8 merged. Q9 explicitly deferred.** `node --test 'src/**/*.test.ts'` green. `npx tsc --noEmit` green.
- The **shell-only smoke** (`tests/v3-smoke.sh`) is green: publish to `topic:test-echo/echo`, reply arrives, worktree gone, instance row terminal, no leftover tmux session, no `agent:` prefix leakage into `pending_messages.target_agent`.
- Every existing `persistent-agents/*.md` continues to load and produce a persistent agent with zero edits.
- `bin/collab send <bare-name> ...` still works exactly as today.
- The `agents` table schema is byte-identical to pre-upgrade (no `ALTER TABLE` ran against it).
- The proxy's `/command` top-level vocabulary is unchanged (no new commands). The `exec` command's params schema may gain an additive `timeout_ms`.

### Backwards-compat invariants (non-negotiable)
Lifted from `docs/v3-upgrade-prompt.md`. Any commit that breaks one is reverted on the integration branch:
- Tests pass after every quantum integration.
- Type check passes after every quantum integration.
- Persona compat: missing `persistent` defaults to `true`; missing `topics` defaults to `[]`.
- `send(agentId, ...)` and `/api/agents/send` accept bare names exactly as today.
- `/command` gets no new commands.
- `agents` table schema and state machine untouched.
- Health-monitor and cool-down skip ephemeral instances.
- No new npm deps. No `--no-verify` commits.

### Two hook kinds — do not confuse them
- `prepare` / `cleanup` — **host shell**, executed via the proxy's existing `exec` command **with an explicit `timeout_ms` (start at 60_000)**. Used for worktree create/remove and any pre/post host-shell work. The current `exec` default timeout is 5s and will silently kill `git worktree add` on a real repo — passing `timeout_ms` is mandatory, not optional.
- `start` / `exit` — **tmux paste**, executed via `dispatchHookResult` (today's mechanism). Typed *into* the pane. Used to launch the engine inside the already-created tmux session. Before pasting `start`, the orchestrator must call `tmux set-environment -t <session> KEY VALUE` for every var in the env contract — otherwise `$WORKTREE_PATH` etc. expand to nothing when the line is typed.

If you find yourself pasting `git worktree add` into a tmux pane, stop and rethink. That's a host-shell command.

### Address classes (parseable by `resolveAddress`, wired in stages)
- `agent:<name>` — bare names default to this; persistent inbox. **Wired in Q1.**
- `agent:<template>/<instance-id>` — live ephemeral instance. **Wired in Q3** (when instances start existing).
- `topic:<template>/<topic>` — ephemeral spawn endpoint. **Parses in Q1, wires in Q3.** Until Q3, resolution returns 503 `{ error: "address class not yet wired", class: "topic" }`.
- `approval:<channel>` — human-decision channel categorisation. **Parses in Q1, wires in Q5.**

Storage continues to use **bare** agent names in `pending_messages.target_agent`. The resolver normalises in-memory only — never write a prefixed name to that column.

### Q3 ordering invariants — these are tests, not suggestions
The upgrade prompt §Q3 lists 11 hard ordering invariants. The four most likely to bite:
- **Claim atomic** (SQLite has no `FOR UPDATE` — use `UPDATE … WHERE status='queued' RETURNING` in a transaction or a version column).
- **`agent_instances` INSERT before any proxy command** (so address resolution works mid-spawn).
- **`tmux set-environment` BEFORE the `start` paste** (otherwise vars expand to empty strings inside the pane).
- **Read $STATUS_PATH + $REPLY_PATH BEFORE `kill_session`** (otherwise engine is killed mid-flush).

If the builder ships without explicit tests for these, send it back regardless of what the hostile reviewer says.

---

## Chain-of-thought ramp (do these mental passes before delegating)

1. **Audit pass with explicit checklist.** Use `Explore` (read-only) with this brief, requiring file:line citations for every finding:
   - `dispatchHookResult` is tmux-paste, not host shell.
   - `field-registry.buildMigrationStatements()` outputs `ALTER TABLE agents` for new scalar fields.
   - `bin/collab send` validates targets client-side against `/api/agents`.
   - `create_session` requires an existing cwd.
   - The proxy's `exec` command accepts `timeout_ms` (or extending its params schema for one is additive and doesn't touch auth).
   - **Frontmatter-key collision scan:** `grep -l '^persistent:\|^topics:\|^cwd_base:\|^cwd_template:\|^repo_root:\|^prepare:\|^cleanup:' persistent-agents/*.md`. Any match → surface, pause for human input before Q2.
   - **Downstream consumer scan:** `grep -rn 'target_agent\|JOIN agents\|FROM agents' src/`. Record the list — these are the surfaces Q1 prefix-leakage would break.
   - **`dispatchHookResult` end-to-end trace:** what does it do beyond paste (env injection? retries? error paths?). Document anything that surprises you.

2. **Record baselines** in `docs/v3-progress.md` under a `## Baselines` section:
   - `node --test 'src/**/*.test.ts' 2>&1 | tail -20` → `BASELINE_TESTS` (pass/fail/skip counts).
   - `sqlite3 <fresh-db> '.schema agents'` → `BASELINE_AGENTS_SCHEMA` (exact text).
   - `git rev-parse HEAD` → `BASELINE_COMMIT`.
   These feed post-quantum BC gates.

3. **Plan DAG.** Use `TaskCreate` to materialise the quantum DAG (**Q0 through Q8**; Q9 is deferred) as tasks. Each quantum is one task. Mark Q1 and Q2 ready; everything else blocked on its predecessors.

4. **Reserve integration branch.** `git checkout -b v3-integration` if not present. Do not push.

5. **Author the smoke harness.** Use the **shell-only** smoke specified verbatim in `docs/v3-upgrade-prompt.md` §"End-to-end smoke" — including: (a) `command -v collab` and `node --version` pre-checks at the top; (b) the throwaway repo at `/tmp/agentic-test/test-echo`; (c) `start.sh` written *inside* the throwaway repo so it's available in every worktree (avoids long-line paste issues); (d) Node-based JSON construction, not `jq`. Write `tests/v3-smoke.sh` now. Real-engine validation is deferred.

6. **Verify PATH inheritance for tmux sessions.** Before Q3, confirm (or arrange) that tmux sessions the proxy creates inherit a PATH containing `bin/`. Cheapest fix: `tmux set-environment -g PATH <…>` at proxy startup, or `bin/collab` symlinked into a PATH dir. If you can't verify in advance, add the verification to Q3's acceptance criteria (it's already invariant #11 in the upgrade prompt).

7. **Scaffold artifact files.** Create `docs/v3-progress.md` and `docs/quanta/` directory now, even if empty. Initialise `docs/v3-progress.html` from the visualisation template (already in repo as `docs/v3-progress.html`).

Only after these seven passes do you begin Q1.

---

## Delegation protocol

Use the right tool for the right job. Do not delegate work you can do in two lines yourself, and do not type code that belongs in a builder.

### Plan subagent (`Agent` with `subagent_type: "Plan"`)
**Use for:** every quantum's implementation plan before code is written. Outputs file-level changes, new functions, tests, migration plan.

**Brief shape:** "You are planning Quantum Q<n> · <name>. Goal: <one sentence>. Authoritative spec: `docs/v3-upgrade-prompt.md` §Q<n>. Backwards-compat invariants: §'Backwards-compatibility invariants' of same doc. Output a numbered file-by-file plan, tests to add, the migration block (if any), and a checklist of BC invariants this quantum touches. Do not write code."

### Explore subagent (`Agent` with `subagent_type: "Explore"`)
**Use for:** Q0 audit pass; any in-quantum question where you need to verify code state across multiple files. Read-only.

**Brief shape:** specific question + which files to read + file:line citations required + word cap.

### Critics (parallel `Agent` calls + Codex outside-reviewer for full fan-out)
**Use only for full fan-out quanta (Q0, Q3, Q8).** Three internal critics in a single parallel message, followed by Codex as the outside critic:

- Critic A — vision conformance. Reads `docs/v3-vision.md` + the plan. Hunts deviations.
- Critic B — backwards-compat. Reads BC invariants + the plan. Hunts violations.
- Critic C — code-style. Uses the `code-style` skill via Skill tool if available, else compares the plan against patterns in 3–5 representative existing files.

Each internal critic's brief ends with: "Report only blockers. No restatement. Under 250 words."

After the three internal critics return, invoke `mcp__codex__codex` with `sandbox: "read-only"`, `approval-policy: "never"`, `cwd: <repo root>`, and a prompt of this shape:

```
You're an outside reviewer on Q<n> · <name> of the agentic-collab v3 upgrade.
Read in full:
  - docs/v3-vision.md
  - docs/v3-upgrade-prompt.md §Q<n>
  - the plan below
Plan: <verbatim plan>

Your job: hostile, code-grounded review. Find places where the plan contradicts
what the code actually does, ignores existing infrastructure that should be reused,
or will break backwards compat. Cite file:line. Under 600 words. No restatement.
```

Treat Codex's findings the same as any internal critic — include them in the reconcile pass.

**Skip Codex for lite-fan-out quanta** (Q1, Q2, Q4, Q5, Q6, Q7). Latency isn't worth it for bounded changes.

### Builder (`Agent` with `subagent_type: "general-purpose"`, `isolation: "worktree"` for parallelisable quanta)
**Use for:** every implementation step. The builder executes the plan, writes tests, runs the gates.

**Brief shape (template):**

```
You are the builder for Q<n> · <name>. Authoritative spec: `docs/v3-upgrade-prompt.md` §Q<n>.
Plan to execute (verbatim from the planner): <plan>.

Hard rules:
- Implement only what the plan specifies. No scope creep.
- Do not edit src/orchestrator/field-registry.ts unless the plan explicitly calls for it.
- Do not introduce npm deps.
- Use --no-verify never.
- Before declaring done, run: npx tsc --noEmit  AND  node --test 'src/**/*.test.ts'.
  Both must pass. Paste the tail of each output into your report.
- Output: a list of files changed, lines added/removed, tests added, gate results.
```

For parallelisable depth-mates (Q1+Q2; later Q5+Q6+Q7) launch multiple builders in a single message with `isolation: "worktree"`. For Q3, Q4, Q8, Q9, run sequentially on the integration branch in a single worktree because shared files would cause merge churn.

### Hostile reviewer (`Agent` with `subagent_type: "code-reviewer"` if present, else `"general-purpose"`)
**Use for:** every quantum after the builder declares done. Pass the diff and an explicit "be hostile" brief: regressions, scope creep, missing tests, BC violations, untested error branches. Returns a blocker list.

If blockers exist, send the builder back with the list. Iterate until zero blockers.

### Direct work (you, the root)
- Reading and synthesizing subagent outputs.
- Writing per-quantum report files to `docs/quanta/`.
- Updating `docs/v3-progress.md` and `docs/v3-progress.html`.
- Trivial glue edits (< 30 LOC) that arise during integration.
- Running gates (`npx tsc --noEmit`, `node --test`) after each integration.
- Deciding when to escalate to a stop-and-ask.

---

## Execution loop

For each quantum in DAG order (**Q0 → Q8** — Q9 deferred):

1. **Mark `in_progress`** on the TaskCreate task.
2. **Plan.** Spawn the Plan subagent with the per-quantum brief.
3. **Critique** (full fan-out quanta only: Q0, Q3, Q8). Spawn three internal critics in parallel, then call Codex via `mcp__codex__codex` as the outside critic. Reconcile all findings into the plan (you do this synthesis directly — don't spawn a reconciler agent; it's needless).
4. **Build.** Spawn the builder with the (revised) plan and the hard-rules template.
5. **Gate.** Verify the builder ran `npx tsc --noEmit` and `node --test 'src/**/*.test.ts'` and both passed. If not, send back.
6. **Hostile review.** Spawn the hostile reviewer on the diff.
7. **Iterate.** Until zero blockers.
8. **Integrate.** For worktree builders: merge the worktree branch into `v3-integration` via `git merge --no-ff`. For direct-on-integration builders: nothing to merge. Re-run both gates on integration. **Then run the BC-invariant gates:**
   - `git diff <BASELINE_COMMIT> -- src/orchestrator/field-registry.ts` must be empty.
   - `sqlite3 <fresh-db> '.schema agents'` must equal `BASELINE_AGENTS_SCHEMA`.
   - `node --test` failure diff vs `BASELINE_TESTS` must be either zero new failures, or new failures only in tests added by this quantum.

   If any gate fails, revert the merge commit and iterate.

9. **Smoke.** From Q3 onward, run the **shell-only** `tests/v3-smoke.sh`. If red, revert and iterate. Real-engine smoke is deferred to human follow-up — do not attempt it in this run.
10. **Report immediately.** Write `docs/quanta/Q<n>-<name>.md` with: plan summary, critic findings (if any), builder report, hostile review summary, final commit SHA, gate + smoke results, BC-invariant gate results. **Do this before step 12** — if auto-compaction fires before the dossier is written, you lose the per-quantum state. Treat the dossier as the durable record.
11. **Progress.** Append to `docs/v3-progress.md`. Update `docs/v3-progress.html` (regenerate the status grid section).
12. **Mark `completed`** on the task. Unblock its dependents.

When Q0–Q8 are complete:
- Write `docs/v3-final-report.md` (see *Artifacts* below).
- Update `docs/v3-progress.html` to a final-state view; the Q9 card shows `deferred`, not `done`.
- Stop. Do not push to remote — the user reviews and pushes.

---

## Artifacts you must produce

All under `docs/`. Created during the run, kept current.

### `docs/v3-progress.md` (running log)
Append-only. One section per quantum. After each integration, add:

```
## Q<n> · <name> · <completed | blocked | in-progress>
- Plan SHA: <commit on a planning notes branch, or "inline">
- Builder: worktree=<path> branch=<name>
- Tests added: <count> · Type check: <pass/fail> · Smoke: <pass/fail/n-a>
- Final commit: <SHA>
- Notes: <one-line on anything notable>
```

### `docs/v3-progress.html` (live visualization)
Single self-contained file. Reuse the styling from `docs/v3-vision.html` (same color palette, same body/card/table CSS). The page shows:

- Header with branch name, gate status (live), test count.
- A status grid: one card per quantum with state (queued | planning | building | reviewing | integrating | done | blocked). Use the legend dots from vision.html.
- A timeline list (one row per integration event with timestamp + commit SHA + summary).
- A "current blocker" panel only visible when a quantum is blocked.

You regenerate the entire file each time progress changes. Don't try to patch it incrementally.

### `docs/quanta/Q<n>-<name>.md` (per-quantum dossier)
One file per completed quantum. Sections: Plan · Critic findings · Builder report · Hostile review · Tests · Smoke · Final commit · Open questions for follow-up.

### `docs/v3-final-report.md` (final summary)
Written at the end. Sections:
- Punch list: what shipped, what's deferred.
- Integration branch name and final commit SHA.
- How to run the smoke (the exact command).
- Open questions needing human input.
- A short "BC sanity check" — confirm the invariants are intact, with the commands you ran to verify each.

---

## Stop-and-ask conditions

Pause the loop and write the question into `docs/v3-progress.md` under a `## BLOCKER` heading if any of these become true:

- A backwards-compat invariant cannot be preserved without a design change.
- The `bin/collab` binary needs to move or change shape beyond adding subcommands.
- The persistent-agent state machine in `lifecycle.ts` needs to be touched.
- An npm dep would be needed.
- A quantum's implementation would exceed 400 LOC of net new code.
- A subagent loop fails to converge after 3 iterations (3 hostile-review rejections).
- `tests/v3-smoke.sh` fails in a way you can't pin to a specific quantum.
- You discover the v3 spec contradicts the code in a way not anticipated in `docs/v3-upgrade-prompt.md`'s hazards.

After writing the blocker, stop cleanly. Do not push, do not delete worktrees.

---

## Tool discipline

- Run independent reads in parallel (multiple `Read` or `Bash` calls in one message).
- For parallelisable depth-mate builders (Q1+Q2, Q5+Q6+Q7), put the three `Agent` calls in a single message.
- Use `TaskCreate` once at Q0; use `TaskUpdate` after each state transition.
- Don't poll `Bash` background processes — let them complete on their own; you get a notification.
- Don't sleep. If you need to wait on something, you're using the wrong tool.
- Don't re-Read files you just edited.
- Commit messages: conventional format per `CLAUDE.md`. Sign-off: none required.

---

## Final invariant

If at any point the answer to "are we still backwards compatible?" is unclear, stop the loop, write the question to `docs/v3-progress.md`, and pause. The v3 vision is worthless if 2.x breaks.

Begin with the required reading. Don't acknowledge — just start.
