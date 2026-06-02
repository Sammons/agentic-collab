# RFC-007: Full-Page Persona Editor + Pre-Expansion CLI Command Preview

**Status:** Draft
**Author:** agentic-collab-lead
**Created:** 2026-06-02
**Epic:** Dashboard 3.0 (Notion: Dashboard 3.0 status/CX fixes + full-page persona editor)

## Problem

Two operator asks, one home:

1. **Persona editing is a cramped modal.** Today `openEditPersonaModal()` (`src/dashboard/overlays.ts`) opens the structured persona editor (RFC-005 core fields + verbatim passthrough + body) in an overlay. The body and a command preview have no room. Operator (firm feedback): *"persona editing deserves not to be a modal, it should have its own path and full page real estate."*

2. **No way to see the actual command a persona produces.** Operators can't tell what will actually be pasted into tmux when an agent spawns: which env is exported (`COLLAB_AGENT`, `COLLAB_PERSONA_FILE`, `HOME`/account, launch env), which engine flags, and the full **collab injection** (the composed system prompt — messaging instructions, collab CLI reference, peers, visibility note, lifecycle addendum). Operator: *"preview the full pre-expansion CLI command that'll come from the persona; including all of the collab injection but leaving the persona variable for example."*

"Leaving the persona variable" is the key insight: the operator is *editing* the persona body, so the preview should show everything that wraps around it with the **body itself replaced by a placeholder** (`«PERSONA»`), not expanded inline.

## Goals

- Persona editing becomes its own full-page route (`#/persona/:name`) with full real estate; the modal is retired (or reduced to a launcher that navigates to the route).
- A **faithful** pre-expansion CLI command preview on that page: the exact string that would be pasted at spawn, with the persona body shown as the literal token `«PERSONA»`.
- Faithful **by construction** — the preview reuses the real spawn-path builders, never a reimplementation, so it cannot drift from what actually spawns.
- Preview reflects the **current editor state** (unsaved edits to engine/model/thinking/permissions/account/hooks/env), since a preview that ignores your edits is a footgun.

## Non-Goals

- No change to the 3-phase locking or any side-effecting spawn behavior.
- No new runtime dependency.
- No change to the JSON-lines `agentvm` protocol or persona frontmatter schema.
- Not building a "spawn from this page" button beyond what already exists.
- Codex profile contents / OpenCode are previewed at the command level only (see Engine Handling); we annotate where the persona lands per engine rather than emulating each engine's full delivery.

## Background: how the command is built today (spawn path)

`spawnAgent()` Phase 2 (`src/orchestrator/lifecycle.ts`) builds the launch command in three already-separated, side-effect-free steps, then dispatches it:

1. `buildSystemPrompt(ctx, name, peers, persona)` → loads the persona body and calls `composeSystemPrompt({ personaContent, agentName, orchestratorHost, peers })`. The body is inserted at the top (`persona.ts:1285`), then ALL collab injection is appended.
2. `resolveHook('start', hookStart, effectiveCurrent, { spawnOpts: { appendSystemPrompt: systemPrompt, ... }, templateVars: { PERSONA_PROMPT: systemPrompt, ... } })` → for the preset hook, calls the engine adapter's `buildSpawnCommand(spawnOpts)` (e.g. `claude --append-system-prompt '<systemPrompt>' ...`); for a shell hook, interpolates `$PERSONA_PROMPT`. **`resolveHook` is pure** (no proxy dispatch; the only I/O is a read-only `resolveFile` for `file:` hooks).
3. `wrapLaunchResult(startResult, effectiveCurrent, personaFile, accountHome)` → `withLaunchEnv` prepends `export COLLAB_AGENT=… COLLAB_PERSONA_FILE=… [HOME=…] [launchEnv…] && <cmd>`.

The side effects (tmux session create, codex profile write, account HOME scaffolding, proxy paste) live in *other* Phase-2 calls (`createSessionAndWriteProfile`, `scaffoldAgentHome`, `dispatchHookResult`) — NOT in the three string-building steps above.

