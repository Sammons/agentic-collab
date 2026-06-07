# RFC-008: Per-Agent Telegram Bots (persona-configured)

**Status:** Draft — secrets decided 2026-06-06 (token AES-256-GCM-encrypted in SQLite; see §2)
**Author:** agentic-collab-lead
**Created:** 2026-06-06
**Supersedes/absorbs:** `docs/rfc-telegram-per-bot-config.md` (the destinations-table variant — its multi-bot polling design is reused here; its config-location is replaced)

## Problem

Telegram is configured platform-wide today: one bot, configured in the `destinations` table, single polling loop (`TelegramDispatcher` has one `pollingAbort`/`lastUpdateId`; `startPolling(botToken, onMessage)` kills any prior loop — `telegram.ts:18,60`). Inbound messages route by `@agent` prefix, else land in a virtual `telegram` dashboard thread (`routes.ts:startTelegramPolling`). Operators want **each agent to be its own Telegram bot**, configured **in that agent's persona**, so e.g. messaging `@AlmanacBot` on Telegram talks directly to the `almanac-lead` agent and its replies come back through that bot.

## Goals

- Per-agent Telegram bot, declared in the agent's persona frontmatter.
- Each agent's bot is 1:1 with the agent by default: inbound → that agent; that agent's Telegram-bound replies → that bot's chat.
- Multiple bots poll concurrently (one loop per agent-bot).
- Bot lifecycle tracks the agent: start on spawn/sync, restart on persona change (incl. token rotation), stop on removal/disable.
- Keep bot **tokens out of version control** (personas are a git repo).

## Non-Goals

- No new runtime dependency (custom Telegram HTTP polling stays; no `node-telegram-bot-api`).
- No change to the 3-phase lifecycle locking.
- Group-chat threading, media, inline keyboards — later.
- Not removing the `destinations` table (it stays for global/non-agent destinations and, per the recommended option, as the token store).

## Design

### 1. Persona frontmatter field `telegram` (nested object)

Add an optional nested field, parsed exactly like `env` (the existing nested-map precedent — `persona.ts` NESTED_FIELDS + `parseNestedValue`):

```yaml
telegram:
  chatId: "-100123456"      # default outbound chat (not secret)
  inbound: true             # default true; false = outbound-only
  routing: self             # self (default) | prefix | passthrough
```

> No `bot:` / `botToken:` — the token lives AES-256-GCM-encrypted in SQLite and
> is set via a write-only API (see §2). The persona carries only non-secret
> binding config; this is what PR-B implements.

- `routing: self` — every inbound message goes to THIS agent (the bot is the agent). Default.
- `routing: prefix` — honor `@agent` prefixes (route to others), falling back to self.
- `routing: passthrough` — inbound lands in a `telegram:<agent>` dashboard thread (no agent delivery).
- Optional later: `allowedChatIds` / `allowedUserIds` (access control, carried over from the old RFC).

### 2. Secrets — token AES-256-GCM-encrypted in SQLite (OPERATOR DECISION, 2026-06-06)

**Decision (supersedes the by-reference design below):** the bot token is stored
**AES-256-GCM-encrypted in SQLite**, NOT in the persona and NOT in any plaintext
column. Specifics:

- **Key derivation:** the AES-256 key is derived from the orchestrator shared
  secret (`~/.config/agentic-collab/secret` / `ORCHESTRATOR_SECRET`) — the same
  secret the API already trusts. No new key material to manage.
- **Write-only API:** the token is set via a write-only endpoint. It is never
  placed in frontmatter (so it never enters git) and never returned in plaintext
  by any read endpoint (`GET /api/agents`, persona reads, etc.).
- **Decrypted at reconcile time:** `reconcileTelegramBots` decrypts the token
  just-in-time when (re)starting an agent's poll loop; the plaintext lives only
  in memory for the lifetime of the loop.
- **Persona field carries ONLY non-secret binding config:** `chatId`, `inbound`,
  `routing`. No `bot:` reference, no `botToken:` — the persona has no secret and
  no secret pointer.
