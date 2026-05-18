# agentic-collab 3.0 — upgrade prompt

**Input for a single comprehensive execution** that ships the v3 vision into the current codebase while preserving 2.x behaviour. Designed for a top-level orchestrator that fans out adversarial builder/critic sub-agent pairs across a quantum DAG.

---

## Mission

Upgrade `/Users/sammons/Desktop/agentic-collab` to v3 per `docs/v3-vision.md`. The end state:
- Persistent agents (today's `persistent-agents/*.md`) keep working with zero edits, defaulting to `persistent: true`.
- New ephemeral-agent topic delivery exists end-to-end: a `send` to `topic:<template>/<name>` writes a payload to disk, creates a worktree + tmux session, dispatches the template's `start` hook, waits for the agent to signal via `collab complete`, routes the reply, dispatches the `exit` hook, tears down.
- Approvals are first-class CRUD resources with auto-notify on state change.
- Monitor sidecars are paired with workers via the same hook machinery.
- The proxy gets **no new commands**.
- All 2.x tests pass; new tests cover the new surface area.
- `npx tsc --noEmit` clean throughout.

This is a one-shot execution. Plan thoroughly before any code is written, then run quanta in dependency order, fanning out builder/critic pairs per quantum.

---

## Required reading (do this first)

Read in full:
- `CLAUDE.md` — project conventions, "Don't" list
- `docs/v3-vision.md` — the design diamond (rev 15)
- `docs/v3-vision.html` — visual companion

Skim with grep/Explore:
- `src/orchestrator/{main,routes,lifecycle,database,persona,field-registry,message-dispatcher,health-monitor,reminder-dispatcher}.ts`
- `src/orchestrator/adapters/*.ts`
- `src/proxy/{main,tmux}.ts`
- `src/shared/types.ts`, `src/shared/websocket-server.ts`
- A handful of `persistent-agents/*.md` to internalise current frontmatter

---

## Chain-of-thought preamble (no code yet)

Before any quantum executes, the orchestrator must:

1. **Verify the design against current code** with a specific audit checklist (use the Explore subagent; cite file:line for every finding):
   - Confirm `lifecycle.ts` 3-phase locking shape and that `dispatchHookResult` is tmux-paste (not host shell).
   - Confirm `persona.ts` nested-field set and the `cwd`-required check around persona.ts:1017.
   - Confirm proxy `/command` surface; confirm `exec` either accepts `timeout_ms` or its params schema is straightforwardly extensible (additive, no auth changes).
   - Confirm there's no existing worktree code anywhere.
   - **Frontmatter-key collision scan.** `grep -l '^persistent:\|^topics:\|^cwd_base:\|^cwd_template:\|^repo_root:\|^prepare:\|^cleanup:' persistent-agents/*.md` — surface any pre-existing uses of those keys. If any exist, pause for human input before Q2.
   - **Downstream consumer scan.** `grep -rn 'target_agent\|JOIN agents\|FROM agents' src/` — surface any code that joins against the `agents` table or reads `pending_messages.target_agent` in ways that would care about prefix leakage. Document the list.
   - **dispatchHookResult end-to-end read.** Trace what it does beyond the obvious paste — env var injection, retries, error handling — and document anything that surprises you.
   If any audit finding contradicts the v3 spec, surface the conflict and pause for human input.

2. **Record baselines** (one shot, kept for later comparison):
   - `node --test 'src/**/*.test.ts' 2>&1 | tail -20` → record the pass/fail/skip counts as `BASELINE_TESTS` in `docs/v3-progress.md`.
   - `sqlite3 <db-path> '.schema agents'` (against a freshly-initialised DB) → store the exact schema text as `BASELINE_AGENTS_SCHEMA` in `docs/v3-progress.md`.
   - `git rev-parse HEAD` → record as `BASELINE_COMMIT`.
   These baselines feed BC invariant gates throughout the run.

3. **Build the quantum dependency graph** (below) into a concrete TaskCreate-backed plan. Each quantum is a task; quanta with the same depth in the DAG are eligible for parallel execution.

4. **Pin backwards-compatibility invariants** (next section). These are not goals; they are gates. Any quantum that violates them is rejected at hostile review.

5. **Reserve a v3 integration branch** off `main` (e.g. `v3-integration`) via worktree. Each quantum executes in its own child worktree and merges back into v3-integration after review. No quantum touches `main` directly.

6. **Author an end-to-end smoke scenario** before any builder runs — the smoke is the existence test for the integration. See "End-to-end smoke" below. Builders may not declare done until their quantum is exercised by the smoke (or until the smoke is updated to cover them).

Use the Plan subagent for the planning pass; use Explore for the audit pass; both can run in parallel.

---

## Backwards-compatibility invariants (hard gates)

These hold continuously throughout the upgrade. Any commit that breaks one is reverted.

- **Test suite stays green.** `node --test 'src/**/*.test.ts'` passes after every quantum integration. No test deletions; only additions and additive modifications.
- **Type check stays green.** `npx tsc --noEmit` after every quantum integration.
- **Persona compat.** Every existing `persistent-agents/*.md` continues to load and produces a persistent agent. Defaults: `persistent: true` when the field is absent; `topics: []` when absent. The directory name `persistent-agents/` continues to be supported; `agents/` is accepted as an alias if added but no rename is required.
- **API compat.** `send(agentId, …)` and the existing `/api/agents/send` and `/api/dashboard/send` endpoints accept bare agent names exactly as today. An internal resolver layers `agent:` / `topic:` prefixes on top — never breaks the bare form.
- **Proxy compat.** `/command` gains zero new commands. Ephemeral lifecycle uses existing commands (`create_session`, `exec`, `paste`, `kill_session`, etc.).
- **Agents table compat.** `agents` schema and state machine are untouched. Ephemeral state lives in new `agent_instances`.
- **Health monitor + cool-down compat.** They keep operating on persistent agents only — they are explicitly skipped for ephemeral instances. No reuse, no shared timers.
- **No new npm deps.** Zero-dep design constraint per CLAUDE.md.
- **No `--no-verify` commits.** Hooks must pass.

---

## Quantum DAG

**Scope for this one-shot: orchestrator and proxy only.** UI/dashboard work (the `templates & topics` tree and `approval inbox` panels in `src/dashboard/index.html`) is **deferred** to a human follow-up. The WebSocket event contract (Q4) is still in scope because the kernel and approvals emit those events; the consumer-side rendering is the deferred piece.

```
                 ┌────────────────────────────┐
                 │  Q0 · audit + plan         │ ← CoT preamble (no code)
                 └─────────────┬──────────────┘
                 ┌─────────────┴──────────────┐
                 ▼                            ▼
         ┌──────────────┐             ┌──────────────┐
         │ Q1 address   │             │ Q2 template  │
         │   router     │             │   loader     │
         └──────┬───────┘             └──────┬───────┘
                └─────────────┬──────────────┘
                              ▼
                ┌─────────────────────────────────┐
                │ Q3 · ephemeral lifecycle kernel │
                │   queue · delivery · worktree   │
                │   prepare/start/cleanup · IPC   │
                │   instances · reaper · complete │
                │   → end-to-end smoke green      │
                └────────────────┬────────────────┘
                                 ▼
                       ┌──────────────────┐
                       │ Q4 · WS event    │
                       │   contract       │
                       └────────┬─────────┘
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
       ┌────────────┐    ┌────────────┐     ┌────────────┐
       │ Q5         │    │ Q6 monitor │     │ Q7 CLI     │
       │ approvals  │    │   sidecar  │     │ mode-aware │
       └─────┬──────┘    └─────┬──────┘     └─────┬──────┘
             └─────────────┬───┴──────────────────┘
                           ▼
                  ┌──────────────────┐
                  │ Q8 crash recovery│
                  └──────────────────┘

                  ─── deferred to human ───
                  Q9 dashboard panels (UI)
```

Parallelisable depths: {Q1, Q2} · {Q5, Q6, Q7} · everything else sequential. Q3 is intentionally a single vertical slice — splitting queue/delivery/instances/completion across separate quanta means none of them have anything coherent to test against until they're all done.

---

## Quantum specs

Each quantum has the structure: **goal · key files · hazards · acceptance · adversarial focus**.

### Q1 · address router

**Goal.** Introduce `agent:`, `topic:`, and `approval:` address parsing. Provide a single internal `resolveAddress(raw)` returning a discriminated union. Wire existing send endpoints through it; bare names default to `agent:`. Update `bin/collab`'s client-side target check (see bin/collab:215, :220) so it stops rejecting prefixed addresses against the bare-name `/api/agents` list.

**Staging — wire only `agent:`/bare here.** `topic:` and `approval:` must *parse* (so the parser is fully tested) but resolution returns a 503 with body `{ error: "address class not yet wired", class: "topic" | "approval" }` until later quanta land them (Q3 wires `topic:`, Q5 wires `approval:`). Do not attempt to do those wirings here.

**Key files.** `src/shared/types.ts` (new `Address` type), new `src/shared/address.ts`, `src/orchestrator/routes.ts` (existing send routes — wrap, don't replace), `src/orchestrator/message-dispatcher.ts`, `bin/collab` (lift the target-validity check).

**Hazards.** Bare-name compatibility is sacred — `send(agentId, ...)` and `/api/agents/send` keep working. `pending_messages.target_agent` continues to store **bare** agent names; conversion happens in the resolver, in-memory only, never at storage time. Don't change the column shape or the existing rows.

**Acceptance.** Tests cover: bare name → `agent:` resolution; explicit `agent:foo` → same; `agent:tmpl/inst-id` parses but resolution returns "no such instance" until Q3; `topic:tmpl/name` parses; `approval:channel` parses; malformed addresses return structured errors; `bin/collab send topic:foo/bar --payload '{}'` is not rejected client-side.

**Adversarial focus.** Silent acceptance of garbage strings; case sensitivity; ambiguous parses (`agent:foo/bar` vs literal slash in name); dashboards still showing bare names everywhere; reminder/retry paths un-affected.

### Q2 · template loader

**Goal.** Extend `persona.ts` to load `persistent`, `cwd_base`, `cwd_template`, `repo_root`, `prepare`, `cleanup`, and `topics: [...]` from frontmatter. Populate new `agent_templates` and `topics` tables via a **new template-sync routine** — **never** via `field-registry.buildUpsertOptsFromFrontmatter`.

**Key files.** `src/orchestrator/persona.ts` (parsing + nested-key registration), `src/orchestrator/database.ts` (migration creating `agent_templates`, `topics`), new `src/orchestrator/template-sync.ts`. **`field-registry.ts` must not be edited.**

**Hazards.**
- `topics` is an array of objects — follow the `custom_buttons` / `indicators` precedent (persona.ts ~line 141): parse separately, write via the new sync routine.
- Today's sync rejects files without `cwd` (persona.ts:1017). The new fields must not get caught by that check — ephemeral templates won't have a `cwd`. Either branch the check on `persistent`, or skip the registry path entirely for templates marked `persistent: false`.
- Migration must be idempotent. **No** `ALTER TABLE agents`; only `CREATE TABLE IF NOT EXISTS` for the two new tables.
- Existing persona files load unchanged with `persistent: true` defaulted, zero topics, all new fields null.

**Acceptance.** Tests cover: existing persona file → persistent template, agents-table behaviour unchanged; persona with `persistent: false` + topics + prepare + cleanup + cwd_base → ephemeral template with parsed topics in `agent_templates`/`topics`; reload updates topics correctly; malformed topic entries error clearly; `field-registry.buildMigrationStatements()` output for the agents table is identical before and after this quantum.

**Post-integration BC gates (run after Q2 lands, before Q3 starts):**
- `git diff <BASELINE_COMMIT> -- src/orchestrator/field-registry.ts` must be empty.
- `sqlite3 <db> '.schema agents'` against a fresh DB must equal `BASELINE_AGENTS_SCHEMA` from Q0.
- `node --test 'src/**/*.test.ts'` pass/fail count diff vs `BASELINE_TESTS` is either zero new failures, or any new failures are demonstrably in new tests added by Q2 (not pre-existing).

If any gate fails, revert the Q2 merge commit.

**Adversarial focus.** Schema migration on a live DB; `persistent: false` with empty topics (legal but warn); leakage of new fields into the agents table via `buildUpsertOptsFromFrontmatter`; existing persona files that happen to use a key named `persistent` or `topics` for unrelated reasons.

### Q3 · ephemeral lifecycle kernel (the big one)

**Goal.** One vertical slice that takes a `topic:` send all the way through to a reply. Everything queue/delivery/worktree/instance/completion lives here, ending green on the end-to-end smoke.

In this quantum, build:

- **Topic queue** — new `topic_queue` table, claim semantics, single-consumer per topic (`concurrency: 1`).
- **Publish endpoint** — new `POST /api/topics/publish` plus address-resolver integration so `/api/agents/send` with a `topic:` address forwards here.
- **Delivery sequence** (v3-vision.md §4): allocate IPC files → run `prepare` via proxy `exec` → `create_session` against `cwd_base` → tmux `set-environment` for the env contract → paste `start` hook → record instance.
- **`agent_instances` table + reaper** — separate from `agents`. Reaper polls (~1–2s configurable) for `$STATUS_PATH` presence and finalises.
- **`collab complete` / `fail` subcommands** — in `bin/collab`. Atomic file writes (tmp + rename). POST `/api/instances/:id/complete` as low-latency wake; reaper is the fallback. Idempotent (second call no-ops).
- **Reply routing** — on completion, read `$STATUS_PATH` + `$REPLY_PATH`, send to `REPLY_TO_ADDR` via the existing dispatcher with `in_reply_to=MESSAGE_ID`. Then proxy `kill_session`, then run `cleanup` via proxy `exec`.
- **Health-monitor + cool-down exclusion** — both explicitly skip rows in `agent_instances`.

**Key files.** `src/orchestrator/database.ts` (migration: `topic_queue` + `agent_instances`), new `src/orchestrator/topic-delivery.ts`, new `src/orchestrator/instance-reaper.ts`, `src/orchestrator/routes.ts` (publish + completion endpoints), `src/orchestrator/lifecycle.ts` (reuse `dispatchHookResult` only for the tmux-paste `start` — `prepare`/`cleanup` go directly through the `exec` proxy command), `bin/collab` (subcommands), `src/orchestrator/health-monitor.ts` and `src/orchestrator/message-dispatcher.ts` (exclusion filters).

**Hazards.**
- **`prepare`/`cleanup` are host shell, not tmux paste.** Use the proxy's existing `exec` command. The current `exec` default timeout is 5s and **will silently kill `git worktree add` on real repos.** Always pass an explicit `timeout_ms` (start at 60_000) via the `exec` command. If the proxy's `ProxyExecCommand` schema doesn't already accept it, extend the schema (still no new top-level command). Do **not** invoke `dispatchHookResult` for these — that's the paste path.
- `create_session` requires an existing directory (`tmux.ts:26`). Always use `cwd_base` — never the not-yet-created worktree path.
- `start` is tmux paste — set env via `tmux set-environment` on the session **before** paste, so `$WORKTREE_PATH` etc. expand when the line is typed.
- Single-consumer per topic: implement claim via `UPDATE … WHERE status='queued' AND claimed_by_instance IS NULL` with a sentinel. Two simultaneous publishes on a `concurrency: 1` topic must serialise.
- `agent_instances` row must exist before `start` is pasted (so address resolution for `agent:<template>/<instance-id>` works immediately).
- Status file atomic write (tmp + rename) on the agent side; reaper must tolerate "exists but empty" as in-progress.
- Reply routing through the dispatcher must use the bare requester address (no prefix leakage into `pending_messages`).

**Hard ordering invariants (not just suggestions — assert in tests):**

1. **Claim is atomic on SQLite.** Use a transaction with `UPDATE topic_queue SET status='claimed', claimed_by_instance=? WHERE id=? AND status='queued' RETURNING *` (or equivalent with a version column). Test: two concurrent publishes on `concurrency: 1` → exactly one row claimed, exactly one instance spawned.
2. **`agent_instances` INSERT happens in the same transaction as the claim, before any proxy command.** Address resolver must find `agent:<template>/<inst-id>` as soon as the claim completes. Test: publish, immediately resolve the instance address — succeeds.
3. **Proxy command sequence is exactly:** `prepare-via-exec (with timeout_ms ≥ 60000)` → `create_session against cwd_base` → `tmux set-environment × N` → `paste(start)`. Test: mock the proxy dispatch, capture the command sequence, assert the order.
4. **Set-environment commands precede paste, no exceptions.** Test: assert every `tmux set-environment` command is dispatched before the first `paste` command in a single instance's lifecycle.
5. **Reaper reads $STATUS_PATH and $REPLY_PATH BEFORE `kill_session`.** Otherwise the engine may be killed mid-flush. Test: trip the reaper with a controlled instance, assert read happens first.
6. **`kill_session` precedes `cleanup`.** Don't remove the worktree while the engine still has files open in it. Test: assert command order on completion path.
7. **`collab complete` is idempotent.** Second call returns HTTP 409 (or equivalent); only one reply message lands. Test: call twice, assert only one row in `pending_messages` for the reply.
8. **Health-monitor and message-dispatcher cool-down queries exclude `agent_instances`.** Test: insert an `agent_instances` row, run the health-monitor query, assert the row is not returned. Same for cool-down.
9. **`pending_messages.target_agent` stores bare names only.** Run the smoke, then query `SELECT count(*) FROM pending_messages WHERE target_agent LIKE '%:%'` — must be 0.
10. **Mid-run address paste works.** Smoke skips this path. Direct unit test: spawn an ephemeral instance, `send(agent:<template>/<inst-id>, msg)`, assert the dispatcher's `paste` command targets the right tmux session.
11. **PATH-inside-tmux works for `collab`.** Test (inside the smoke setup): create a tmux session via the proxy, `send_keys 'which collab\n'`, capture pane after 200ms, assert non-empty result. If empty, document the PATH-inheritance fix the orchestrator must apply at session creation.

**Acceptance.** End-to-end smoke (see "End-to-end smoke" below) passes from a green checkout, AND all 11 invariants above have passing tests, AND post-quantum test pass/fail count diff vs `BASELINE_TESTS` shows no new pre-existing failures.

**Adversarial focus.** Two messages on a `concurrency: 1` topic at the same instant. `prepare` succeeds but `create_session` fails (worktree leaked). `start` paste lost (engine never launches). Status file partially written. Reaper missed-tick under load. Instance-id collisions across restarts. Reply payload size > HTTP limit (CLI must still finalise via reaper). Worktree path with shell-special characters. `cwd_base` doesn't exist on the proxy host.

### Q4 · WebSocket event contract

**Goal.** Extend `WsEvent` (types.ts:274) with the new event types so downstream UI can subscribe. Add emission points from Q3's kernel.

**Key files.** `src/shared/types.ts`, `src/shared/websocket-server.ts`, `src/orchestrator/topic-delivery.ts`, `src/orchestrator/instance-reaper.ts`, `src/orchestrator/template-sync.ts`.

**New events.**
- `template-updated` — template added/modified/removed via reload (payload: template id, action).
- `topic-queue-changed` — queue depth changed (payload: agent_template, topic, depth).
- `instance-spawned` / `instance-completed` / `instance-failed` — ephemeral instance lifecycle (payload: instance row).
- `approval-changed` — placeholder, wired by Q5.

**Hazards.** Existing `WsEvent` consumers (dashboard) must not break on new unknown types — discriminated-union exhaustiveness in TS may flag this; widen the type carefully.

**Acceptance.** Tests cover: each event is emitted at the documented orchestrator point; existing dashboard subscribers ignore unknown events without erroring; type-check passes.

**Adversarial focus.** Stale subscribers; event flood under high topic throughput; missing emissions when paths take an error branch.

### Q5 · approvals CRUD + auto-notify

**Goal.** New `approvals` table, REST endpoints, CLI subcommands (`create --channel`, `get`, `set`, `withdraw`, `await`), and orchestrator logic that auto-sends a notification message to the requester's address on state change. Emits `approval-changed` ws events.

**Key files.** `src/orchestrator/database.ts`, new `src/orchestrator/approvals.ts`, `src/orchestrator/routes.ts`, `src/orchestrator/message-dispatcher.ts` (notification dispatch), `bin/collab`.

**Hazards.**
- **Use `approval:<channel>` consistently.** This is a categorisation, not a routing topic. CLI takes `--channel`, not `--topic`.
- `await` is plain polling, not long-poll.
- Auto-notify routes through the **existing** dispatcher (paste to the requester's tmux session). No new transport. The requester address is the bare agent name (for persistent) or `agent:<template>/<instance-id>` (for ephemeral). Use the address resolver to dispatch.
- `set` is callable by humans (UI) and agents — distinguish via the existing auth model.

**Acceptance.** Tests cover: full CRUD; state change publishes both a `approval-changed` ws event and an auto-notify message; `await` returns at terminal state; withdraw allowed only by creator while pending; channel naming validated.

**Adversarial focus.** Notification arriving before the requester is back in tmux (race during initial spawn). Approval IDs leaking via plain-text message (acceptable, document). Channel-name collisions vs topic names. UI piggyback on WS vs polling — pick one and stick to it.

### Q6 · monitor sidecar pairing

**Goal.** When a topic config includes `monitor_template`, the orchestrator spawns the monitor alongside the worker through the same Q3 kernel, passing `$TARGET_TMUX_SESSION` (the worker's session), and tears it down when the worker completes.

**Key files.** `src/orchestrator/topic-delivery.ts`, `src/orchestrator/instance-reaper.ts`, possibly new `src/orchestrator/monitor-pairing.ts`.

**Hazards.** The monitor is itself an ephemeral instance — it uses the same `prepare`/`create_session`/`start`/`cleanup` lifecycle, just with `$TARGET_TMUX_SESSION` set. Worker completion triggers the monitor's `cleanup` even if the monitor never called `collab complete`. Order: worker finalises first, monitor cleanup runs second.

**Acceptance.** Tests cover: monitor spawned with `$TARGET_TMUX_SESSION` set; monitor's session is killed when worker completes; monitor's row reaches terminal state; pairing tracked in `agent_instances.monitor_of_instance`.

**Adversarial focus.** Monitor crashes mid-run (worker continues; monitor is best-effort). Monitor calls `collab complete` early. Cycle: monitor template that also declares `monitor_template` (reject or limit depth).

### Q7 · CLI mode-awareness

**Goal.** The `bin/collab` binary detects ephemeral context from env (`$MESSAGE_ID` + `$AGENT_TEMPLATE` + `$REPLY_PATH`) and adapts: hides `complete`/`fail` in persistent mode, shows them in ephemeral, prints a different help banner, and `persona.ts` injects a different system-prompt addendum.

**Key files.** `bin/collab`, `src/orchestrator/persona.ts` (system prompt composer around line 881–903).

**Hazards.** Detection must require **all three** env vars to flip modes — accidental env leakage shouldn't switch a persistent agent. Help text and prompt addendum must not contradict the persona's own instructions.

**Acceptance.** Tests cover: env trio set → ephemeral mode CLI + banner + prompt addendum; missing any → persistent; system prompt branches verified.

**Adversarial focus.** Env leakage between agents on the same host; mode flips mid-session; help text accuracy.

### Q8 · crash recovery

**Goal.** Implement the recovery rules from v3-vision.md §"Crash recovery". On orchestrator boot, reconcile live `agent_instances` against actual state. On proxy reconnect, fail orphaned instances. Periodic orphaned-worktree sweep.

**Key files.** `src/orchestrator/main.ts` (boot reconciliation), `src/orchestrator/instance-reaper.ts`, possibly new `src/orchestrator/recovery.ts`.

**Hazards.** Boot reconciliation runs before normal traffic — bound it. Proxy reconnect detection piggybacks on heartbeat registration. Orphaned worktree sweep is a low-frequency separate routine that respects `cwd_base`/`worktree_path` from `agent_instances`.

**Acceptance.** Tests cover (via injected state): instance with `$STATUS_PATH=ok` but no notify → finalised; live tmux + no status → resumed; dead tmux + no status → failed + `cleanup` runs + topic_queue requeued; proxy reconnect → all its live instances failed; orphaned worktree on disk with no row → swept.

**Adversarial focus.** Recovery loop while new messages arrive (race). Inverse — worktree row with no on-disk dir. Repeated recoveries in a restart loop.

### Q9 · dashboard (DEFERRED — not in this one-shot)

Out of scope for this run. Reason: manual UI verification can't be done reliably in a non-interactive Claude Code session per CLAUDE.md. The WebSocket event contract from Q4 is in place; the consumer-side rendering is human follow-up.

---

## End-to-end smoke

**Shell-only by default for this one-shot.** Real-engine validation (with claude/codex/opencode actually launching and calling `collab complete` via tool use) is deferred to a human follow-up — it's flaky enough in a non-interactive run that requiring it would gate the entire upgrade on engine-launch quirks.

The shell-only smoke exercises every piece of the orchestrator+proxy machinery (worktree add/remove, IPC files, tmux session, paste timing, completion endpoint, reaper, reply routing, cleanup) without needing an LLM in the loop.

### Smoke harness (`tests/v3-smoke.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── pre-checks ───────────────────────────────────────────────
# bin/collab must be reachable from the orchestrator's PATH AND from the
# PATH inside tmux sessions it spawns. If not, the smoke fails for a tooling
# reason that looks like a kernel bug.
command -v collab >/dev/null || { echo "FAIL: collab not on PATH"; exit 1; }
node --version >/dev/null    || { echo "FAIL: node not on PATH"; exit 1; }

# ── throwaway repo ───────────────────────────────────────────
REPO=/tmp/agentic-test/test-echo
rm -rf "$REPO"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
# Write the start script INSIDE the repo so it's available in every worktree
# git creates from this repo. Avoids long-line paste issues entirely.
cat > "$REPO/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$WORKTREE_PATH"
# Pure-Node JSON construction. Node 24 is a hard project dep — no jq.
node -e '
  const fs = require("fs");
  const payload = JSON.parse(fs.readFileSync(process.env.MESSAGE_PATH, "utf8"));
  fs.writeFileSync(process.env.REPLY_PATH, JSON.stringify({ echoed: payload }));
  fs.writeFileSync(process.env.STATUS_PATH, "ok\n");
'
collab complete --reply "$(cat "$REPLY_PATH")"
EOF
chmod +x "$REPO/start.sh"
git -C "$REPO" add . && git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init

# ── template ─────────────────────────────────────────────────
cat > agents/test-echo.md <<EOF
---
id: test-echo
persistent: false
engine: claude
cwd_base: $REPO
cwd_template: $REPO/wt-{{message_id}}
repo_root: $REPO
prepare: |
  git -C "\$REPO_ROOT" worktree add "\$WORKTREE_PATH" main
cleanup: |
  git -C "\$REPO_ROOT" worktree remove --force "\$WORKTREE_PATH"
start: |
  bash "\$WORKTREE_PATH/start.sh"
topics:
  - name: echo
    concurrency: 1
---
# test-echo
EOF

# ── publish and wait ─────────────────────────────────────────
# Register a temporary test-only agent (or use a dashboard pseudo-sender).
# Publish, then poll for the reply. Implementation detail: smoke uses the
# orchestrator's HTTP API directly to avoid coupling to bin/collab's UX.
# (Full polling loop omitted here; see scaffolding generated by Q0.)
collab send topic:test-echo/echo --payload '{"msg":"hello"}'

# ── assertions ───────────────────────────────────────────────
# reply payload matches {"echoed":{"msg":"hello"}}
# agent_instances row in terminal state with completed_at set
# $REPO/wt-* worktree dir is gone
# no leftover tmux session matching the instance id
# pending_messages.target_agent rows for this run store BARE agent names:
#   sqlite3 <db> "SELECT count(*) FROM pending_messages
#                 WHERE target_agent LIKE 'agent:%'
#                    OR target_agent LIKE 'topic:%'
#                    OR target_agent LIKE 'approval:%'"
#   must return 0
# agents-table schema unchanged vs BASELINE_AGENTS_SCHEMA
# field-registry.ts unchanged vs BASELINE_COMMIT
```

The start logic lives in `$REPO/start.sh` — a real file inside the throwaway repo, available in every worktree via `git worktree add`. The `start` hook just `bash`-execs it, which is a trivial line to paste. **No `jq`; no long-line paste; no embedded shell quoting tricks.**

### When to run

After Q3, Q5, Q6, Q7, and Q8.

### Deferred real-engine smoke (human follow-up)

Same throwaway repo, but the persona body instructs the LLM to call `collab complete --reply '{"echoed":"<the content>"}'`. Gate the deferred smoke on the one-shot completion; it's not a blocker for shipping the kernel.

---

## Execution structure — adversarial fan-out (scoped)

The fan-out pattern adds real value only on high-stakes quanta. Apply it as follows:

**Full fan-out (Planner → 3 internal critics + Codex outside critic → Reconciler → Builder → Hostile reviewer):**
- Q0 (audit + plan)
- Q3 (ephemeral lifecycle kernel)
- Q8 (crash recovery)

**Lite fan-out (Planner → 1 hostile reviewer):**
- Q1, Q2, Q4, Q5, Q6, Q7

Codex (`mcp__codex__codex`, sandbox=read-only) runs after the three internal critics on full-fan-out quanta and contributes a fourth critic pass with explicit instructions to challenge the plan against the actual code. Treat its findings the same as any internal critic. Skip Codex for lite-fan-out quanta — its latency isn't worth it for bounded changes.

For every quantum:

1. **Planner (Plan subagent)** drafts the implementation plan. Output: file-level changes, new functions, tests, migrations.
2. **Critics (only on full fan-out):** in a single parallel message
   - **Critic A — vision conformance.** Reads `docs/v3-vision.md` + the plan.
   - **Critic B — backwards-compat.** Reads the BC invariants + the plan.
   - **Critic C — code-style.** Uses the code-style skill.
3. **Reconciler.** Merges feedback into the plan. Blocking issues → planner revises.
4. **Builder.** Executes the plan in-place on the integration branch (see shared-file coordination below). Runs `npx tsc --noEmit` and `node --test 'src/**/*.test.ts'` before declaring done.
5. **Hostile reviewer.** Reviews the diff explicitly hostile: regressions, scope creep, missing edge cases, BC breakage, untested paths.
6. **Iterate** until hostile review has zero blockers.
7. **Integrate.** Commit on `v3-integration`. Re-run full tests + type check. Red → revert + iterate.

Parallelism rules:
- Builders for parallelisable depth-mates (Q1+Q2, then Q5+Q6+Q7) fanned out in separate worktrees because they touch mostly disjoint files.
- Q3, Q4, Q8, Q9 build directly on the integration branch (sequential, single worktree) — they touch overlapping files and worktree-merge churn would dominate.

## Shared-file coordination

Several quanta touch the same files (`src/orchestrator/database.ts`, `src/orchestrator/routes.ts`, `src/shared/types.ts`, `bin/collab`). Per-quantum isolated worktrees would create merge pain for marginal benefit. Rules:

- **`database.ts` migrations are owned by Q3.** Q3 writes the migration block for `topic_queue`, `agent_instances`, and the two Q2-introduced tables (`agent_templates`, `topics`) — Q2 produces the schema spec, Q3 includes it in a single coherent migration. Q5 and downstream append columns to that block; no separate migration files.
- **`bin/collab`** is owned by Q1 (target validation), Q3 (`complete`/`fail`), Q5 (approval subcommands), and Q7 (mode-awareness) — each appends without removing prior work.
- **`routes.ts`** grows additively. New routes are added; existing routes are wrapped via the address resolver, never replaced.
- **`types.ts`** — the `Address` type lands in Q1; `WsEvent` additions land in Q4; never edited twice in the same quantum.
- All shared-file edits happen on the integration branch, **after** that quantum's hostile review has cleared. No long-lived per-quantum branches for shared-file work.

---

## Reporting

After each quantum: a short message to the user — quantum name, lines added/changed, tests added, smoke status, any deferred items.

Final report: a punch list — what was implemented, what was deferred, the integration branch name, the command to run the end-to-end smoke, and any open questions that need human input.

---

## Open invitations for human input

The executing system should pause and ask before:
- Renaming `persistent-agents/` → `agents/` (deferred by default).
- Changing the `collab` binary's location or invocation surface beyond adding subcommands.
- Touching the persistent-agent state machine in `lifecycle.ts`.
- Introducing any new npm dependency (default: refuse).
- Anything not covered by these specs that exceeds 200 LOC of new code.

---

## Tools and capabilities to use

- **Plan subagent** for per-quantum planning passes.
- **Explore subagent** for read-only code audits at Q0 and as needed.
- **Agent (general-purpose) in worktrees** for builders. Use `isolation: "worktree"` so each quantum lives on its own branch.
- **Parallel tool calls** for fan-out (critics, parallelisable quanta).
- **TaskCreate / TaskUpdate** to track the quantum DAG state.
- **`node --test`** and **`npx tsc --noEmit`** as the green-light gates.
- **`git worktree`** for the integration branch and per-quantum branches.

---

## Final invariant

If at any point the answer to "are we still backwards compatible?" is unclear, stop and ask. The v3 vision is worthless if 2.x breaks.