## Solution

### 1. Backend: extract a pure `assembleLaunchCommand`

Refactor the three pure string-building steps out of `spawnAgent` into one shared helper (behavior-preserving — locking and side-effect ordering in `spawnAgent` are untouched):

The helper takes the **already-composed `systemPrompt`** (NOT `personaContent`). This is deliberate (review S1): in `spawnAgent` the composed prompt is also consumed by the side-effecting codex profile write (`createSessionAndWriteProfile`), so we keep spawn's single `buildSystemPrompt` call and pass its result into both consumers — no double-compute, and the codex profile and the inline command are guaranteed to use the *same* prompt.

```ts
// lifecycle.ts (or a new launch-command.ts)
export function assembleLaunchCommand(opts: {
  agent: AgentRecord;            // effective config (post resolveEffectiveConfig)
  systemPrompt: string;          // composed once by caller: real body for spawn; «PERSONA»-bodied for preview
  personaFile: string;
  accountHome?: string;          // resolved by caller (spawn scaffolds; preview passes a token/none)
  sessionId: string;             // randomUUID() for spawn; a fixed sample for preview
  model?: string; thinking?: string; task?: string;
}): HookResult /* {mode:'paste', text} | pipeline | ... */ {
  const startResult = resolveHook('start', opts.agent.hookStart, opts.agent, {
    spawnOpts: { name: opts.agent.name, cwd: opts.agent.cwd, model: opts.model,
      thinking: opts.thinking, task: opts.task, appendSystemPrompt: opts.systemPrompt,
      dangerouslySkipPermissions: opts.agent.permissions === 'skip', sessionId: opts.sessionId },
    templateVars: { AGENT_NAME: opts.agent.name, AGENT_CWD: opts.agent.cwd,
      SESSION_ID: opts.sessionId, PERSONA_PROMPT: opts.systemPrompt,
      PERSONA_PROMPT_FILEPATH: opts.personaFile, capturedVars: opts.agent.capturedVars ?? undefined },
  });
  return wrapLaunchResult(startResult, opts.agent, opts.personaFile, opts.accountHome);
}
```

`spawnAgent` composes the prompt once (`buildSystemPrompt`), passes it to the codex profile write AND to `assembleLaunchCommand`, with scaffolded `accountHome` + `randomUUID()`; the rest of Phase 2 (session create, dispatch) is unchanged. The preview composes `composeSystemPrompt({ personaContent: '«PERSONA»', … })` and passes that. Zero behavior change for spawn — proven by existing spawn tests staying green plus a parity test asserting the assembled command is byte-identical to today's inlined output (including the codex-profile prompt).

### 2. Backend: preview endpoint

`POST /api/personas/:name/launch-preview` (Bearer-auth like the rest), body optional:

```jsonc
{ "fields": { "engine": "...", "model": "...", ... }, "passthroughRaw": "..." }  // current editor frontmatter; omitted → use saved persona on disk
```

Handler:
1. Build the frontmatter to preview: if the body carries edited `fields`/`passthroughRaw`, reconstruct frontmatter and parse it; else load the saved persona file. **Reuse `buildUpsertOptsFromFrontmatter(name, fm)`** (`field-registry.ts`) — the *same* mapping the create/sync path uses — to produce the agent config fields. Layer engine-config defaults via `resolveEffectiveConfig` exactly as spawn does. This guarantees the preview's engine/model/permissions/hooks/account/env match what a real spawn would resolve.
2. Construct a synthetic `AgentRecord` from those fields (name + config + a dummy non-runtime state). NO DB write.
3. `personaContent = '«PERSONA»'` (the placeholder). `personaFile = resolvePersonaFilePath(name, ...)`. `sessionId = '«SESSION_ID»'` or a fixed sample UUID (documented as illustrative). `accountHome`: if the persona declares an `account`, show `HOME='«account-home:<account>»'` **without** scaffolding (side-effect-free); else omit.
4. `const result = assembleLaunchCommand({...})`.
5. Return `{ command: result.text /* or pipeline rendering */, engine, hookKind: 'preset'|'shell'|'pipeline', personaPlaceholder: '«PERSONA»', notes: [...] }`.