- **Also fixes the existing leak:** `GET /api/destinations` returns the telegram
  `botToken` in plaintext today; moving the token to the encrypted-at-rest,
  write-only store closes that plaintext `destinations` token leak too.

This is delivered as a later PR (token store + write-only API + reconcile
decryption); **PR-B (this field) is token-free by construction.**

> **Superseded — by-reference design (kept for history):** earlier this RFC
> proposed declaring `bot: <name>` in the persona and resolving the token at
> runtime from env (`TELEGRAM_BOT_<NAME_UPPER>`) / a `destinations` row /
> age-secrets. That kept the token out of *git* but NOT out of the *API*
> (`destinations` still returns it plaintext) and offered no clean operator
> path to set a token. The encrypted-in-SQLite decision above replaces it.

### 3. Multi-bot dispatcher (reuse the old RFC's design)

Refactor `TelegramDispatcher` from single-instance to a `Map<agentName, PollingState>` (keyed by **agent name**, not token, so rotation is safe):

```ts
private polls = new Map<string, { abort: AbortController; promise: Promise<void>; lastUpdateId: number; token: string }>();
startPolling(agentName, token, onMessage): void   // stops any existing loop for agentName first
stopPolling(agentName): void
stopAll(): void
```

Each loop long-polls `getUpdates` independently (same logic as today, per-bot offset). `send(token, chatId, text)` stays stateless (already is).

### 4. Inbound → agent (the bot IS the agent)

Per-agent `onMessage(chatId, userId, text)`:
- `routing: self` → `enqueueAndDeliver(ctx, { agentName, displayMessage: text, topic: 'telegram', sourceAgent: 'telegram:<agent>' })` — deliver to the owning agent. (If the agent is dead/void, spawn or queue per existing policy.)
- `routing: prefix` → existing `@agent` parse, fallback to self.
- `routing: passthrough` → dashboard `telegram:<agent>` thread.
- Apply `allowedChatIds`/`allowedUserIds` access control before delivery (optional, phase 2).

### 5. Outbound → the agent's bot (the round-trip) — THE HARD PART, build/prototype FIRST

⚠️ Adversarial review finding: the outbound channel **does not exist today** and is NOT a small wiring job. Current reality (verified): inbound telegram delivery enqueues the **raw** text (`routes.ts:3605`) with no reply hint, so the agent doesn't even know the message came from Telegram or how to answer; there is **no `telegram:` address class** (`address.ts` knows only agent/topic/approval → `collab send telegram:x` 400s); and the only agent→telegram path that exists is `collab send telegram[:name]` → `POST /api/destinations/:name/send` → sends to a **destination's static chatId** (not per-agent, not per-conversation). So this feature's headline ("replies come back through that bot") requires building a new outbound channel. Concretely it needs ALL of:

1. **Telegram-aware inbound envelope/hint** — replace the bare `envelope: messageText` so the agent's pane shows a from-address + a reply instruction it can act on (mirroring `buildReplyEnvelope`/`replyHint`).
2. **A sendable representation of "this agent's bot"** — either a new `telegram:<agent>` address class in `address.ts` + a send handler, OR intercept replies whose source is `telegram:<agent>` and route them out.
3. **An outbound interceptor** that, on such a send, resolves the **agent's persona** telegram config (not a `destinations` row) → resolves the token → looks up the conversation chatId → `dispatcher.send(token, chatId, text)`.
4. **An inbound→chatId map** (in-memory, keyed by agent, last-chat or per-conversation) so replies target the originating chat; fall back to the persona default `chatId`.

Because (1) and (2) may force changes to the inbound envelope format and the address system that ripple back into the other PRs, **a throwaway prototype of this round-trip must come first** (see revised phasing) to de-risk the whole feature before committing the persona-field/schema surface.

### 6. Lifecycle reconciliation

