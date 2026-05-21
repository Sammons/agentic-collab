# agentic-collab 3.0 — UI wireframes (Q9, deferred)

Wireframes for the two dashboard panels left out of the one-shot v3 run. The kernel + APIs + WebSocket events are already in place on `main` (PR #257 merged at `3d7d92e`); this doc designs the consumer-side rendering.

- **Spec**: `docs/v3-vision.md` §"UI deltas"
- **Available data**: REST + WS events listed under each panel below
- **Existing dashboard**: `src/dashboard/index.html` — two-pane layout (left sidebar = agent list + filter chips; right pane = thread / persona / reminder / watch / files / settings, swap-in)

The new work adds **two views** that live in the same dashboard, accessible via a top-of-sidebar **view toggle**. The existing `Agents` view is unchanged.

---

## Sidebar view toggle

The toggle sits above today's `Filter agents...` search box. Three modes; the rest of the sidebar swaps to match.

```
┌──────────────────────────────────────┐
│ [ Agents ] [ Templates ] [ Approvals ]│  ← new: 3-segment toggle
│ ──────────                            │
│ 🔍 Filter ...                        │  ← swap: agent search OR template search OR
│                                       │           approval channel filter
│ [chip] [chip] [chip]                  │  ← swap: filter chips per view
│                                       │
│ <list contents>                       │  ← swap: agents | templates | approvals
└──────────────────────────────────────┘
```

WS events drive the toggle's badge counts:
- **Agents** — existing unread count.
- **Templates** — sum of `topic_queue` depths across all templates. Source: aggregate of `topic_queue_changed` events.
- **Approvals** — count where `state = 'pending'`. Source: `approval_changed` events + initial `GET /api/approvals?state=pending`.

---

## Panel A — Templates & Topics

### Sidebar (Templates view active)

Tree of templates → topics. Each template node is collapsible. Topics show queue depth as an inline badge; the badge colour reflects the most-recent instance state (green = completed, red = failed, orange = running).

```
┌────────────────────────────────────────────────────────────────┐
│ [ Agents ] [▼ Templates ] [ Approvals ]                        │
│ ──────────                                                       │
│ 🔍 Filter templates...                                          │
│                                                                  │
│ [ All ] [ Ephemeral ] [ Persistent ] [ Has-queue ]              │
│                                                                  │
│ ▼ aws-account-lead       persistent: false   2 topics           │
│   ├─ ▣ provision         q:3 🟢   conc:1   monitor: aws-acct…  │
│   └─ ▣ teardown          q:0 ⚪   conc:1                        │
│                                                                  │
│ ▼ test-echo              persistent: false   1 topic            │
│   └─ ▣ echo              q:0 🟢   conc:1                        │
│                                                                  │
│ ▶ gitea-lead             persistent: true    (no topics)        │
│                                                                  │
│ ▶ orchestrator-watch     persistent: true    (no topics)        │
│                                                                  │
│ ──────────                                                       │
│ 11 templates · 4 ephemeral · 3 queued                            │
└────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- Initial list: `GET /api/templates` (NEW route Q9 must add — small additive endpoint that reads `agent_templates` + joins `topics`).
- Live updates: `template_updated`, `topic_queue_changed`.
- Filter chips: client-side filter on the loaded list.

### Main pane — topic detail (when a topic is selected)

```
┌────────────────────────────────────────────────────────────────────────┐
│ topic:aws-account-lead/provision                            queue: 3 🟠 │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                          │
│ ┌── Stats (last 24h) ──────────────────────────────────────────────────┐│
│ │  spawned: 17     completed: 12     failed: 2     running: 3         ││
│ │  median runtime: 4m12s     p95 runtime: 11m02s                       ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌── Live queue (3 items) ─────────────────────────────────────────────┐│
│ │ #q-4019  payload: {"region":"us-east-1"...}  reply: gitea-lead      ││
│ │ #q-4021  payload: {"region":"eu-west-2"...}  reply: gitea-lead      ││
│ │ #q-4023  payload: {"region":"ap-south-1"…}   reply: dashboard       ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌── Recent instances ────────────────────────────────────────────────┐│
│ │ instance         state       started        completed   exit       ││
│ │ ──────────────   ─────────   ──────────     ──────────  ────       ││
│ │ a7c2b1…3f       🟠 running   2m ago         —          —          ││
│ │ b8d3c2…ee       🟢 ok        14m ago        9m ago     ok         ││
│ │ c9e4d3…77       🔴 failed    1h ago         42m ago    error      ││
│ │ ...                                                                  ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌── Config ──────────────────────────────────────────────────────────┐│
│ │ concurrency: 1      monitor_template: aws-account-monitor          ││
│ │ schema: ./schemas/provision.json                                    ││
│ │ reply_schema: ./schemas/provision-reply.json                        ││
│ │ cwd_base: /var/agentic/work/aws-account-lead                       ││
│ │ start: bash $WORKTREE_PATH/start.sh                                ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ Actions: [ Pause queue ] [ Drain queue ] [ Reload template ]            │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- Stats: `GET /api/topics/:template/:name/stats` (NEW endpoint Q9 must add — `SELECT count(*), avg(...), percentile_disc(...) FROM agent_instances WHERE agent_template=? AND spawned_from_topic=?`).
- Live queue: `GET /api/topics/:template/:name/queue?status=queued`.
- Recent instances: `GET /api/agent-instances?agent_template=…&spawned_from_topic=…&limit=20&order=desc`.
- Live updates: `topic_queue_changed`, `instance_spawned`, `instance_completed`, `instance_failed`.
- **Actions are NEW endpoints** — pause/drain/reload are out-of-scope for the immediate render; ship the read-only view first, then layer mutations.

### Main pane — instance detail (drill-down from a row above)

```
┌────────────────────────────────────────────────────────────────────────┐
│ agent:aws-account-lead/a7c2b1…3f          🟠 running          [ ↻ ]   │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                          │
│ template: aws-account-lead       spawned: 2m ago      proxy: mac-mini  │
│ reply_to: gitea-lead             queue_id: 4019      message_id: m-…  │
│                                                                          │
│ ┌── tmux pane ───────────────────────────────────────────────────────┐│
│ │  $ cd /var/agentic/work/aws-account-lead/wt-m-7d3a                  ││
│ │  $ aws sts get-caller-identity                                       ││
│ │  {                                                                   ││
│ │    "UserId": "...",                                                  ││
│ │    "Account": "123456789012",                                        ││
│ │    "Arn": "arn:aws:iam::..."                                        ││
│ │  }                                                                   ││
│ │  $ ▮                                                                 ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌── IPC files ───────────────────────────────────────────────────────┐│
│ │ MESSAGE_PATH:  /run/agentic-collab/ipc/a7c2b1…3f/message.json      ││
│ │ REPLY_PATH:    /run/agentic-collab/ipc/a7c2b1…3f/reply.json   (empty)││
│ │ STATUS_PATH:   /run/agentic-collab/ipc/a7c2b1…3f/status.txt  (empty)││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌── Env contract ────────────────────────────────────────────────────┐│
│ │ WORKTREE_PATH:   /var/agentic/work/aws-account-lead/wt-m-7d3a       ││
│ │ CWD_BASE:        /var/agentic/work/aws-account-lead                 ││
│ │ REPO_ROOT:       /var/agentic/work/aws-account-lead                 ││
│ │ AGENT_TEMPLATE:  aws-account-lead                                   ││
│ │ TOPIC_NAME:      provision                                          ││
│ │ INSTANCE_ADDR:   agent:aws-account-lead/a7c2b1…3f                  ││
│ │ REPLY_TO_ADDR:   gitea-lead                                         ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ Actions: [ Fail (force) ] [ Re-paste start ] [ Send message ]          │
└────────────────────────────────────────────────────────────────────────┘
```

The `Send message` button opens the existing message-input component but targets the instance address — mid-run paste, per Q3 invariant #10.

---

## Panel B — Approval Inbox

### Sidebar (Approvals view active)

Flat feed across all channels by default; channel-filter is a chip row, state-filter a second chip row. Pending approvals sort to the top; terminal states age out below.

```
┌────────────────────────────────────────────────────────────────┐
│ [ Agents ] [ Templates ] [▼ Approvals ]                        │
│ ──────────                                                       │
│ 🔍 Filter by id, channel, requester...                          │
│                                                                  │
│ Channel: [ All ] [ aws-account-provision ] [ stripe-refund ]    │
│          [ deploy-prod ] [ +2 more ]                            │
│ State:   [ Pending 🟠 ] [ Approved 🟢 ] [ Rejected 🔴 ] [ All ] │
│                                                                  │
│ ──────────                                                       │
│                                                                  │
│ 🟠 a3f1…8b   aws-account-provision    gitea-lead       2m       │
│ 🟠 b7c2…1d   stripe-refund            agent:billing/i…  8m      │
│ 🟠 c4e5…9a   deploy-prod              dashboard         34m     │
│                                                                  │
│ ──────────                                                       │
│                                                                  │
│ 🟢 d8f6…2c   aws-account-provision    gitea-lead       1h      │
│ 🔴 e2a3…7e   stripe-refund            agent:billing/i…  3h      │
│ 🟢 f1b9…4d   aws-account-provision    gitea-lead       6h      │
│                                                                  │
│ ──────────                                                       │
│ 47 approvals · 3 pending                                         │
└────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- Initial list: `GET /api/approvals?state=pending` (default) — fixed in Q5 to support cross-channel listing.
- Channel chips: derived from `DISTINCT channel` over the loaded list.
- Live updates: `approval_changed` WS event.

### Main pane — approval detail

```
┌────────────────────────────────────────────────────────────────────────┐
│ approval:aws-account-provision/a3f1…8b           🟠 pending            │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                          │
│ Requester: agent:gitea-lead                                             │
│ Created:   2026-05-19T14:23:11Z (2m ago)                                │
│ Updated:   2026-05-19T14:23:11Z                                         │
│                                                                          │
│ ┌── Payload ─────────────────────────────────────────────────────────┐│
│ │ {                                                                   ││
│ │   "region": "us-east-1",                                            ││
│ │   "purpose": "staging environment for q3-features",                ││
│ │   "budget_usd_per_month": 250,                                      ││
│ │   "tags": { "team": "platform", "cost_center": "eng-infra" }       ││
│ │ }                                                                   ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌── Timeline ────────────────────────────────────────────────────────┐│
│ │ 14:23:11  created     by gitea-lead                                 ││
│ │ —         (no further events yet)                                   ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ Actions (state machine: pending → approved | rejected | amended):       │
│                                                                          │
│   [ ✓ Approve ]    [ ✗ Reject ]    [ ✎ Amend... ]    [ ⊘ Withdraw ]   │
│                                                                          │
│   Decided-by:  sammons (current user)                                   │
│                                                                          │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                          │
│ Once decided, the requester receives an auto-notify message via the     │
│ existing dispatcher: "Approval <id> updated: <state>. Run                │
│ `collab approval get <id>` for details."                                │
└────────────────────────────────────────────────────────────────────────┘
```

**Amend modal** (overlays the detail pane when ✎ Amend is clicked):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Amend approval a3f1…8b                                          [✕]    │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                          │
│ State transitions to `amended` and a new payload version is recorded.   │
│ Q5's server REJECTS amend without a payload — the textarea below is     │
│ required.                                                                │
│                                                                          │
│ Original payload (read-only):                                            │
│ ┌─────────────────────────────────────────────────────────────────────┐│
│ │ {                                                                    ││
│ │   "region": "us-east-1",                                             ││
│ │   "budget_usd_per_month": 250,                                       ││
│ │   ...                                                                ││
│ │ }                                                                    ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ Amended payload (JSON, validated client-side):                           │
│ ┌─────────────────────────────────────────────────────────────────────┐│
│ │ {                                                                    ││
│ │   "region": "us-east-1",                                             ││
│ │   "budget_usd_per_month": 100,    ← human edits inline               ││
│ │   ...                                                                ││
│ │ }                                                                    ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ Optional comment for the requester (free text):                          │
│ [_________________________________________________________________]    │
│                                                                          │
│                                          [ Cancel ]    [ Submit amend ] │
└────────────────────────────────────────────────────────────────────────┘
```

### Withdraw rules

`Withdraw` is only enabled when:
- Current user is the original requester (matched by `requester_addr === currentSenderAddress()`).
- State is `pending`.

Otherwise the button shows a disabled tooltip: `Only the creator can withdraw, and only while pending`.

---

## Real-time wiring (consumer-side)

Existing `WebSocketServer` already broadcasts JSON. Q4 added typed events. Q9 dashboard subscribes:

```js
on('template_updated',    (ev) => templateStore.applyUpdate(ev));
on('topic_queue_changed', (ev) => topicQueueStore.applyDepth(ev));
on('instance_spawned',    (ev) => instanceStore.add(ev.instance));
on('instance_completed',  (ev) => instanceStore.update(ev.instance));
on('instance_failed',     (ev) => instanceStore.update(ev.instance));
on('approval_changed',    (ev) => approvalStore.refetch(ev.approvalId));
```

A single shared `state.ts` module (precedent: existing `agent_update` and `queue_update` events) absorbs these. The visible badge counts re-render reactively. The toggle's segment counts compute from the same stores.

---

## API additions needed (out of scope for one-shot; required for Q9)

Additive only — none of these change existing routes.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/templates` | Sidebar tree: returns all `agent_templates` rows + joined `topics` array per template |
| GET | `/api/topics/:template/:name/queue` | Live queue rows for the topic-detail view |
| GET | `/api/topics/:template/:name/stats` | Aggregate counts + percentiles for the topic-detail "Stats" panel |
| GET | `/api/agent-instances` | Filtered list (template, topic, state, limit, order) — for "Recent instances" |
| GET | `/api/agent-instances/:id` | Single-instance detail — env contract, IPC paths, etc. |
| POST | `/api/agent-instances/:id/fail` | "Fail (force)" button — orchestrator-driven failure injection |
| POST | `/api/topics/:template/:name/pause` | Pause-queue button (sets a flag the dispatcher respects) |
| POST | `/api/topics/:template/:name/drain` | Drain-queue (refuse new publishes; finish in-flight) |

`/api/approvals*` are already in place (Q5).

---

## Layout integration with the existing dashboard

The existing two-pane shell stays:

```
┌──────────────────┬──────────────────────────────────────────────────────┐
│ SIDEBAR          │ MAIN PANE                                              │
│ (existing class:│ (existing class: thread-panel — swap-in)              │
│  agent-list)    │                                                         │
│                  │   default: thread-messages                            │
│  swap-in:        │                                                         │
│   - agents       │   swap-in:                                            │
│   - templates    │     - thread-messages (existing)                      │
│   - approvals    │     - topic-detail   ← new (Q9)                       │
│                  │     - instance-detail ← new (Q9)                      │
│                  │     - approval-detail ← new (Q9)                      │
│                  │     - persona / reminder / watch / files (existing)   │
└──────────────────┴──────────────────────────────────────────────────────┘
```

Three new components, ~300 LOC each in vanilla TS following the existing pattern (`agent-list.ts`, `thread.ts`, `persona-editor.ts`). The view-toggle is one small additive component above the existing `agent-search` block.

---

## What this doc is NOT

- **Not an implementation plan.** It's a wireframe. Q9 itself needs its own quantum-style plan with file-by-file edits, tests, and BC-invariant gates. The "API additions needed" section above is the spec for those routes.
- **Not pixel-perfect.** ASCII boxes are illustrative; actual layout is governed by `src/dashboard/styles/*.css`.
- **Not interactive specs for keyboard shortcuts, accessibility, or i18n.** Those land in Q9's plan once this wireframe is accepted.

---

## Companion visual

`docs/v3-wireframes.html` renders these mocks in the same dark palette as `v3-vision.html` and `v3-progress.html`. Open in a browser for the styled side-by-side view.
