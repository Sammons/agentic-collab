# RFC-009: Remove Ephemeral Agents

**Status:** Draft — operator-directed removal ("it just doesn't work very well — rip it out")
**Author:** rfc-author agent
**Created:** 2026-06-12
**Removes:** the v3 ephemeral-agent surface built across Q1–Q8 (`docs/quanta/`), RFC-006 stateless roots, and the `failInstanceAndSettleQueue` hardening from PR #322.

## Problem

The ephemeral-agent feature (topic-addressed templates that spawn one-shot worktree+tmux instances) shipped across eight quanta and two follow-up RFCs. In production it has spawned exactly one instance, which failed. The feature costs:

- ~9,500 LOC of kernel, recovery, and test code (4 DB tables, 3 crash-recovery routines, a monitor-sidecar pairing, a reaper, a delivery driver).
- Permanent boot-path work: `BootReconciler.reconcile()` runs before `server.listen` on every restart; the orphan sweep ticks every 60s forever.
- A parallel address grammar (`topic:`, `agent:<tmpl>/<id>`) threaded through both send routes, the approvals notifier, and the CLI.
- A shadow `agent_templates` row for every one of the 28 persistent agents, maintained solely so ephemeral addressing could be uniform.

The operator has decided to remove it entirely. This RFC is the removal specification; a single builder PR executes it.

## Decision

Delete the ephemeral kernel and every surface that exists only to serve it. Persistent agents, approvals, telegram, reminders, pages, stores, files, teams, and the proxy protocol are untouched. The four ephemeral tables are dropped via a one-time migration (data loss accepted — see DB strategy). The removal is one PR; rollback is one revert (plus a documented DB caveat).

### Live-DB facts grounding this decision (read-only inspection, 2026-06-12)

| Table | Rows | Detail |
|---|---|---|
| `agent_templates` | 45 | 44 persistent shadow rows + 1 ephemeral (`agentic-collab-lead-ephemeral`) |
| `topics` | 1 | `agentic-collab-lead-ephemeral/collab-fr` |
| `topic_queue` | 1 | status `failed` (terminal) |
| `agent_instances` | 1 | state `failed` (terminal) |
| `agents` | 28 | persistent; zero rows shadow an ephemeral template |
| `PRAGMA user_version` | 2 | |

No live instance, no queued work, no pending claim. Nothing of value is lost by dropping the tables.

## Exact Removal Scope

### DELETE outright (whole files)

| File | LOC | Why ephemeral-only |
|---|---|---|
| `src/orchestrator/topic-delivery.ts` | 728 | Q3 kernel: claim → prepare → create_session → start. Includes Q6 `spawnMonitor` |
| `src/orchestrator/topic-delivery.test.ts` | 513 | |
| `src/orchestrator/instance-reaper.ts` | 441 | Q3 completion side + Q6 `tearDownMonitor` |
| `src/orchestrator/instance-reaper.test.ts` | 421 | |
| `src/orchestrator/recovery.ts` | 1,065 | Q8: `BootReconciler`, `ProxyReconnectHandler`, `OrphanedWorktreeSweep`. Verified: operates only on `agent_instances`/`topic_queue`/`agent_templates`; no persistent-agent caller. Persistent self-heal is `recoverFailedAgents` in routes.ts and stays |
| `src/orchestrator/recovery.test.ts` | 1,603 | |
| `src/orchestrator/template-sync.ts` | 180 | Sole writer of `agent_templates`/`topics` |
| `src/orchestrator/template-sync.test.ts` | 428 | |
| `src/orchestrator/instance-env.ts` | 142 | IPC paths + env contract (`MESSAGE_PATH`/`REPLY_PATH`/`STATUS_PATH`/…) |
| `src/orchestrator/instance-env.test.ts` | 198 | |
| `src/orchestrator/reconcile-roots.ts` | 91 | RFC-006 Q1 stale-root teardown — exists only because ephemeral templates can shadow `agents` rows |
| `src/orchestrator/reconcile-roots.test.ts` | 155 | |
| `src/test/cli-mode.test.ts` | 114 | Q7 CLI mode-awareness tests |
| `tests/v3-smoke.sh` | 179 | End-to-end smoke of the ephemeral kernel |