A `reconcileTelegramBots(ctx)` that diffs desired (agents whose effective config has `telegram` + a resolvable token + `inbound:true`) vs running polls, and starts/stops/restarts:
- On boot (after persona sync) — replaces the current `listDestinations()` startup loop.
- On persona reload / `POST /api/personas/reload` / sync — re-reconcile (start new, stop removed, restart on token/chatId change).
- On agent delete / suspend (optional: keep polling while suspended so the bot still receives? — proposal: stop inbound when the agent is removed; keep while suspended so messages queue). Decide in impl.

### 7. Schema (additive)

New CONFIG_FIELDS entry → new `agent_telegram` TEXT column (JSON), exactly like `launchEnv`/`env`:

```ts
{ name: 'agentTelegram', column: 'agent_telegram', personaKey: 'telegram', kind: 'json',
  nested: true, upsertable: true, serialize: JSON.stringify-ish, deserialize: parse+validate, equals: deep }
```

- `PersonaFrontmatter.telegram?: AgentTelegramConfig`, `AgentRecord.agentTelegram: AgentTelegramConfig | null`, add `telegram` to `NESTED_FIELDS`.
- Additive: personas without `telegram` parse unchanged (the column defaults null). The `agent_telegram` column is created by the CONFIG_FIELDS-driven `ALTER TABLE` (same path as `icon`) — verified safe for fresh-DB boot.
- Persona-frontmatter change = schema migration per house rules → this RFC + every persona keeps parsing (guaranteed: optional field).

### 8. Dashboard

- Persona editor: a `telegram` group (bot name, chatId, inbound toggle, routing select) — additive to the RFC-005 structured editor (or rides the Advanced passthrough initially).
- A per-agent bot-status indicator (running / token-missing / disabled), reusing the indicator system.

## Decomposition (phased PRs) — REVISED per review (outbound de-risked first)

- **PR-0 (spike, throwaway):** prototype the outbound round-trip end to end against ONE hard-coded agent+bot — telegram-aware inbound envelope, a sendable `telegram:<agent>` path, the outbound interceptor, the inbound→chatId map. Goal: validate the envelope/address changes BEFORE building the persona/schema surface. Also stand up the **telegram test baseline** (none exists today — `TelegramDispatcher`/`startTelegramPolling` are untested).
- **PR-A (infra):** refactor `TelegramDispatcher` single-instance → `Map<agentName, PollingState>` (also fixes a latent bug: with >1 enabled telegram destination today, `startPolling` kills the prior loop so only the last polls). Backed by the PR-0 test baseline.
- **PR-B (persona field + schema):** add the `telegram` frontmatter field end-to-end (types, field-registry `kind:'json', nested:true`, parse, **deserialize that string-coerces `inbound`**, AgentRecord, `agent_telegram` column) — additive. Invariant: `agent_telegram` stores name+chatId+routing+inbound only, **never the resolved token** (it's exposed via `GET /api/agents`).
- **PR-C (resolution + reconcile + inbound):** token resolution (env / destinations / age-secrets); `reconcileTelegramBots` that **owns the entire poll set** (delete the legacy `main.ts:741-744` startup loop) and dedupes on **resolved token**, not bot name (two names → same token = 409); per-agent inbound routing (self/prefix/passthrough); the `void`-agent policy (reject-with-telegram-reply or auto-spawn — operator decision); wire boot + persona-reload reconcile.
- **PR-D (outbound, productionized):** harden the PR-0 spike into the real per-agent outbound channel.
- **PR-E (dashboard):** persona-editor telegram group + bot-status indicator (running / token-missing / disabled).

PR-0 first (de-risk). A+B independent after. C depends on A+B+0. D productionizes 0. E frontend.

## Constraints honored

- Zero-dep; no lock change; persona-frontmatter change handled as an additive schema migration (RFC + all personas keep parsing).
- Tokens kept out of git AND out of plaintext at rest: AES-256-GCM-encrypted in SQLite, set via a write-only API (see §2).

## Risks / open questions

- **Secrets:** RESOLVED 2026-06-06 — token AES-256-GCM-encrypted in SQLite, key from the orchestrator shared secret, set via a write-only API (§2).
- **Reply target:** per-conversation chatId vs persona default `chatId` (§5) — proposal: originating chat when known.
- **Bot uniqueness:** two personas referencing the same `bot` name = two agents polling one token → Telegram only allows ONE getUpdates consumer per token (the second gets 409 Conflict). Reconcile must reject/warn on duplicate bot refs.
- **Suspended agents:** keep or stop polling — proposal: keep (queue messages), stop only on removal/disable.
- **Migration of the existing single bot:** the current `destinations` telegram entry keeps working (resolution option 2 bridges it); we can later convert it to a persona-declared bot.

## Key Decision — RESOLVED (2026-06-06)

**Where does the bot token live?** Operator decision: **neither in the persona
(inline) nor by-reference** — the token is **AES-256-GCM-encrypted in SQLite**,
keyed off the orchestrator shared secret, set via a write-only API, decrypted at
reconcile time (full detail in §2). The persona carries only non-secret binding
config (`chatId`/`inbound`/`routing`). The two options below are kept for history:

- ~~**(A) By reference:** persona has `bot: <name>`; token resolved from env/destinations/secrets at runtime.~~ Superseded — kept the token out of git but not out of the API, and had no clean operator set-path.
- ~~**(B) Inline:** persona has `botToken: <token>` directly.~~ Rejected — commits a live secret to `claude-home` git.

Everything else above is the recommended default; flag any you'd change (esp.
routing default `self`, and the reply-target behavior).

