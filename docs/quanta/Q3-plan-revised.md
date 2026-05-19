# Q3 · ephemeral lifecycle kernel — revised plan (post-Codex review)

The planner's initial output had **6 blockers** flagged by Codex (outside reviewer, read-only). This document captures the reconciled plan that addresses each. The builder must execute against THIS document, not the original.

## Blocker reconciliations

### B1 — Env injection must use `tmux set-environment` (not inline export)
**Plan-time decision was wrong.** Spec invariants #3 and #4 explicitly assert that `tmux set-environment` calls fire BETWEEN `create_session` and the `start` paste. Inline `export KEY=val; cmd` wrapping breaks both invariants.

**Revised mechanism.** Use the existing `exec` proxy command to dispatch `tmux set-environment -t <session> KEY 'shellQuote(val)'` once per env var. No new proxy commands. The sequence becomes:

```
exec(prepare,  cwd=cwdBase, timeoutMs=60000)
create_session(sessionName, cwd=cwdBase)
exec("tmux set-environment -t <sess> MESSAGE_PATH 'quoted'", timeoutMs=5000)
exec("tmux set-environment -t <sess> REPLY_PATH 'quoted'",    timeoutMs=5000)
... × N for every env var in the contract ...
paste(start)
exec(cleanup, cwd=cwdBase, timeoutMs=60000)   # post-completion
```

The `paste` text is the raw `start` hook string (resolved via `resolveHook` — see B3). Tmux's shell expands `$WORKTREE_PATH` etc. at paste-time from the session env.

### B2 — Orchestrator-side `proxyDispatch` has a hard 15s fetch timeout
**Root cause.** `src/orchestrator/main.ts:88` sets `signal: AbortSignal.timeout(15_000)` on every `/command` POST. The proxy itself respects `command.timeoutMs ?? 5000`, but the orchestrator gives up at 15s regardless — so a real `git worktree add` (which often takes >15s on cold caches) gets killed before the proxy can return.

**Revised mechanism.** Lift the orchestrator-side timeout dynamically based on the command:
```ts
const timeout = command.action === 'exec'
  ? Math.max(15_000, (command.timeoutMs ?? 5_000) + 5_000)
  : 15_000;
signal: AbortSignal.timeout(timeout),
```
The `+5_000` buffer accounts for HTTP round-trip + proxy startup overhead on top of the proxy's own timeout. Q3 builder edits `main.ts` to apply this. **No type / schema change.** All non-`exec` commands keep their 15s ceiling.

### B3 — `start` hook must resolve via `resolveHook`, not be assumed raw
The plan's "wrap raw start string with exports" pattern broke when `start:` is given as a structured hook (`{ shell: "...", env: {...} }`), a `file:` reference, or a pipeline. The existing resolver handles all of these.

**Revised mechanism.** For ephemeral starts, call:
```ts
const result = resolveHook('start', rawStartValue, syntheticAgent, { templateVars });
await dispatchHookResult(ctx, proxyId, tmuxSession, result, { pressEnter: true });
```
where `syntheticAgent` is a minimal `AgentRecord` shim (built from the template) carrying `engine` + `model` so `resolvePreset` works if the template uses `start: null` (preset default). The `templateVars` field is filled with the ephemeral env contract (see B4) so structured-shell hooks can interpolate `$WORKTREE_PATH` etc. at resolution time.

For the bare-string smoke case (`start: |\n  bash "$WORKTREE_PATH/start.sh"\n`), the resolver returns `{ mode: 'paste', text: <raw> }` unchanged (hook-resolver.ts:159). The raw text is pasted; tmux's session-env (set via B1) expands the variable in the shell at paste-time. Both layers work together — interpolation at resolve time for structured hooks, tmux-env for bare-string hooks.

### B4 — Template vars must include the ephemeral env contract
The existing `TemplateVars` (hook-resolver.ts:45-58) has `AGENT_NAME`, `AGENT_CWD`, `SESSION_ID`, `PERSONA_PROMPT`, `PERSONA_PROMPT_FILEPATH`. The `interpolateTemplateVars` at hook-resolver.ts:286 replaces unknown `$VARS` with empty string.

