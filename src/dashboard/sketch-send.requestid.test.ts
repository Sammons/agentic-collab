/**
 * RFC-010 §13 Q3 — `requestId` correlation: a STALE export-response for an old
 * `requestId` is IGNORED; only the matching, still-pending response settles its
 * promise. The controller is the DOM-free home of this correlation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SketchSendController } from './sketch-send-controller.ts';

test('only the matching requestId resolves its promise', () => {
  const controller = new SketchSendController<string>();
  let resolved: string | null = null;
  const id = controller.registerExport((v) => { resolved = v; }, () => {});
  const settle = controller.settleExport(id, { ok: true, value: 'png-A' });
  assert.deepEqual(settle, { matched: true });
  assert.equal(resolved, 'png-A');
});

test('a stale response for an UNKNOWN requestId is ignored (no resolve, no throw)', () => {
  const controller = new SketchSendController<string>();
  let resolved: string | null = null;
  const id = controller.registerExport((v) => { resolved = v; }, () => {});
  // A response for a different id arrives — it must NOT resolve the pending one.
  const settle = controller.settleExport('exp-999', { ok: true, value: 'wrong' });
  assert.deepEqual(settle, { matched: false });
  assert.equal(resolved, null, 'the pending export was not resolved by a stale id');
  assert.equal(controller.pendingCount, 1, 'the real request is still pending');

  // The correct response still settles it.
  controller.settleExport(id, { ok: true, value: 'right' });
  assert.equal(resolved, 'right');
  assert.equal(controller.pendingCount, 0);
});

test('a duplicate response for an ALREADY-SETTLED requestId is ignored', () => {
  const controller = new SketchSendController<string>();
  let resolveCount = 0;
  let lastValue: string | null = null;
  const id = controller.registerExport((v) => { resolveCount++; lastValue = v; }, () => {});
  controller.settleExport(id, { ok: true, value: 'first' });
  // A late duplicate for the same id must NOT resolve again.
  const dup = controller.settleExport(id, { ok: true, value: 'duplicate' });
  assert.deepEqual(dup, { matched: false });
  assert.equal(resolveCount, 1, 'resolve fired exactly once');
  assert.equal(lastValue, 'first');
});

test('two concurrent exports settle independently by their own ids', () => {
  const controller = new SketchSendController<string>();
  const results: Record<string, string> = {};
  const id1 = controller.registerExport((v) => { results['one'] = v; }, () => {});
  const id2 = controller.registerExport((v) => { results['two'] = v; }, () => {});
  assert.notEqual(id1, id2, 'each export gets a distinct requestId');
  assert.equal(controller.pendingCount, 2);
  // Responses arrive out of order — each settles only its own promise.
  controller.settleExport(id2, { ok: true, value: 'second-done' });
  controller.settleExport(id1, { ok: true, value: 'first-done' });
  assert.deepEqual(results, { one: 'first-done', two: 'second-done' });
  assert.equal(controller.pendingCount, 0);
});

test('a failed response rejects only the matching promise', () => {
  const controller = new SketchSendController<string>();
  let rejected: Error | null = null;
  const id = controller.registerExport(() => {}, (e) => { rejected = e; });
  controller.settleExport(id, { ok: false, error: new Error('export failed') });
  assert.ok(rejected instanceof Error);
  assert.equal((rejected as Error).message, 'export failed');
});

test('timeout rejects a still-pending request; a settled one is a no-op timeout', () => {
  const controller = new SketchSendController<string>();
  let rejected: Error | null = null;
  const id = controller.registerExport(() => {}, (e) => { rejected = e; });
  const t1 = controller.timeoutExport(id, new Error('export timed out'));
  assert.deepEqual(t1, { matched: true });
  assert.equal((rejected as unknown as Error).message, 'export timed out');
  // A timeout firing after the request already left the map matches nothing.
  const t2 = controller.timeoutExport(id, new Error('export timed out'));
  assert.deepEqual(t2, { matched: false });
});