No tmux, no profile write, no scaffolding, no proxy, no DB mutation — strictly pure read + string build.

### 3. Engine handling (where the persona lands)

- **claude / claude-with-home**: persona is inline in `--append-system-prompt '«PERSONA»\n---\n<collab injection…>'`. The whole composed prompt (placeholder + scaffolding) is shell-quoted as one unit — exactly faithful.
- **codex**: the system prompt is written to a config profile at spawn, not inline; the command uses `-p <name>`. Preview shows the command AND a secondary "codex profile (written at spawn)" block containing the composed prompt with `«PERSONA»`, annotated.
- **opencode**: ignores the system prompt; preview shows the command and annotates that the persona is not injected via flag for this engine.

### 4. Frontend: full-page route

- New route `#/persona/:name` (`routing.ts`) → a new `persona.ts` page module rendering the RFC-005 structured editor (core fields, gated fields, passthrough, body) at full width, PLUS a "Launch command preview" panel.
- Retire the modal: `openEditPersonaModal()` callers (`agents.ts` row menu, `watch.ts` header "Persona" button) navigate to `#/persona/:name` instead. Keep a thin shim if needed during transition.
- Preview panel: a `<pre>` styled like `.watch-pane`/`.ov-textarea` (Greenroom mono), with the `«PERSONA»` token visually highlighted and a "Copy" button. Re-fetch the preview (debounced) when relevant fields change (engine/model/thinking/permissions/account/hooks/env), so it tracks unsaved edits.
- Additive only: no WebSocket schema change; does not touch the agent state-machine display.

## Decomposition (DAG)

- **PR-A (backend):** extract `assembleLaunchCommand`; refactor `spawnAgent` to use it (behavior-preserving) + parity test. Add `POST /api/personas/:name/launch-preview` + tests (per engine, with/without edited frontmatter, account placeholder, shell-hook interpolation, multi-engine). No frontend.
- **PR-B (frontend rehome):** full-page `#/persona/:name` route hosting the existing editor; repoint callers; retire/shrink the modal. Visual proof.
- **PR-C (frontend preview):** the preview panel on the persona page, wired to the PR-A endpoint, live on edits. Visual proof.

PR-A is independent and lands first. PR-B and PR-C are frontend; PR-C depends on PR-A + PR-B.

## Constraints honored

- **Zero-dep:** pure refactor + one endpoint + vanilla-TS page. No new dependency.
- **3-phase locking:** untouched. `assembleLaunchCommand` is the *pure* portion only; the lock phases, watchdog, and side-effect ordering in `spawnAgent` are unchanged. PR-A includes a test proving the assembled command is byte-identical to today's for the spawn inputs.
- **Persona frontmatter schema:** unchanged. The preview reuses the existing parser + `buildUpsertOptsFromFrontmatter`.
- **agentvm JSON-lines:** untouched.
- **Dashboard:** additive; state-machine display untouched; visual proof on pages.tail4ea214.ts.net per the quality bar.

## Risks / adversarial points

- **Drift:** the whole value is fidelity. Mitigation: ONE shared `assembleLaunchCommand` for both spawn and preview; a parity test pinning spawn output. If a reviewer can construct inputs where preview ≠ spawn (modulo the deliberately-substituted body/sessionId/accountHome), that's a blocker.
- **Side-effect leakage:** preview must never scaffold HOME, write a codex profile, create a tmux session, dispatch, or write the DB. Reviewer must confirm none of those are reachable from the endpoint.
- **Secret exposure:** the command includes env values + the full collab injection. Same Bearer-auth exposure surface as the existing `peek`/persona endpoints; acceptable. Confirm no account *credentials* leak (we show a `«account-home:…»` token, not real secret paths/values).
- **Editor-frontmatter → agent mapping divergence:** must reuse `buildUpsertOptsFromFrontmatter` (not a parallel mapping) so the preview's resolved config matches spawn.
- **Placeholder collisions:** `«PERSONA»` (guillemets) is chosen to be visually distinct and shell-safe inside the single-quoted `--append-system-prompt '…'`. It is not a real shell/template token, avoiding confusion with the existing `$PERSONA_PROMPT` hook var (which is the *whole* prompt, not the body).