**Revised mechanism.** Extend `TemplateVars` with the ephemeral contract (additive only — no existing field changes):
```ts
export type TemplateVars = {
  // ... existing fields unchanged ...

  // v3 ephemeral lifecycle (populated only for ephemeral spawns).
  MESSAGE_PATH?: string;
  REPLY_PATH?: string;
  STATUS_PATH?: string;
  WORKTREE_PATH?: string;
  CWD_BASE?: string;
  REPO_ROOT?: string;
  AGENT_TEMPLATE?: string;
  TOPIC_NAME?: string;
  MESSAGE_ID?: string;
  INSTANCE_ADDR?: string;
  REPLY_TO_ADDR?: string;
  INSTANCE_ID?: string;
};
```
For shell-quoting, add `WORKTREE_PATH`, `MESSAGE_PATH`, `REPLY_PATH`, `STATUS_PATH`, `CWD_BASE`, `REPO_ROOT` to `SHELL_QUOTE_VARS` (hook-resolver.ts:254) — they're path values that may contain `$` or spaces.

### B5 — Instance-address messages cannot persist via `pending_messages.target_agent`
**Root cause.** `messageDispatcher.tryDeliver(agentName)` (message-dispatcher.ts:73-85) reads via `db.getAgent(agentName)` which queries the `agents` table by primary key. An `agent:<tmpl>/<id>` address would fail that lookup. The spec also forbids prefixed names in `pending_messages.target_agent`.

**Revised mechanism.** Drop the "fallback to pending_messages on sync failure" idea entirely. The new method `messageDispatcher.deliverToInstance(instanceId, envelope)`:
1. Reads `db.getAgentInstance(instanceId)` synchronously.
2. If state is not `running`, returns `{ ok: false, reason: 'instance-not-live' }` — caller decides what to do (likely log + drop).
3. Otherwise dispatches a `paste` to `proxyDispatch(proxyId, { action: 'paste', sessionName: instance.tmuxSession, text: envelope, pressEnter: true })`.
4. On dispatch error, returns `{ ok: false, reason: 'paste-failed', error }` — caller logs + drops. No persistence.

The routes layer maps `parseAddress(body.to).class === 'agent-instance'` → call `deliverToInstance`. On `{ ok: false }`, respond `503` `{ error: 'instance not deliverable', reason }`. **No row written to `pending_messages` for instance-targeted messages.**

This satisfies the smoke's `target_agent NOT LIKE '%:%'` assertion trivially because the table never sees those addresses.

### B6 — Widening `RouteContext` breaks inline test fixtures
**Confirmed.** `RouteContext` is instantiated inline in `routes.test.ts:49-61, 608-620, 714-726, 795-807` and `integration.test.ts:68-79, 378-389`. Adding required fields breaks every fixture.

**Revised mechanism.** Make the two new fields **optional**:
```ts
export type RouteContext = {
  // ... existing fields unchanged ...
  topicDelivery?: TopicDelivery;
  instanceReaper?: InstanceReaper;
};
```
The route handlers for `/api/topics/publish` and `/api/instances/:id/complete` early-return `503 { error: 'topic delivery not configured' }` when the optional field is absent. Production `main.ts` always populates them; test fixtures opt in only where they exercise the new routes.

Tests for the new routes either:
- Construct a minimal `topicDelivery`/`instanceReaper` mock in the test fixture, OR
- Stub via `dependency-injection-friendly` patterns the existing test files use (refer to `routes.test.ts` setup for the pattern).

## Revised file-by-file plan

Same files as the original plan **except**:

### `src/orchestrator/main.ts` (revised — adds dynamic exec timeout)
At `proxyDispatch` (~line 80-89), replace `signal: AbortSignal.timeout(15_000)` with the dynamic-timeout block from B2. Touched lines: ~5.