Deleted-file total: **6,258 LOC**.

### EDIT (surgical removal; what stays is noted)

| File | Δ LOC (≈) | Remove | Stays |
|---|---|---|---|
| `src/orchestrator/database.ts` | −800 | CREATE TABLE + indexes for `agent_templates` (161–176), `topics` (178–190), `topic_queue` (192–211), `agent_instances` (213–243); migration v2 body (498–507, references `agent_instances` — neuter to a no-op comment, keep `PRAGMA user_version = 2`); methods 693–1319: `upsertAgentTemplate`, `replaceTopicsForTemplate`, `getAgentTemplate`, `listAgentTemplates`, `listTemplatesAsAgentRecords`, `getTopicsForTemplate`, `enqueueTopicMessage`, `claimAndCreateInstance`, `countQueuedTopicMessages`, `countLiveInstancesForTopic`, `getAgentInstance`, `getInstance`, `listInstancesForTemplate`, `getAgentInstanceByAddr`, `listLiveAgentInstances`, `listAgentInstancesByProxy`, `listCwdBases`, `createMonitorInstance`, `findMonitorForWorker`, `updateInstanceState`, `markTopicQueueCompleted`, `failInstanceAndSettleQueue` (PR #322); row mappers `mapAgentTemplateRow`/`mapTopicRow`/`mapAgentInstanceRow`/`mapTopicQueueRow` (2738–2810). ADD the v3 DROP migration (see DB strategy) | All other tables/accessors; v1 teams migration (471–494) byte-identical |
| `src/orchestrator/routes.ts` | −300 | import of recovery types (43); `RouteContext.topicDelivery`/`.instanceReaper`/`.recovery` (106–125); `tryRouteToEphemeralTemplate` (505–570); `topic:` + `agent-instance:` branches in `/api/agents/send` (586–602, 613–621) and `/api/dashboard/send` (727–743, 753–760); `tryRouteToEphemeralTemplate` call sites (633–646, 774–785); routes `POST /api/topics/publish` (816–838), `POST /api/instances/:id/complete` (840–858), `GET /api/agent-templates/:id/instances` (860–880), `GET /api/instances/:id/peek` (882–906), `GET /api/instances/:id` (908–928); `ctx.recovery` block in `/api/proxy/register` (1296–1306) | `approval:`/`telegram:` branches in both send paths; `recoverFailedAgents` self-heal in proxy-register (1291–1294); `reloadPersonas`; everything else |
| `src/orchestrator/main.ts` | −120 | imports (23–27: `reconcileEphemeralRoots`, `TopicDelivery`, `InstanceReaper`, recovery trio); `reconcileRoots()` fn (136–153) + 3 call sites (415, 694, 716); `INSTANCES_DIR` (321–322); `topicDelivery`/`instanceReaper`/recovery construction (324–340, 356–381); routeCtx fields (401–408); template merge in `wss.onConnect` (496–505 → just `db.listAgents()`); `instanceReaper.stop()`/`orphanedWorktreeSweep.stop()` (615–616); `bootReconciler.reconcile()` pre-listen (641–650); `instanceReaper.start()` (739); orphan-sweep start (741–747) | `ApprovalService` (342–354) with `onEvent`/`onMessage` wiring; persona watch; telegram reconcile; everything else |
| `src/shared/types.ts` | −200 | `AgentRecord.isTemplate`/`templateName`/`instanceSuffix` (227–232); `AgentTemplateRow`, `TopicRow`, `AgentInstanceState`, `AgentInstanceRow`, `TopicQueueStatus`, `TopicQueueRow` (333–475); `WsTemplateUpdatedEvent`, `WsTopicQueueChangedEvent`, `WsInstanceSpawnedEvent`, `WsInstanceCompletedEvent`, `WsInstanceFailedEvent` (537–588) + their 5 `WsEvent` union members (612–616) | `WsApprovalChangedEvent`; `ProxyCommand` incl. generic `exec`; all persistent types |
| `src/shared/address.ts` | −60 | `'topic'` from `KNOWN_PREFIXES`; `INSTANCE_ID_RE`; `agent-instance` + `topic` union members; the `agent:` slash branch (72–88) and the `topic:` branch (90–107); both `addressToString` cases. After removal `agent:<tmpl>/<id>` fails `NAME_RE` → malformed; `topic:…` → unknown-prefix malformed | `agent:`/`approval:`/`telegram:` classes, bare-name compat, `NAME_RE`, total parsing |
| `src/shared/address.test.ts` | −60/+15 | topic + agent-instance accept/round-trip cases | ADD malformed-case assertions for `agent:foo/bar` and `topic:foo/bar` |
| `src/shared/utils.ts` | −3 | `DEFAULT_WORKTREE_PREFIX` (line 20; recovery.ts is the sole consumer) | `shellQuote` and the rest |
| `src/orchestrator/message-dispatcher.ts` | −50 | `deliverToInstance` (≈278–325) and its doc comment | Entire persistent dispatch pipeline |
| `src/orchestrator/message-dispatcher.test.ts` | −105 | invariant #10/#10b tests (167–271) | |
| `src/orchestrator/approvals.ts` | −14 | the `agent-instance` notify branch in `notifyRequester` (lines 237–247) + doc bullets (16, 205). The non-deliverable fall-through (248–250) then covers it | **Whole module stays** (Q5 keep-list). The `agent:` enqueue path is the only notify route left |
| `src/orchestrator/approvals.test.ts` | −95 | 'Auto-notify routes via deliverToInstance' test (317–407) | All other approval tests |
| `src/orchestrator/persona.ts` | −220 | template frontmatter fields `persistent`/`cwd_base`/`cwd_template`/`repo_root`/`prepare`/`cleanup`/`topics` (79–95); `TopicSpec` (98–110); `'prepare'`/`'cleanup'` in `NESTED_FIELDS` (125); `topics:` special-case parse (228–235) + `parseTopicsArray`/`coerceTopicSpec` (881–985); `composeSystemPrompt` `mode` param + ephemeral addendum (1284–1376 → persistent addendum becomes unconditional); `isEphemeralTemplate` (1437–1445); `trySyncTemplate` (1451–1466) + template-sync import (1422); ephemeral branches in `syncSinglePersona` (1495–1504), `syncPersonasToDb` (1540–1550), `syncPersonasWithDiff` (1616–1634) | Generic frontmatter parser incl. unknown-key verbatim passthrough (a leftover `topics:`/`prepare:` block in a persona file becomes inert carried-through text); all persistent sync behavior byte-compatible |
| `src/orchestrator/persona.test.ts` | −90 | `composeSystemPrompt` ephemeral-mode test (198–211); `v3 topics frontmatter` describe (1342–1418). Rename the `ephemeral: true` fixture key in the unknown-key passthrough test (898–906) to a neutral key (e.g. `flagged: true`) so the grep gate is clean | |
| `src/orchestrator/persona-serialize.test.ts` | −2 | the `topics:` `structuredRenderable` assertion (36–37) — with topics parsing gone, re-verify behavior and update or drop | |
| `src/orchestrator/routes.test.ts` | −560 | `API Routes — v3 Q3 endpoints` describe (1639–2159); three `it`s in the main describe: topic 503 (421–432), agent-instance 503 (451–464), dashboard topic 503 (478–490). ADD: send to `topic:foo/bar` / `agent:tmpl/inst-1` now expects 400 malformed | Q5 approval endpoint tests; everything else |
| `src/orchestrator/database.test.ts` | −250 | `agent_templates and topics tables (v3)` describe (921–1036); `failInstanceAndSettleQueue (Q8 hardening)` describe (1037–1167) | v1 migration test (1168+) and the rest |
| `src/orchestrator/health-monitor.ts` | −2 | two stale comments (≈310, 352) saying `agent_instances` rows are "excluded by construction" — reword to drop the table reference | All behavior (monitor never touched instances) |
| `src/orchestrator/health-monitor.test.ts` | −80 | `invariant #8: pollAll never operates on agent_instances rows` (960–1040) | |
| `src/orchestrator/hook-resolver.ts` | −26 | the `v3 ephemeral lifecycle` block of `TemplateVars` (57–81: `MESSAGE_PATH`…`INSTANCE_ID`) | `AGENT_NAME`/`AGENT_CWD`/`SESSION_ID`/`PERSONA_PROMPT*`/`capturedVars`; whole resolver (persistent hooks use it) |
| `src/orchestrator/lifecycle.ts` | ±0 | reword one comment (≈1176, "ephemeral session transcript" → "prior session transcript") for the grep gate | **No functional change.** `dispatchHookResult`/`LifecycleContext` are persistent-lifecycle core that topic-delivery merely consumed |
| `bin/collab` | −130 | `isEphemeralMode` (29–36); `cmd()` `mode` param + help filter (181–182, 1168–1176 → drop the param, keep `hidden`); ephemeral signaling section: `requireEphemeralEnv`, `atomicWrite`, `complete`, `fail` (393–489; `atomicWrite` has no other caller); ephemeral help banner branch (1149–1162 → persistent banner unconditional); `topic:<tmpl>/<name>` from the send error text (323) | `send`, `approval` subcommands, `publish` (pages — unrelated to topic publish), tmux, reminders, queue |
| `src/dashboard/chat.ts` | −20 | ephemeral color heuristic comments/branches (520, 526, 562–570); template spawn-warn (675–687); `agent.isTemplate` checks (687, 1152 → drop the isTemplate half of the condition) | mention pills, send flow |
| `src/dashboard/sidebar.ts` | −12 | `isTemplate` rendering (246–262 → always `statusClass(agent.state)`) | |
| `src/dashboard/styles/sidebar.css` | −20 | `.status.template` + `.member.is-template` rules (275–295) | |
| `src/dashboard/styles/chat.css` | −4 | `.spawn-warn` rule (≈406) | |
| `docker-compose.yml` | −2 | the ephemeral `cwd_base` visibility comment (17–18) | mounts unchanged |
| `docs/quanta/README.md` | +3 | add a banner: "Historical — the ephemeral feature documented here was removed by RFC-009" | Q1–Q8 docs retained as history (also `v3-vision.md`, `v3-upgrade-prompt.md`, etc. — historical, not deleted) |

Edit total: ≈ **−3,200 LOC**. Grand total: ≈ **9,500 LOC removed**.

### NOT in this repo (coordinated, separate PR in claude-home)

- `persistent-personas/agentic-collab-lead-ephemeral.md` — the only `persistent: false` persona on disk (claude-home repo). Remove there AFTER this PR deploys, so the persona watcher never re-syncs it. (The orchestrator's local `persistent-agents/` dir has no ephemeral personas.)
- claude-home `MEMORY.md`/auto-memory references to ephemeral templates — clean up opportunistically.

## DB strategy

**Recommendation: drop the tables.** Remove the four CREATE TABLE statements (+ their indexes) from the schema block, remove all accessors, and add a one-time migration:

```ts
// v3: RFC-009 — ephemeral agents removed. Drop the four ephemeral tables.
// Child tables first: `topics` has an FK → agent_templates and
// PRAGMA foreign_keys = ON precedes this block.
if (userVersion < 3) {
  this.db.exec('DROP TABLE IF EXISTS agent_instances');
  this.db.exec('DROP TABLE IF EXISTS topic_queue');
  this.db.exec('DROP TABLE IF EXISTS topics');
  this.db.exec('DROP TABLE IF EXISTS agent_templates');
  this.db.exec('PRAGMA user_version = 3');
}
```

- **userVersion bump: 2 → 3.** The v1 (teams) block stays byte-identical. The v2 block body referenced `agent_instances` (suffix column) — replace the body with a comment and keep `PRAGMA user_version = 2` so the version ladder stays monotonic for any DB still at 0/1.
- **Why data loss is acceptable:** every row is terminal (1 failed instance, 1 failed queue row — verified read-only on the live DB 2026-06-12). The 44 persistent `agent_templates` rows are derived shadows of persona files, rebuilt from nothing; the 1 ephemeral template's persona file is being removed anyway. Indexes (`idx_topic_queue_lookup`, `idx_agent_instances_*`, `idx_instances_template_suffix`) drop with their tables.
- `DROP TABLE IF EXISTS` makes the migration idempotent and safe on fresh DBs that never had the tables.

## WS / CLI / API compatibility

**WS event types removed:** `template_updated`, `topic_queue_changed`, `instance_spawned`, `instance_completed`, `instance_failed`. Verified zero in-repo consumers: the dashboard's event switch ignores unknown types and `src/dashboard/` contains no handler for any of the five (the Q9 instance UI was never built). `approval_changed` and all 2.x events stay.

**HTTP endpoints removed:** `POST /api/topics/publish`, `POST /api/instances/:id/complete`, `GET /api/instances/:id`, `GET /api/instances/:id/peek`, `GET /api/agent-templates/:id/instances`. Verified consumers: only `bin/collab complete`/`fail` (removed in the same PR) and `tests/v3-smoke.sh` (deleted). The dashboard never calls them.

**Address forms that stop resolving:** `topic:<tmpl>/<topic>` → 400 malformed (unknown prefix); `agent:<tmpl>/<instance-id>` → 400 malformed (`NAME_RE` rejects the slash). Both send routes already have malformed → 400 paths, so no new handling is needed — only new tests asserting the downgrade.

**CLI:** `collab complete` and `collab fail` disappear; `collab --help` always shows the persistent banner. `collab send topic:…` now reports the orchestrator's 400. Everything else is unchanged.

**Behavioral note:** bare-name sends to a name that only existed as an ephemeral template return to plain 404 (`tryRouteToEphemeralTemplate` checked the template before `getAgent`); with the feature gone this is the correct outcome.

## Keep-list (looks ephemeral, must stay)

1. **ApprovalService (Q5)** — whole module, routes, CLI subcommands, `approval_changed` WS event. Only the 11-line `agent-instance` notify branch (`approvals.ts:237–247`) goes.
2. **Address router** (`shared/address.ts`) — stays as the parser for `agent:` / `approval:` / `telegram:` (+ bare-name compat). Do not delete the module.
3. **Generic proxy `exec` command** (`ProxyCommand`) — used by usage-poller, lifecycle hooks, and persistent flows. The ephemeral feature was a consumer, not the owner. Proxy code (`src/proxy/`) needs **zero changes**.
4. **`recoverFailedAgents` persistent self-heal** in `/api/proxy/register` (routes.ts:1291–1294) — predates Q8 and serves persistent agents. Only the `ctx.recovery` block below it goes.
5. **`dispatchHookResult` / `LifecycleContext`** (lifecycle.ts) and the whole hook-resolver — persistent lifecycle core. Only the ephemeral `TemplateVars` fields go.
6. **`topic` as a message field** — `--topic` on `collab send`, `DashboardMessage.topic`, reply envelopes, telegram `topic: 'telegram'`. Unrelated to `topic:` addresses; appears hundreds of times; keep all of it.
7. **Worktree dev conventions** — `.claude/worktrees/`, `worktree-description.md`, the `worktree` skill. Repo development process, not runtime code.
8. **Teams + v1 migration** (database.ts:471–494), persona unknown-key passthrough, `wss.broadcastEvent` infrastructure (still carries `approval_changed`).
9. **`collab publish`** — publishes pages tarballs; despite the name it has nothing to do with topic publish.
10. **`watch.css` / Watch tab** — the dashboard watch surface is for persistent agents; the instance-watch UI was never built.

## Validation checklist

1. `pnpm typecheck` — per-file delta clean (judge against the ~686-error TS5097/TS4111 baseline; no NEW errors in touched files).
2. `node --test 'src/**/*.test.ts'` — green (suite shrinks by ≈2,300 test LOC; no skips added).
3. **Grep gate:** `grep -ri ephemeral src/ bin/` → **zero hits** (the persona.test fixture key rename and the lifecycle.ts/health-monitor.ts comment rewords exist to make this absolute). `grep -rn "agent_instances\|agent_templates\|topic_queue\|deliverToInstance\|tryRouteToEphemeral" src/ bin/` → only the v3 DROP migration + the neutered v2 comment in `database.ts`. Hits under `docs/` are sanctioned (historical).
4. **Migration check:** copy the live DB, boot `new Database(copy)` — `PRAGMA user_version` = 3, the four tables gone, `agents` still has 28 rows, v1 teams data intact.
5. **Orchestrator restart** (per the bladerunner deploy pattern: pull main + `docker compose restart orchestrator`): boots with no `boot-reconcile`/`orphan-sweep` log lines, all 28 persistent agents intact, dashboard loads, sidebar shows no template entries.
6. **`collab send` round-trip:** operator → agent and agent → operator both deliver; `collab send topic:foo/bar …` returns 400 malformed.
7. **Approvals round-trip:** `collab approval create` → dashboard approve → notify lands in the requester agent's thread (proves the surgical `notifyRequester` edit kept the `agent:` path).
8. **Proxy re-register:** restart the proxy; persistent self-heal still recovers agents; no instance-reconcile errors in logs.
9. `collab --help` shows the persistent banner only; `complete`/`fail` absent from the listing.

## Rollback

Single revert of the squash/merge commit restores all code. **DB caveat:** `user_version` stays 3 after revert, so (a) the reverted `CREATE TABLE IF NOT EXISTS` statements recreate the four tables empty on next boot, but (b) the v2 suffix migration will NOT re-run (3 ≮ 2), leaving `agent_instances` without `suffix`. If a full ephemeral resurrection is ever needed: run `PRAGMA user_version = 1` on the DB before booting the reverted code (v1 is idempotent — `INSERT OR IGNORE`), letting v2 re-add the suffix column. Record this in the revert PR if it ever happens.

## Rejected Alternatives

1. **Keep-but-hide (feature-flag the routes/UI off, keep the kernel).** Rejected: the cost is not the UI — it is the boot reconciler, the 60s sweep, the four tables, the recovery test surface, and the address-grammar tangles in send/approvals. A hidden feature still pays all of it and still rots. Flags are for risk-bounding live features, not for warehousing dead ones.
2. **Fix the UX instead of removing.** Rejected by the operator: one production spawn, which failed. The kernel's value hypothesis (fan-out one-shot workers) did not survive contact; persistent agents + the dashboard cover the actual workflows. If one-shot fan-out returns, it should be re-designed from the lessons in `docs/quanta/` (retained) rather than evolved from this implementation.
3. **Keep tables, drop code.** Rejected: orphaned tables invite schema drift (future migrations must tiptoe around them), keep the misleading `agent_templates` shadow rows for all 28 persistent agents, and make the grep gate impossible. The data is terminal and worthless; `DROP TABLE IF EXISTS` at userVersion 3 is strictly cleaner. (The inverse — drop tables, keep code — fails compilation and was never on the table.)
4. **Phase the removal over several PRs (routes first, kernel later).** Rejected: every intermediate state either breaks imports or ships an orchestrator that half-knows about instances. The dependency graph (main.ts → routes.ts → kernel → database.ts → types.ts) removes cleanly in one changeset, and one PR = one revert.