## Review resolutions (adversarial pass, 2026-06-02)

Verdict: sound to implement with changes. No fatal flaw. Resolutions:

- **S1 (extraction boundary):** `assembleLaunchCommand` takes the precomputed `systemPrompt` (see updated signature), because spawn also feeds that prompt to the side-effecting codex profile write. No double-compute; spawn keeps its single `buildSystemPrompt` call.
- **S2 (hook throws):** `file:` hooks `readFileSync` (throw if missing) and `preset:`/`{preset}` call `getAdapter` (throw on unknown engine). The preview endpoint wraps `assembleLaunchCommand` in try/catch and returns `{ error, notes }` (HTTP 200 with an error field, or 422) instead of 500 — a half-typed hook during live editing must degrade gracefully, not crash the preview.
- **S3 (hook serialization):** the synthetic `AgentRecord` stores hooks as the **serialized strings** `buildUpsertOptsFromFrontmatter`/`serializeHookValue` produce (matching the DB columns and `AgentRecord.hookStart: string|null`). Parity test includes a structured-hook persona and a pipeline-hook persona.
- **S4 (custom engine — HIGHEST RISK, PR-A gate):** the preview MUST call `ctx.db.getEngineConfig(<frontmatter engine>)` + `resolveEffectiveConfig` exactly as `spawnAgent` (lifecycle.ts:496-497), so engine-config-level hooks survive. A `claude-with-home` parity test (proving `--add-dir /…/claude-home`, which lives in engine_configs `hook_start`, appears in the preview) is a **required PR-A gate** — this is the operator's own primary engine; dropping it = a silent lie.
- **S5 (per-spawn overrides):** preview = "default spawn, no ad-hoc overrides." Ad-hoc `task`/`cwd`/`model` passed to `/spawn` are not shown. Stated in the preview UI ("default spawn") and `notes`.
- **S6 (accountHome):** the real value is the deterministic `join(agentHomesDir, agentName)`, and the `HOME=` clause's *presence* depends on the account having credentials (`scaffoldAgentHome` → null otherwise). Preview shows the deterministic path with a "(scaffolded at spawn; present only if the account resolves)" note rather than a fully opaque token, and does NOT check/leak credentials.
- **S7 (peers snapshot):** `composeSystemPrompt` embeds `Known peers:` from live DB state (`computePeers`). Preview shows a point-in-time snapshot; annotated as "live at spawn time."
- **S8 (unsaved-edit reconstruction):** the unsaved path MUST reuse the *identical* frontmatter reconstruction as `PUT /api/personas/:name` (routes.ts ~2086-2092: `serializeCore(fields) + passthroughRaw`). Factor that into a shared helper used by both PUT and the preview, so "preview" and "save-then-spawn" cannot disagree.
- **S9 (auth/rate-limit):** ship the **saved** preview as `GET /api/personas/:name/launch-preview` (Bearer-exempt, consistent with the other persona GETs, no rate-limit pressure). The **unsaved** live-edit preview is `POST …/launch-preview` with `{fields, passthroughRaw}`, exempted from the strict POST rate limit (it is read-only/side-effect-free) and hard-debounced ≥500ms client-side. Add the `persona` kind to the `Route` union and `go()`; repoint ALL FOUR `openEditPersonaModal` call sites (agents.ts:201, agents.ts:263, watch.ts:261) plus keep a thin shim until PR-C lands.

Revised PR-A scope: shared `assembleLaunchCommand` + spawn refactor + parity tests (incl. **custom-engine** and **structured/pipeline-hook** cases) + `GET …/launch-preview` (saved persona). PR-C adds the `POST` unsaved path (shared reconstruction helper) + the frontend panel.
