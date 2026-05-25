# RFC: Code Quality Sweep

**Status:** Draft  
**Author:** agentic-collab-lead  
**Date:** 2026-05-25

## Summary

Consolidate duplicate code, remove dead code, and improve test reliability across the agentic-collab codebase. No UI behavior changes.

## Motivation

Five parallel code review agents identified redundant patterns, dead code, and flaky test fixtures. This RFC proposes a targeted cleanup that reduces maintenance burden without changing functionality.

---

## Changes

### PR-1: Dashboard Utility Extraction (P0)

**Problem:** `escapeHtml` duplicated in 9 files, `formatTime` in 2, `toast` in 2.

**Solution:** Create `src/dashboard/util.ts`:
```typescript
export function escapeHtml(s: string | null | undefined): string;
export function formatTime(iso: string): string;
export function toast(msg: string, kind?: 'info' | 'error'): void;
```

**Files:** agents.ts, approvals.ts, chat.ts, overlays.ts, reminders.ts, search.ts, settings.ts, sidebar.ts, watch.ts

**Lines saved:** ~90

---

### PR-2: Proxy Token Validation Extraction (P1)

**Problem:** Identical 4-line token validation block at `src/proxy/main.ts:342-345` and `src/proxy/main.ts:407-410`.

**Solution:** Extract to:
```typescript
function validateToken(req: IncomingMessage): boolean {
  const t = req.headers['x-proxy-token'];
  return typeof t === 'string' && t.length === token.length &&
         timingSafeEqual(Buffer.from(t), Buffer.from(token));
}
```

**Lines saved:** ~6

---

### PR-3: Remove Redundant Dynamic Imports (P2)

**Problem:** `src/proxy/main.ts:244, 264-266` dynamically imports `node:fs`, `node:path`, `node:os` despite top-level imports at lines 11-13.

**Solution:** Remove dynamic imports, use existing top-level imports.

---

### PR-4: Broadcast Logic Deduplication (P2)

**Problem:** `websocket-server.ts:167-186` and `237-256` share nearly identical frame-caching logic.

**Solution:** Extract private helper:
```typescript
private _broadcastToClients(data: string, filter?: (c: WsClient) => boolean): void
```

**Note:** Must preserve `shouldDeliver()` filter semantics in `broadcastFiltered()`. Test must verify filtered delivery still works.

---

### PR-5: Test Fixture Consolidation (P2)

**Problem:** Temp directory pattern duplicated 15+ times across test files.

**Solution:** Create `src/test/fixtures/testDb.ts`:
```typescript
export function createTestDb(): { db: Database; tmpDir: string; cleanup: () => void };
```

Update: database.test.ts, lifecycle.test.ts, integration.test.ts, teams.test.ts, message-dispatcher.test.ts, etc.

---

### PR-6: Remove Deprecated `buildInstanceEnv` (P2)

**Problem:** `instance-env.ts:144-151` is marked `@deprecated` but still exported as wrapper.

**Solution:** Remove wrapper, update any callers to use `buildHostShellEnv` directly.

---

### PR-7: Simplify `generateMessageId` (P3)

**Problem:** `sanitize.ts:33-51` uses manual rejection sampling over crypto.getRandomValues.

**Solution:** Use `crypto.randomUUID().slice(0,12)` for simplicity (Node 19+ built-in).

---

## Deferred (Not in Scope)

These were identified but are larger refactors requiring separate RFCs:

1. **routes.ts monolith (3148 lines)** — Extract route groups to separate modules. Requires careful API boundary design.

2. **database.ts inline migrations (2696 lines)** — Extract to migrations.ts with version table. Requires migration testing strategy.

3. **HealthMonitor 17 private Maps** — Group into typed structs. Lower priority, current code is correct.

4. **Duplicate proxy resolution** — Extract to shared resolver. Touches recovery logic, needs careful testing.

---

## Validation

- All 319+ tests must pass
- `npx tsc --noEmit` clean
- No UI behavior changes (visual regression not needed)

---

## Execution Order (DAG)

```
PR-1 (dashboard util)  ─┐
PR-2 (token validation) ├─► Final validation
PR-3 (dynamic imports)  │
PR-4 (broadcast dedup)  │
PR-5 (test fixtures)    │
PR-6 (deprecated fn)    │
PR-7 (messageId)  ──────┘
```

All 7 PRs are independent and can be executed in parallel.
