# Q7 · CLI mode-awareness

## Plan
`bin/collab` detects ephemeral context from env (`MESSAGE_ID` + `AGENT_TEMPLATE` + `REPLY_PATH` — all three required; partial env never flips modes). In ephemeral mode the help banner names the message + topic and lists `complete`/`fail`; in persistent mode it gives inbox guidance and hides `complete`/`fail`. `composeSystemPrompt` accepts `mode='persistent' | 'ephemeral'` and appends a single-message-completion addendum in ephemeral mode.

Spec: `docs/v3-upgrade-prompt.md` §Q7.

## Critic findings (lite fan-out)
No critics invoked.

## Builder report
- Files changed: `bin/collab` (+58/-5, `isEphemeralMode` helper + mode-tagged `cmd()` registrations + mode-filtered help printer), `src/orchestrator/persona.ts` (+33, `composeSystemPrompt(mode?)`), `src/orchestrator/persona.test.ts` (+40, 3 tests), `src/test/cli-mode.test.ts` (NEW, 109 lines, 4 CLI-spawn tests).
- Tests added: 7 — persistent default matches existing prompt; ephemeral adds the `collab complete --reply` addendum; CLI env trio → ephemeral banner + complete/fail listed; partial env → persistent banner.
- Migrations: none.
- Gates: typecheck clean · 1001 tests / 982 pass post-merge.

## Hostile review
Skipped per lite-fan-out protocol.

## Tests + smoke
- Smoke: n/a (CLI mode is observable via the smoke's `collab complete` invocation inside the agent script, which only works because env is present).

## Final commit
- SHA: `5a24754` on `v3-integration` (merge of worktree branch `worktree-agent-af8cff2a4c97f6ea6`, builder commit `c69c57f`).

## Open questions for follow-up
- `composeSystemPrompt` is wired through `lifecycle.ts` for persistent agents but `topic-delivery.ts` doesn't call it for ephemeral starts (the kernel pastes the raw `start` hook). If ephemeral agents need the system-prompt addendum injected, `topic-delivery.ts` would need to compose-and-paste the addendum as a leading message. Defer until a real engine integration needs it.
- The CLI test (`cli-mode.test.ts`) sets `ORCHESTRATOR_URL=http://127.0.0.1:1` to avoid discovery; relies on `bin/collab --help` short-circuiting before `init()`.
