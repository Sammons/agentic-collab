# Q4 · WebSocket event contract

## Plan
Extend `WsEvent` (in `src/shared/types.ts`) with the typed v3 events: `template_updated`, `topic_queue_changed`, `instance_spawned`, `instance_completed`, `instance_failed`, `approval_changed`. Wire emissions from the Q2 sync routine and the Q3 kernel paths (`topic-delivery.ts`, `instance-reaper.ts`).

Spec: `docs/v3-upgrade-prompt.md` §Q4.

## Critic findings (lite fan-out)
No critics invoked — small additive surface, no novel decisions.

## Builder report
- Files changed: `src/shared/types.ts` (+87/-2 — `Ws*` event types), `src/shared/websocket-server.ts` (+11 — `broadcastEvent(ev: WsEvent)` helper), `src/orchestrator/database.ts` (+13 — `countQueuedTopicMessages` for spec-compliant queue depth), `src/orchestrator/topic-delivery.ts` (+33/-13 — typed event emissions), `src/orchestrator/instance-reaper.ts` (+33/-8 — typed `instance_completed` / `instance_failed` + post-finalize `topic_queue_changed`), `src/orchestrator/template-sync.ts` (+18/-1 — optional `TemplateSyncEventSink`), `src/orchestrator/persona.ts` (+25/-9 — thread event sink), `src/orchestrator/main.ts` (+10/-9 — wire `broadcastEvent`), 3 test files (+199).
- Tests added: 6 (2 topic-delivery, 2 instance-reaper, 2 template-sync) — all green.
- Migrations: none.
- Gates: typecheck no new error classes · 994 tests / 975 pass.

## Hostile review
Skipped per lite-fan-out protocol.

## Tests + smoke
- New tests: `Q4: emits instance_spawned event after claim+insert succeeds`, `Q4: emits topic_queue_changed when a queue row is claimed`, `Q4: emits instance_completed on successful finalization`, `Q4: emits instance_failed when status is 'error'`, `Q4: emits template_updated:added on first sync of a template`, `Q4: emits template_updated:modified on resync with changed fields`.
- Smoke: n/a (the kernel smoke covers the indirect side effects).

## Final commit
- SHA: `1252ccb` on `v3-integration`.

## Open questions for follow-up
- Q4 added `topic_queue_changed` depth as `count(*) WHERE status='queued'`. If consumers want a richer view (`claimed` vs `queued` vs `failed` breakdown), expose a richer payload here.
- `template_updated:removed` is reserved for Q8/Q9 — Q4 doesn't emit it because the sync routine has no concept of deletion.
