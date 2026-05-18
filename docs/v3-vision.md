# agentic-collab 3.0 — design diamond

## North star
**Inter-agent messaging is unchanged.** Publishers send to an address; they don't care what's on the other side. What *is* new: a class of address — a **topic** declared by an ephemeral agent template — that, when delivered to, runs host-shell `prepare`, creates a tmux session, pastes the engine `start` command into it, and waits for the agent to signal completion.

The publisher writes the same `send(addr, msg)` either way.

## Primitives

### 1. Address
Three address classes:
- **Agent address** — `agent:gitea-lead` (persistent agent's inbox), or `agent:<template>/<instance-id>` (a live ephemeral instance, addressable for the duration of its run).
- **Topic address** — `topic:<agent-template>/<topic>`, e.g. `topic:aws-account-lead/provision`. Triggers an ephemeral spawn.
- **Approval channel** — `approval:<channel>`, e.g. `approval:aws-account-provision`. Names a human-decision queue; distinct from `topic:` to avoid the "topic = spawn compute" overload. Approvals are CRUD records categorised by channel, not message queues that spawn workers.

### 2. Agent template
Same file shape as today's persona files (markdown body + YAML frontmatter). Lives in `agents/*.md`. New frontmatter fields are scoped to ephemeral agents: `persistent`, `topics`, `cwd_base`, `cwd_template`, `prepare`, `cleanup`.

**Two distinct hook kinds, by execution surface:**
- `start` / `exit` — **tmux-paste hooks** (today's `dispatchHookResult` mechanism). The string is *typed into the tmux pane*, not run as host shell. For ephemeral agents, `start` is what launches the engine inside the already-created tmux session.
- `prepare` / `cleanup` — **host-shell hooks** (new; executed via the proxy's existing `exec` command). Run on the proxy host before the tmux session exists (`prepare`) and after it's torn down (`cleanup`). Used for worktree setup/teardown and any other host-shell work.

```markdown
---
id: aws-account-lead
persistent: false
engine: claude
model: opus

# cwd_base is a real, existing directory — used as the create_session cwd.
cwd_base: /var/agentic/work/aws-account-lead
# cwd_template is derived per-message; prepare creates this directory.
cwd_template: /var/agentic/work/aws-account-lead/wt-{{message_id}}

# Host-shell hooks (run via proxy exec). New mechanism.
prepare: |
  git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" main
cleanup: |
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH"

# Tmux-paste hook (today's mechanism). Typed into the pane after the engine starts.
start: |
  cd "$WORKTREE_PATH" && claude --session-id "$MESSAGE_ID" < "$MESSAGE_PATH"

topics:
  - name: provision
    schema: ./schemas/provision.json
    reply_schema: ./schemas/provision-reply.json
    concurrency: 1
    monitor_template: aws-account-monitor
  - name: teardown
    schema: ./schemas/teardown.json
    prepare: ./teardown-prepare.sh         # optional per-topic override of any hook
---

# AWS Account Lead

You provision and tear down AWS accounts...
```

Persistent agents (`persistent: true`) ignore `topics`, `cwd_base`, `cwd_template`, `prepare`, `cleanup`. Their `start`/`exit` hooks behave exactly as today (today's persona files load unchanged with `persistent: true` defaulted).

The `topics` array is structured nested data; it loads via its own sync path into the `topics` table, parallel to the agent-template upsert (same precedent as `custom_buttons` and `indicators` in today's persona parser).

**Template-only fields never touch the `agents` table.** `persistent`, `cwd_base`, `cwd_template`, `prepare`, `cleanup`, and `topics` are stored exclusively in `agent_templates`; the scalar field-registry (`buildUpsertOptsFromFrontmatter`) which targets the `agents` table is not extended with any of them.

### 3. Messaging (unchanged in shape)
`send(addr, payload, in_reply_to?)` is fire-and-forget, exactly as today. Replies arrive later as normal inbound messages. Agents correlate by content or the optional `in_reply_to` field.

### 4. Topic delivery contract
For each queued message on `topic:<template>/<name>`, the orchestrator drives a fixed sequence using only existing proxy `/command` operations:

1. **Allocate.** Orchestrator generates `MESSAGE_ID`, resolves `WORKTREE_PATH` from `cwd_template`, writes payload to `$MESSAGE_PATH`, creates empty `$REPLY_PATH` and `$STATUS_PATH`.
2. **Prepare (host shell, via proxy `exec`).** Orchestrator runs the template's `prepare` hook on the proxy host with the env contract below. `prepare` creates the worktree.
3. **Create tmux session (proxy `create_session`).** Session is created against `cwd_base` (a real, existing directory — *not* the not-yet-created worktree path).
4. **Start (tmux paste).** Orchestrator dispatches the template's `start` hook through today's `dispatchHookResult` path — the string is typed into the pane. The `start` hook is responsible for `cd`-ing into `$WORKTREE_PATH` and launching the engine with the message payload.
5. **Run.** The agent does its work. While alive, any message sent to `INSTANCE_ADDR` is delivered via paste to `$TMUX_SESSION` (today's mechanism — no change).
6. **Complete (agent signal).** The agent explicitly calls `collab complete --reply <json>` (or `collab fail --reason <text>`), which writes `$STATUS_PATH` (`ok` | `error`) and `$REPLY_PATH`, and POSTs the orchestrator. If the POST fails, the reaper picks up `$STATUS_PATH` on its next sweep. The agent must call `collab complete` exactly once; otherwise the instance is treated as still-running until an outer timeout.
7. **Reply.** Orchestrator reads `$STATUS_PATH` + `$REPLY_PATH`, then `send(REPLY_TO_ADDR, reply, in_reply_to=MESSAGE_ID)`.
8. **Kill session (proxy `kill_session`).**
9. **Cleanup (host shell, via proxy `exec`).** Orchestrator runs the template's `cleanup` hook with the env contract below. `cleanup` removes the worktree.

**Env contract for `prepare` and `cleanup` (host-shell hooks):**
```
MESSAGE_PATH, MESSAGE_CONTENT     # payload (cleanup can read final state)
REPLY_PATH, STATUS_PATH           # cleanup can inspect outcome
WORKTREE_PATH                     # the path prepare creates and cleanup removes
CWD_BASE                          # template's cwd_base
REPO_ROOT                         # repo to take worktrees from (defaults to cwd_base; overridable per template)
AGENT_TEMPLATE, TOPIC_NAME, MESSAGE_ID
INSTANCE_ADDR, REPLY_TO_ADDR
```

**Env contract for `start` (tmux-paste hook):** same vars exported in the tmux env via the session's environment (`tmux set-environment`) before paste, so the string can reference them and they expand when typed.

The proxy is unchanged in surface area — `prepare`/`cleanup` use the existing `exec` command; `start` uses today's paste path; session lifecycle uses `create_session`/`kill_session`/`has_session`. No new proxy vocabulary.

### 5. Approval primitive (CRUD + auto-notify)
Approvals are first-class resources, **categorised by channel** (`approval:<channel>`). The channel is a human-decision queue label — *not* a topic, *not* an address that spawns workers.

- **Create** — `collab approval create --channel <channel> --payload <json>` → returns `approval_id`. The orchestrator records the row and emits a websocket event for any subscriber listening on that channel.
- **Read** — `collab approval get <id>`.
- **Update** — `collab approval set <id> --state approved|rejected|amended [--payload ...]` (humans via UI; agents in principle).
- **Delete** — `collab approval withdraw <id>` (creator only, while pending).

**Auto-notify on state change:** the orchestrator sends a regular message to the *requesting agent's* address (`agent:gitea-lead`, or `agent:<template>/<instance-id>` for ephemeral): `Approval <id> updated: <state>. Run "collab approval get <id>" for details.` Delivery routes through the proxy like any other message (tmux paste). The approval channel is for *categorisation*, not for message routing.

Shell scripts that need to block: `collab approval await <id>` polls the approval record until terminal state. Doesn't depend on the notification message arriving.

### 6. Monitor sidecar
A monitor template is just another ephemeral agent template — its `start` hook does the capture-pane / send-keys work. When a topic specifies `monitor_template`, the orchestrator spawns it alongside the worker via the same lifecycle (its own `prepare` / `create_session` / `start` / `cleanup`), passing `$TARGET_TMUX_SESSION` (the worker's session) in env. Pairing is tracked in `agent_instances.monitor_of_instance`. When the worker completes, the orchestrator kills the monitor's session and runs its `cleanup` hook too.

## Proxy responsibilities

**No new commands on the proxy.** The existing `/command` vocabulary (`create_session`, `paste`, `exec`, `kill_session`, `has_session`, `capture`, …) is sufficient. Ephemeral lifecycle work happens inside `start`/`exit` hooks that the orchestrator dispatches via the existing path — the proxy just runs the shell.

Active-instance state (which instance maps to which tmux session, which PID, which worktree) lives in the orchestrator's DB (`agent_instances` table), not in the proxy. This keeps the proxy thin and matches its current design intent.

## What's actually new vs. 2.x

| Concern | 2.x | 3.0 |
|---|---|---|
| Persistent agents | persona file → live tmux | agent file (`persistent: true`) → live tmux (same observable behavior) |
| Sending messages | `send(agentId, msg)` | `send(address, msg)` — agent or topic; same fire-and-forget semantics |
| Ephemeral work | n/a | agent file declares topics → write-payload + exec script |
| Approvals | n/a | CRUD resource + auto-notification on state change |
| Monitors | per-agent health-monitor in orchestrator | proxy-spawned sidecar per topic, paired with worker |

Persistent-agent inboxes, message dispatch, cool-down, lifecycle locking, dashboard tiles — **unchanged**.

## Data model (delta only)

```
agent_templates    (id PK, persona_path, engine, model, persistent BOOL,
                    cwd_base?, cwd_template?, repo_root?,
                    hook_start?, hook_exit?, hook_prepare?, hook_cleanup?,
                    ...other hooks as today)
topics             (agent_template FK, name, hook_prepare_override?, hook_start_override?,
                    hook_cleanup_override?, monitor_template?, concurrency,
                    schema?, reply_schema?, PRIMARY KEY (agent_template, name))
topic_queue        (id PK, agent_template FK, topic_name, payload, reply_to_addr?,
                    in_reply_to?, status, claimed_by_instance?, worktree_path?, created_at)
agent_instances    (id PK, agent_template FK, spawned_from_topic?, instance_addr,
                    tmux_session, worktree_path, proxy_id, state,
                    monitor_of_instance?, started_at, completed_at?)
approvals          (id PK, requester_addr, channel, payload, state, amendments_json?,
                    created_at, updated_at, decided_by?, decided_at?)
approval_events    (approval_id FK, event_type, payload, created_at)
```

**Sync routine separation.** `agent_templates` and `topics` are populated by a new template-sync routine that scans `agents/*.md` at startup and on reload. The new fields (`persistent`, `cwd_base`, `cwd_template`, `repo_root`, `prepare`, `cleanup`, `topics`) are template-only and **never** flow through the existing `field-registry.buildUpsertOptsFromFrontmatter` (which targets the `agents` table). The scalar field-registry's migration generator is left untouched, so no `ALTER TABLE agents` runs for any new field. The `topics` array follows the same precedent as `custom_buttons` and `indicators` — parsed in `persona.ts`, written via its own routine, not through the registry.

`agent_instances` is a separate table from `agents` (which remains the persistent-agent table) to avoid contaminating the persistent-agent state machine with ephemeral concerns. Health-monitor and cool-down explicitly exclude rows in `agent_instances`.

## CLI surface (`collab`, extends today's binary)

**Backwards-compat reality check.** Today's `collab send` is `collab send <target> --topic <topic> <message>` and validates `<target>` against `/api/agents` client-side. Two changes are needed without breaking it:

- The client-side target validation must accept `topic:<template>/<name>` and `approval:<channel>` addresses (and `agent:` prefixes) without rejecting them as "no such agent." The bare-name form continues to work and is treated as `agent:<name>`.
- The existing `--topic <topic>` flag retains its 2.x meaning (message *category*, used for cool-down grouping). To avoid confusion with v3's `topic:` *address prefix*, the docs and `--help` text disambiguate explicitly. Sending to a v3 topic looks like: `collab send topic:aws-account-lead/provision --payload '{...}'`. The old `--topic <cat>` continues to be accepted on every send.

The binary is also **mode-aware**: it detects ephemeral context from env (presence of `$MESSAGE_ID` + `$AGENT_TEMPLATE` + `$REPLY_PATH`) and adapts its help text, exposed subcommands, and the system-prompt addendum injected into the engine. Persistent-mode behaviour matches today.

**Common (both modes)**
```
collab send <addr> [--payload <json> | <message>] [--topic <category>] [--in-reply-to <id>]
collab approval create --channel <channel> --payload <json>
collab approval get <id>
collab approval set <id> --state ... [--payload ...]
collab approval withdraw <id>
collab approval await <id>
```

**Ephemeral mode only**
```
collab complete --reply <json>                 # signal success; writes $STATUS_PATH + $REPLY_PATH
collab fail --reason <text>                    # signal failure
```

`collab --help` in ephemeral mode prints a banner: *"You are handling message <id> on topic <template>/<topic>. Call `collab complete --reply '<json>'` when done."* In persistent mode it prints the agent's address and inbox guidance. The system prompt that <code>persona.ts</code> composes also branches on mode: ephemeral agents are told they handle exactly one message and must complete; persistent agents are told they have an ongoing inbox.

## HTTP / WebSocket contract

Existing `/api/agents/send` and `/api/dashboard/send` continue to accept their current request shape; an internal resolver maps `body.to` through address parsing (`agent:` prefix added if bare). They never write prefixed names into `pending_messages.target_agent` — storage continues to use the bare agent name so dashboards, unread counts, reminders, and retries are unaffected.

New endpoints (additive):
- `POST /api/topics/publish` — enqueue a message on a topic address; preferred path for `topic:` sends, used by `collab send` when the address starts with `topic:`.
- `POST /api/approvals` / `GET /api/approvals/:id` / `POST /api/approvals/:id/set` / `POST /api/approvals/:id/withdraw` — approval CRUD.
- `POST /api/instances/:id/complete` — agent completion signal (low-latency wake; reaper is the fallback).

**New WebSocket events** (`WsEvent` additions; pre-existing events untouched):
- `template-updated` — an agent template was added, modified, or removed via reload.
- `topic-queue-changed` — a topic's queue depth changed.
- `instance-spawned` / `instance-completed` / `instance-failed` — ephemeral instance lifecycle.
- `approval-changed` — approval created or transitioned state.

The dashboard subscribes to these to drive the new panels; no new transport is introduced.

## UI deltas
- **Templates & topics** — tree: agent templates → their declared topics. Per-topic: queue depth, recent spawns, last exit code.
- **Approval inbox** — single feed across all approval topics; create / read / update / delete (humans usually only update).

## What we don't own
- Secrets/credentials — script and surface concern
- Knowledge stores — managed independently
- Where the script runs and how — opaque to the orchestrator
- What happens inside the worktree once the script is in charge

## What we don't touch (from 2.x)
- tmux runtime, SQLite WAL, zero-dep, Node 24 native TS
- Message dispatch, cool-down, lifecycle state machine, fire-and-forget send semantics
- Persona file shape (YAML frontmatter + markdown body); existing files default to `persistent: true`
- The `agents` table — schema and state machine unchanged; the scalar field-registry gets no new columns
- Existing tmux-paste `start`/`exit` hook semantics for persistent agents
- Proxy `/command` surface — no new commands; ephemeral lifecycle uses `exec` + `create_session` + paste + `kill_session`
- Health-monitor (30s poll) and cool-down (300ms) remain **persistent-agent concerns only**; ephemeral instances are governed by the orchestrator's instance-reaper instead

## Crash recovery

Ephemeral state lives in the orchestrator DB (`agent_instances`, `topic_queue`), so recovery rules are explicit:

- **Orchestrator restart while instances are live** — on boot, walk `agent_instances` with non-terminal state. For each, first check whether `$STATUS_PATH` is present (agent already signaled but the notification was missed) — if so, process completion as normal. Otherwise ask the proxy `has_session` for the tracked `tmux_session`: if the session is alive, the instance is still running and we just resume waiting for `collab complete`; if the session is gone, the instance died without completing, run the `cleanup` hook (best-effort worktree removal) and mark the instance failed; the originating `topic_queue` row is requeued or marked failed per topic policy.
- **Proxy restart while instances are live** — all sessions on that proxy are gone. On the proxy's next registration heartbeat, the orchestrator marks every live `agent_instances` row on that proxy as failed, runs `cleanup` hooks where the worktree still exists on disk, and requeues their `topic_queue` entries.
- **Agent forgets to call `collab complete`** — a per-instance outer timeout (configurable per topic) trips and the orchestrator treats it as a failure: kill the tmux session, run `cleanup`, requeue or fail.
- **Orphaned worktrees** — the `cleanup` hook owns worktree removal. If it fails or never runs, a periodic sweep checks the on-disk worktree base (`cwd_base`) against live `agent_instances.worktree_path` values and removes the leftovers.
- **Approval mid-flight at restart** — approvals are pure DB state; no recovery needed. Pending approvals just remain pending until a human resolves them.