## Adversarial review resolutions (2026-06-06)

Verdict: **sound-with-changes; the outbound round-trip (now PR-0/PR-D) is the real work and is prototyped first.** Resolutions folded in above, plus:

- **Outbound channel doesn't exist** → reframed §5 + PR-0 spike-first. This is the single biggest risk; the rest (persona field, schema, multi-bot Map, reconcile, secrets-by-ref) is well-grounded and safe.
- **`inbound: true` parses as the STRING `"true"`** (the nested parser keeps scalars as strings, like `env`) → `deserialize` must coerce (`inbound !== 'false'`).
- **Dedupe on resolved token, not bot name** (two names can resolve to one token → 409). Reconcile owns the whole poll set; delete the legacy `main.ts` startup loop (else old + new both poll the same token → 409).
- **Restart-race 409:** abort cancels the in-flight long-poll (good), but Telegram's server-side consumer state lingers briefly → transient 409 on rotation/reload; current retry self-heals but log-spams. Acceptable; quiet the log.
- **Secrets honesty:** by-reference keeps the token out of **git**, NOT out of the **API** — `GET /api/destinations` returns `botToken` plaintext today. Don't oversell "secret." And there's a real **UX gap: no clean operator path to set a token** (env needs a container restart; `destinations` requires a chatId for a token-only vault). PR-C should add a minimal token-set path (e.g. a token-only destination type, or a dashboard secret field).
- **`void`-agent inbound** today = silent queue-forever (no auto-spawn). Must decide: reject-with-telegram-reply, or auto-spawn the agent. (Operator decision #3.)
- **No telegram tests exist** → PR-0 establishes the baseline before the Map refactor (so "parity" is verifiable).
- **`resolveEffectiveConfig` does not iterate CONFIG_FIELDS** → `agentTelegram` passes through via `...agent` with no engine-config merge (correct for per-agent telegram); reconcile reads `agent.agentTelegram` directly.

## Decisions needed from the operator

1. **Secrets:** RESOLVED — token AES-256-GCM-encrypted in SQLite (§2 / §Key Decision).
2. **Routing default:** `self` (bot↔agent 1:1) — confirm, or prefer `prefix`.
3. **`void`/unspawned agent gets a Telegram message:** reject-with-reply, or auto-spawn the agent?
4. **Reply target:** originating chat (per-conversation, recommended) vs the persona's static `chatId`.
5. **Scope/appetite:** this is ~5 PRs incl. a spike; the outbound round-trip is real work, not a config tweak. Confirm you want the full round-trip (inbound + outbound), or inbound-only first as a smaller increment.
