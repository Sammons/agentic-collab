/**
 * RFC-010 §9.4 — the raster-ceiling guard (pure logic, shared by the iframe
 * runtime and tests).
 *
 * The iframe MUST enforce a concrete pixel ceiling BEFORE calling
 * `editor.toImage` — a malicious/huge canvas requesting a multi-gigapixel raster
 * is an OOM/DoS vector, and the 100 MB upload backstop (`routes.ts`
 * `FILE_MAX_BYTES`) is far too coarse to catch it (a 32 MP PNG can be well under
 * 100 MB and still blow up rendering). The guard lives at the rasterization point.
 *
 * This module is `src/shared/` (not `tools/`) on purpose: the constants + the two
 * pure predicates are imported by BOTH the iframe runtime
 * (`tools/tldraw-bundle/entry.tsx`, bundled offline) AND the `node --test` suite
 * (which cannot reach into `tools/`), so the tested code and the shipped code are
 * the same code.
 */

/** Minimum allowed export scale. */
export const MIN_SCALE = 0.25;
/** Maximum allowed export scale — caps a malicious huge-raster request (§9.4). */
export const MAX_SCALE = 2;
/** Hard pixel ceiling for an exported raster: width * height must be <= this. */
export const MAX_RASTER_PX = 32_000_000; // 32 MP
/**
 * Hard per-edge pixel ceiling (RFC-010 Q3): the longest side of an exported raster
 * must be <= this. The total-megapixel ceiling (`MAX_RASTER_PX`) alone does not
 * bound a long, thin canvas (e.g. 50_000 x 100 is only 5 MP yet 50_000 px wide and
 * a memory/encode hazard); the per-edge cap closes that. 2048 px is a crisp ceiling
 * for an inline chat image — large enough that a normal diagram exports sharp, small
 * enough that a pathological canvas cannot produce an enormous edge.
 */
export const MAX_EDGE_PX = 2048;

/**
 * Clamp a requested export scale into `[MIN_SCALE, MAX_SCALE]`. A missing or
 * non-finite scale defaults to 1 (the crisp default), then is clamped.
 */
export function clampScale(scale: number | undefined): number {
  const value = typeof scale === 'number' && Number.isFinite(scale) ? scale : 1;
  if (value < MIN_SCALE) return MIN_SCALE;
  if (value > MAX_SCALE) return MAX_SCALE;
  return value;
}

/**
 * True when a `width * height` raster is within BOTH the per-edge ceiling
 * (`MAX_EDGE_PX` on each side) AND the total-megapixel ceiling (`MAX_RASTER_PX`).
 * Non-finite or non-positive dimensions are treated as out-of-bounds (false) so a
 * NaN can never sneak past the guard.
 */
export function withinRasterCeiling(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_EDGE_PX || height > MAX_EDGE_PX) return false;
  return width * height <= MAX_RASTER_PX;
}

/** The result of clamping a requested export to the raster ceilings. */
export type ClampedExport =
  | { readonly ok: true; readonly scale: number; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: 'no_bounds' };

/**
 * RFC-010 Q3 — compute the effective export scale + dimensions so the produced
 * raster honors EVERY ceiling at once: the requested scale is first clamped to
 * `[MIN_SCALE, MAX_SCALE]`, then DOWN-scaled further (never up) so the longest edge
 * is <= `MAX_EDGE_PX` and the total pixels are <= `MAX_RASTER_PX`. This DEGRADES
 * SAFELY — a huge canvas yields a smaller-but-valid image instead of an outright
 * failure — while a malicious/huge canvas can never reach `toImage` at a dangerous
 * size. The math is pure (no tldraw, no DOM) so it is unit-tested in isolation; the
 * iframe runtime calls this with the live page bounds.
 *
 * `baseWidth` / `baseHeight` are the canvas content bounds in CSS px at scale 1.
 * Non-finite or non-positive bounds → `{ ok: false }` (nothing to export).
 */
export function clampExportDimensions(baseWidth: number, baseHeight: number, requestedScale: number | undefined): ClampedExport {
  if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth <= 0 || baseHeight <= 0) {
    return { ok: false, reason: 'no_bounds' };
  }
  // Start from the requested scale clamped to the allowed range.
  let scale = clampScale(requestedScale);
  // Down-scale so the longest edge fits MAX_EDGE_PX.
  const longestEdge = Math.max(baseWidth, baseHeight) * scale;
  if (longestEdge > MAX_EDGE_PX) {
    scale = scale * (MAX_EDGE_PX / longestEdge);
  }
  // Down-scale further so the total pixels fit MAX_RASTER_PX.
  const totalPx = baseWidth * scale * (baseHeight * scale);
  if (totalPx > MAX_RASTER_PX) {
    scale = scale * Math.sqrt(MAX_RASTER_PX / totalPx);
  }
  // Floor the produced dimensions; clamp to >= 1 px so a tiny canvas still renders.
  const width = Math.max(1, Math.floor(baseWidth * scale));
  const height = Math.max(1, Math.floor(baseHeight * scale));
  return { ok: true, scale, width, height };
}

/** The iframe's export gate decision: proceed (with clamped params) or reject. */
export type ExportDecision =
  | { readonly proceed: true; readonly scale: number; readonly width: number; readonly height: number }
  | { readonly proceed: false; readonly error: string };

/**
 * RFC-010 §9.4 / §13 Q3 — the pure export GATE the iframe applies BEFORE calling
 * `editor.toImage`. Given the canvas content bounds (or `null` when the canvas is
 * empty / has no bounds), decide whether to rasterize and at what clamped scale.
 *
 * - No bounds (empty canvas) → reject WITHOUT rendering ("empty canvas").
 * - Otherwise → clamp to the raster ceilings (per-edge + total-MP) and proceed,
 *   AND assert the clamped dimensions are within the ceiling as a belt-and-braces
 *   invariant (a clamped result that somehow still breaches the ceiling rejects as
 *   "too large" rather than reaching `toImage`).
 *
 * Extracting this as a pure function lets `node --test` assert the gate refuses to
 * call `toImage` for an empty canvas (the "stub not called" check) without React.
 */
export function decideExport(bounds: { width: number; height: number } | null, requestedScale: number | undefined): ExportDecision {
  if (!bounds) {
    return { proceed: false, error: 'empty canvas' };
  }
  const clamped = clampExportDimensions(bounds.width, bounds.height, requestedScale);
  if (!clamped.ok) {
    return { proceed: false, error: 'empty canvas' };
  }
  // Belt-and-braces: the clamp should always land within the ceiling; if a future
  // edit to the clamp math regressed, this stops a dangerous raster reaching toImage.
  if (!withinRasterCeiling(clamped.width, clamped.height)) {
    return { proceed: false, error: 'too large' };
  }
  return { proceed: true, scale: clamped.scale, width: clamped.width, height: clamped.height };
}
