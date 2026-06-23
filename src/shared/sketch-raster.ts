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
 * True when a `width * height` raster is within `MAX_RASTER_PX`. Non-finite or
 * non-positive dimensions are treated as out-of-bounds (false) so a NaN can never
 * sneak past the guard.
 */
export function withinRasterCeiling(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  return width * height <= MAX_RASTER_PX;
}