### `src/orchestrator/topic-delivery.ts` (revised — removes inline-export wrap)
- `buildStartHookWithEnv()` is removed.
- New helper `dispatchTmuxSetEnv(proxyId, sessionName, env)`: iterates env keys, dispatches `{ action: 'exec', command: \`tmux set-environment -t '${sessionName}' '${key}' ${shellQuote(value)}\`, timeoutMs: 5_000 }` once per key. Use `shellQuote` on both the session name (validated to NAME_RE so quote is safe) and the value.
- After `create_session`, call `dispatchTmuxSetEnv`. Then build `syntheticAgent` (template's engine + model + minimal AgentRecord shim), call `resolveHook('start', template.hook_start, syntheticAgent, { templateVars: env })`, then `dispatchHookResult(ctx, proxyId, sessionName, result, { pressEnter: true })`.

### `src/orchestrator/hook-resolver.ts` (revised — TemplateVars extension)
Add the v3 fields to `TemplateVars` per B4. Add the v3 path-fields to `SHELL_QUOTE_VARS`. ~15 LOC.

### `src/orchestrator/message-dispatcher.ts` (revised — strict sync-or-drop)
`deliverToInstance(id, envelope)` returns `{ ok, reason?, error? }` instead of throwing. Never persists. ~30 LOC.

### `src/orchestrator/routes.ts` (revised — optional context fields)
- `RouteContext.topicDelivery?` and `RouteContext.instanceReaper?` are optional.
- The new endpoints early-return 503 when undefined.
- Existing handlers `/api/agents/send` and `/api/dashboard/send` get the `topic:` branch wired only if `ctx.topicDelivery` is present; otherwise continue returning 503 (lets test fixtures that don't construct the delivery still pass).

All other files (`database.ts`, `instance-reaper.ts`, `instance-env.ts`, `lifecycle.ts`, `health-monitor.ts`, `bin/collab`) carry over from the original plan unchanged.

## Updated delivery sequence

```
1.  BEGIN IMMEDIATE
    UPDATE topic_queue SET status='claimed' ... RETURNING *  (atomic)
    INSERT INTO agent_instances (state='spawning', ...)
    COMMIT
2.  Allocate IPC paths under ${IPC_ROOT}/<instanceId>/. Write message,
    touch reply+status.
3.  exec(prepareWrapped, cwd=cwdBase, timeoutMs=60_000)
       — prepareWrapped is interpolated via TemplateVars at the orchestrator
       — orchestrator-side proxyDispatch timeout = 65_000 (60_000 + 5_000)
4.  create_session(sessionName, cwd=cwdBase)
5.  For each key in env contract:
       exec("tmux set-environment -t <sess> KEY <quoted-value>", timeoutMs=5_000)
6.  result = resolveHook('start', template.hook_start, syntheticAgent, { templateVars: env })
    dispatchHookResult(ctx, proxyId, sessionName, result, { pressEnter: true })
    db.updateInstanceState(id, 'running')
7.  (asynchronously) reaper sweeps every 1500ms; agent calls collab complete;
    POST /api/instances/:id/complete wakes reaper for that id.
8.  tryFinalize(row):
       readFileSync(statusPath) — empty ⇒ in-progress, return
       readFileSync(replyPath)
       db.updateInstanceState(id, 'completing')
       db.enqueueMessage({ targetAgent: row.replyToAddr /* BARE */, envelope })
       messageDispatcher.tryDeliver(row.replyToAddr)
9.     proxyDispatch({ action: 'kill_session', sessionName })
10.    exec(cleanupWrapped, cwd=cwdBase, timeoutMs=60_000)
       — errors here are logged but don't fail the completion
11.    db.updateInstanceState(id, 'completed', { completedAt, status })
       db.markTopicQueueCompleted(queueId, 'completed')
       topicDelivery.tryDispatch(template, topic)  // drain next
```

## Updated ordering invariants

Same 11 invariants. Two clarifications:

- **#3 (sequence assertion).** The assertion now allows `exec(tmux set-environment …)` calls between `create_session` and `paste(start)`. The test captures the proxy-dispatch sequence and asserts:
  ```
  [
    { action: 'exec', command: matches /^.*\bprepare\b.*$/, timeoutMs: 60000 },
    { action: 'create_session', cwd: <cwdBase> },
    { action: 'exec', command: startsWith('tmux set-environment') }, // ≥1, in any order
    ...
    { action: 'paste', sessionName: <matches>, pressEnter: true }
  ]
  ```
  The middle `exec(tmux set-environment)` block must contain at least one entry per env-contract key, all positioned **before** the first `paste`.

- **#4 (set-environment before paste).** Test asserts every `tmux set-environment` exec command's index in the sequence is < the first `paste`'s index.

## Updated LOC estimate

| Bucket | Original | Revised |
|---|---:|---:|
| `topic-delivery.ts` | 220 | 230 |
| `instance-reaper.ts` | 180 | 180 |
| `instance-env.ts` | 60 | 60 |
| `database.ts` | 130 | 130 |
| `routes.ts` (3 endpoints + optional fields) | 90 | 100 |
| `main.ts` (timeout fix + wiring) | 20 | 30 |
| `hook-resolver.ts` (TemplateVars + quote set) | 0 | 15 |
| `message-dispatcher.ts` (sync-or-drop) | 30 | 30 |
| `bin/collab` | 70 | 70 |
| `types.ts` | 30 | 30 |
| Tests | 420 | 450 |
| **Total** | ~850 | ~875 |

Still over the 400-LOC stop-and-ask threshold; deviation already logged in `docs/v3-progress.md`.

## Test edits required for `RouteContext` optionality

The existing inline `RouteContext` fixtures in tests do NOT need updates — `topicDelivery` and `instanceReaper` are optional, so old fixtures that omit them compile clean. New tests for `/api/topics/publish` and `/api/instances/:id/complete` create fixtures that DO provide the delivery + reaper (mocked).
