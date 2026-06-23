/**
 * RFC-010 §13 Q3 — raster-ceiling guard (pure dimension math, unit-tested in
 * isolation). The iframe runtime (`tools/tldraw-bundle/entry.tsx`) calls
 * `clampExportDimensions` with the live page bounds BEFORE `toImage`; this test
 * exercises that same pure function so the shipped code is the tested code.
 *
 * The ceiling is THREE caps applied together (RFC §9.4 + Q3 edge cap):
 *   - scale clamped to [MIN_SCALE, MAX_SCALE],
 *   - longest edge <= MAX_EDGE_PX,
 *   - total pixels <= MAX_RASTER_PX.
 * A large canvas DEGRADES (down-scales) rather than failing; a degenerate canvas
 * (no bounds) returns ok:false WITHOUT producing dimensions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScale,
  clampExportDimensions,
  withinRasterCeiling,
  decideExport,
  MIN_SCALE,
  MAX_SCALE,
  MAX_EDGE_PX,
  MAX_RASTER_PX,
} from './sketch-raster.ts';

test('clampScale clamps to [MIN_SCALE, MAX_SCALE] and defaults non-finite to 1', () => {
  assert.equal(clampScale(undefined), 1);
  assert.equal(clampScale(NaN), 1);
  assert.equal(clampScale(Infinity), 1);
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(100), MAX_SCALE);
  assert.equal(clampScale(1.5), 1.5);
});

test('a normal small canvas exports at the requested (clamped) scale, unmodified', () => {
  // 400x300 @ scale 2 = 800x600 — well under every ceiling.
  const result = clampExportDimensions(400, 300, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scale, 2);
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.ok(withinRasterCeiling(result.width, result.height));
});

test('a wide canvas is down-scaled so the longest edge fits MAX_EDGE_PX', () => {
  // 4000x500 @ scale 1 would be 4000px wide (> 2048). Down-scale to edge cap.
  const result = clampExportDimensions(4000, 500, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.width, MAX_EDGE_PX); // longest edge exactly the cap
  assert.ok(result.height <= MAX_EDGE_PX);
  assert.ok(result.scale < 1, 'scale was reduced below the requested 1');
  assert.ok(withinRasterCeiling(result.width, result.height));
});

test('a huge square canvas is down-scaled so total pixels fit MAX_RASTER_PX', () => {
  // 10000x10000 @ scale 1 — edge cap pulls each side to 2048 (2048*2048 ≈ 4.2 MP,
  // already under 32 MP), so the edge cap is the binding constraint here.
  const result = clampExportDimensions(10000, 10000, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.width <= MAX_EDGE_PX && result.height <= MAX_EDGE_PX);
  assert.ok(result.width * result.height <= MAX_RASTER_PX);
  assert.ok(withinRasterCeiling(result.width, result.height));
});

test('a malicious scale request cannot blow past the ceiling (scale clamp first)', () => {
  // Requesting scale 1000 on a 3000x2000 canvas: clamp to MAX_SCALE then edge-cap.
  const result = clampExportDimensions(3000, 2000, 1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.scale <= MAX_SCALE);
  assert.ok(result.width <= MAX_EDGE_PX && result.height <= MAX_EDGE_PX);
  assert.ok(withinRasterCeiling(result.width, result.height));
});

test('a long thin canvas (low MP but huge edge) is still edge-capped', () => {
  // 50000x100 = 5 MP total (< 32 MP) but 50000 px wide — the per-edge cap is what
  // closes this DoS vector the megapixel ceiling alone misses.
  const result = clampExportDimensions(50000, 100, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.width, MAX_EDGE_PX);
  assert.ok(withinRasterCeiling(result.width, result.height));
});

test('degenerate bounds (zero / negative / non-finite) return ok:false, no dimensions', () => {
  assert.deepEqual(clampExportDimensions(0, 100, 1), { ok: false, reason: 'no_bounds' });
  assert.deepEqual(clampExportDimensions(100, 0, 1), { ok: false, reason: 'no_bounds' });
  assert.deepEqual(clampExportDimensions(-5, 100, 1), { ok: false, reason: 'no_bounds' });
  assert.deepEqual(clampExportDimensions(NaN, 100, 1), { ok: false, reason: 'no_bounds' });
  assert.deepEqual(clampExportDimensions(Infinity, 100, 1), { ok: false, reason: 'no_bounds' });
});

test('withinRasterCeiling rejects an over-edge raster even when total MP is fine', () => {
  // 3000x10 = 30k px total (tiny) but 3000 > MAX_EDGE_PX → rejected.
  assert.equal(withinRasterCeiling(3000, 10), false);
  // Exactly at the edge cap and under MP → allowed.
  assert.equal(withinRasterCeiling(MAX_EDGE_PX, 10), true);
  // NaN / non-positive → rejected (no sneaking past).
  assert.equal(withinRasterCeiling(NaN, 10), false);
  assert.equal(withinRasterCeiling(0, 10), false);
  assert.equal(withinRasterCeiling(-1, 10), false);
});

test('produced dimensions never round below 1 px (a tiny canvas still renders)', () => {
  const result = clampExportDimensions(0.4, 0.4, MIN_SCALE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.width >= 1 && result.height >= 1);
});

// ── The iframe export GATE (decideExport) — the "do not call toImage" check ──────
//
// `decideExport` is the exact pure gate `entry.tsx` applies before `editor.toImage`.
// These tests simulate the iframe export branch with a toImage SPY and assert the
// spy is NOT called when the gate refuses (RFC §13 Q3: "returns ok:false WITHOUT
// calling toImage — assert the toImage stub was not called").

/** Mirror of entry.tsx's export branch over the pure gate, with an injectable spy. */
async function simulateIframeExport(
  bounds: { width: number; height: number } | null,
  requestedScale: number | undefined,
  toImageSpy: (scale: number) => Promise<{ width: number; height: number }>,
): Promise<{ ok: boolean; error?: string; calledToImage: boolean }> {
  let calledToImage = false;
  const decision = decideExport(bounds, requestedScale);
  if (!decision.proceed) {
    return { ok: false, error: decision.error, calledToImage };
  }
  calledToImage = true;
  await toImageSpy(decision.scale);
  return { ok: true, calledToImage };
}

