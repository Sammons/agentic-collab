/**
 * RFC-010 §5.3 / §13 Q1 — the postMessage protocol skeleton.
 *
 * Each `kind` has a type guard; a sample of each validates; the nonce handshake
 * rejects a missing/mismatched nonce. The raster guard (§9.4) is unit-tested here
 * too so the export round-trip's safety logic is covered in Q1 (the export-wiring
 * tests proper land in Q3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKETCH_PROTOCOL_VERSION,
  isSketchReady,
  isSketchInit,
  isSketchLoad,
  isSketchExportRequest,
  isSketchReset,
  isSketchDirty,
  isSketchExportResponse,
  isSketchError,
  isSketchMessage,
  nonceMatches,
  type SketchMessage,
} from './sketch-protocol.ts';
import { clampScale, withinRasterCeiling, MIN_SCALE, MAX_SCALE, MAX_RASTER_PX, MAX_EDGE_PX } from './sketch-raster.ts';

const V = SKETCH_PROTOCOL_VERSION;
const NONCE = '11111111-2222-3333-4444-555555555555';

test('each message kind validates against its type guard', () => {
  assert.ok(isSketchReady({ kind: 'sketch:ready', v: V }));
  assert.ok(isSketchInit({ kind: 'sketch:init', v: V, nonce: NONCE, theme: 'greenroom-light' }));
  assert.ok(isSketchInit({ kind: 'sketch:init', v: V, nonce: NONCE, theme: 'greenroom-light', licenseKey: 'k', readOnly: true }));
  assert.ok(isSketchLoad({ kind: 'sketch:load', v: V, nonce: NONCE, doc: { shapes: [] } }));
  assert.ok(isSketchExportRequest({ kind: 'sketch:export-request', v: V, nonce: NONCE, requestId: 'r1', format: 'png', scale: 2 }));
  assert.ok(isSketchReset({ kind: 'sketch:reset', v: V, nonce: NONCE }));
  assert.ok(isSketchDirty({ kind: 'sketch:dirty', v: V, nonce: NONCE, dirty: true }));
  assert.ok(isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: true, dataUrl: 'data:image/png;base64,AAA', width: 10, height: 10 }));
  assert.ok(isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: false, error: 'too large' }));
  assert.ok(isSketchError({ kind: 'sketch:error', v: V, nonce: NONCE, where: 'parse', message: 'bad' }));
});

test('guards reject the wrong protocol version', () => {
  assert.ok(!isSketchReady({ kind: 'sketch:ready', v: 999 }));
  assert.ok(!isSketchInit({ kind: 'sketch:init', v: 999, nonce: NONCE, theme: 'greenroom-light' }));
});

test('guards reject structurally invalid payloads', () => {
  assert.ok(!isSketchInit({ kind: 'sketch:init', v: V, theme: 'greenroom-light' }), 'missing nonce');
  assert.ok(!isSketchInit({ kind: 'sketch:init', v: V, nonce: NONCE, theme: 'dark' }), 'bad theme');
  assert.ok(!isSketchInit({ kind: 'sketch:init', v: V, nonce: NONCE, theme: 'greenroom-light', licenseKey: 42 }), 'non-string licenseKey');
  assert.ok(!isSketchLoad({ kind: 'sketch:load', v: V, nonce: NONCE, doc: { shapes: 'nope' } }), 'shapes not an array');
  assert.ok(!isSketchExportRequest({ kind: 'sketch:export-request', v: V, nonce: NONCE, requestId: 'r1', format: 'jpg' }), 'bad format');
  assert.ok(!isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: true, dataUrl: 'x' }), 'ok:true missing width/height');
  assert.ok(!isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: false }), 'ok:false missing error');
});

test('guards reject non-objects / cross-kind confusion', () => {
  assert.ok(!isSketchMessage(null));
  assert.ok(!isSketchMessage('sketch:ready'));
  assert.ok(!isSketchMessage(42));
  assert.ok(!isSketchInit({ kind: 'sketch:ready', v: V }), 'ready is not init');
  assert.ok(isSketchMessage({ kind: 'sketch:ready', v: V }));
});

test('nonce handshake: matching nonce accepted, mismatched/missing rejected', () => {
  const load: SketchMessage = { kind: 'sketch:load', v: V, nonce: NONCE, doc: { shapes: [], notes: [] } };
  assert.ok(nonceMatches(load, NONCE), 'matching nonce passes');
  assert.ok(!nonceMatches(load, 'different-nonce'), 'mismatched nonce dropped');
});

test('nonce handshake: sketch:ready is the only pre-handshake message (exempt)', () => {
  const ready: SketchMessage = { kind: 'sketch:ready', v: V };
  // ready carries no nonce; nonceMatches returns true regardless of expected.
  assert.ok(nonceMatches(ready, NONCE));
  assert.ok(nonceMatches(ready, 'anything'));
});

// ── Raster guard (§9.4) — export round-trip safety logic ──

test('clampScale clamps into [MIN_SCALE, MAX_SCALE], defaults to 1', () => {
  assert.equal(clampScale(undefined), 1);
  assert.equal(clampScale(NaN), 1);
  // Non-finite (Infinity) is treated as "not a valid scale" → defaults to 1,
  // then clamped (1 is in range). It does NOT become MAX_SCALE.
  assert.equal(clampScale(Infinity), 1);
  assert.equal(clampScale(-Infinity), 1);
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(100), MAX_SCALE);
  assert.equal(clampScale(1.5), 1.5);
});

test('withinRasterCeiling rejects over-ceiling (edge + total), NaN, and non-positive dims', () => {
  assert.ok(withinRasterCeiling(1000, 1000));
  assert.ok(!withinRasterCeiling(MAX_RASTER_PX, 2), 'over total + over edge');
  assert.ok(!withinRasterCeiling(NaN, 10));
  assert.ok(!withinRasterCeiling(10, Infinity));
  assert.ok(!withinRasterCeiling(0, 10));
  assert.ok(!withinRasterCeiling(-5, 10));
  // Q3 per-edge cap: an edge over MAX_EDGE_PX is rejected even when total MP is fine.
  assert.ok(!withinRasterCeiling(MAX_EDGE_PX + 1, 1), 'over the per-edge cap');
  // Exactly at the per-edge cap and under the total ceiling is allowed.
  assert.ok(withinRasterCeiling(MAX_EDGE_PX, MAX_EDGE_PX), 'at the edge cap, under total');
});

test('export-response: editedDsl is OPTIONAL but must be a string when present (Q3 sidecar)', () => {
  // Present + string → valid.
  assert.ok(isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: true, dataUrl: 'data:image/png;base64,AAA', width: 10, height: 10, editedDsl: '{"document":{}}' }));
  // Absent → still valid (older frame / serialization failure; parent falls back).
  assert.ok(isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: true, dataUrl: 'data:image/png;base64,AAA', width: 10, height: 10 }));
  // Present but non-string → rejected.
  assert.ok(!isSketchExportResponse({ kind: 'sketch:export-response', v: V, nonce: NONCE, requestId: 'r1', ok: true, dataUrl: 'data:image/png;base64,AAA', width: 10, height: 10, editedDsl: 42 }), 'non-string editedDsl rejected');
});