test('decideExport refuses an empty canvas (null bounds) WITHOUT calling toImage', async () => {
  let spyCalls = 0;
  const spy = async (): Promise<{ width: number; height: number }> => {
    spyCalls++;
    return { width: 1, height: 1 };
  };
  const result = await simulateIframeExport(null, 1, spy);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'empty canvas');
  assert.equal(result.calledToImage, false);
  assert.equal(spyCalls, 0, 'toImage must NOT be called when the gate refuses');
});

test('decideExport proceeds for a valid canvas and calls toImage exactly once at the clamped scale', async () => {
  const seen: number[] = [];
  const spy = async (scale: number): Promise<{ width: number; height: number }> => {
    seen.push(scale);
    return { width: 100, height: 100 };
  };
  const result = await simulateIframeExport({ width: 400, height: 300 }, 2, spy);
  assert.equal(result.ok, true);
  assert.equal(result.calledToImage, true);
  assert.deepEqual(seen, [2], 'toImage called once at the clamped scale');
});

test('decideExport down-scales a huge canvas (still proceeds) so a legit big canvas degrades', async () => {
  const seen: number[] = [];
  const spy = async (scale: number): Promise<{ width: number; height: number }> => {
    seen.push(scale);
    return { width: MAX_EDGE_PX, height: 50 };
  };
  // 50000x500 — over the edge cap; gate proceeds with a reduced scale (degrade).
  const result = await simulateIframeExport({ width: 50000, height: 500 }, 1, spy);
  assert.equal(result.ok, true);
  assert.equal(result.calledToImage, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]! < 1, 'the clamped scale handed to toImage was reduced below 1');
});
