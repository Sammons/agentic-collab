/**
 * RFC-010 §7.2 — the DSL → tldraw translation PLAN (pure, testable).
 *
 * The actual `editor.createShapes(...)` / `editor.createBindings(...)` calls run
 * only in the browser (the iframe runtime, `tools/tldraw-bundle/entry.tsx`), so
 * they cannot be unit-tested in `node --test`. The brittle DECISIONS, however —
 * which shapes to create, what their resolved geometry / z-order is, which
 * connectors bind to which shapes by id, and which connectors are dangling and
 * must be DROPPED with a `sketch:error` — are pure data transforms. This module
 * computes that PLAN from a validated `SketchDoc`; the iframe applies it.
 *
 * Keeping the plan here means: (a) the translate-connectors and translate-layout
 * checks (RFC §13 Q2) exercise the real decision logic, not a stub; (b) the iframe
 * stays a thin adapter (plan → tldraw API), so a tldraw API change touches one
 * small file, not the logic.
 */

import type { SketchDoc, SketchShape } from './sketch-dsl.ts';
import {
  layoutSketch,
  connectorEndpoints,
  type LaidOutBox,
} from './sketch-layout.ts';

/** A planned tldraw box shape (rect/ellipse/text/note/frame). */
export type PlannedShape = {
  /** Stable internal key derived from the descriptor id or a synthesized index. */
  readonly key: string;
  /** The original descriptor (the iframe reads type-specific props off it). */
  readonly shape: SketchShape;
  /** Resolved pixel box. */
  readonly box: LaidOutBox;
  /** Resolved draw order (ascending = back to front). */
  readonly order: number;
  /** For a frame: the keys of its children (resolved + present). */
  readonly childKeys?: readonly string[];
};

/** A planned connector that binds to shapes by id (tldraw arrow binding). */
export type PlannedBinding = {
  readonly key: string;
  readonly shape: Extract<SketchShape, { type: 'arrow' }>;
  /** Key of the source box (the iframe binds the arrow start here). */
  readonly fromKey?: string | undefined;
  /** Key of the target box (the iframe binds the arrow end here). */
  readonly toKey?: string | undefined;
  /** Resolved endpoints (used when only one end is bound, or for initial geometry). */
  readonly endpoints: { x1: number; y1: number; x2: number; y2: number };
};

/** A planned free connector positioned by raw coords (no binding). */
export type PlannedFreeConnector = {
  readonly key: string;
  readonly shape: Extract<SketchShape, { type: 'arrow' | 'line' }>;
  readonly endpoints: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Points for a polyline (line shape). */
  readonly points?: readonly (readonly [number, number])[];
};

/** A connector that referenced an id NOT present in the doc — dropped. */
export type DanglingConnector = {
  readonly index: number;
  readonly danglingRef: string;
};

export type SketchTranslationPlan = {
  readonly shapes: readonly PlannedShape[];
  readonly bindings: readonly PlannedBinding[];
  readonly freeConnectors: readonly PlannedFreeConnector[];
  /** Connectors dropped for a dangling from/to id (the iframe posts sketch:error). */
  readonly dangling: readonly DanglingConnector[];
};

function keyFor(shape: SketchShape, index: number): string {
  return shape.id ? `id:${shape.id}` : `idx:${index}`;
}

/**
 * Compute the full translation plan for a validated doc. Pure: no tldraw, no DOM.
 */
export function planSketchTranslation(doc: SketchDoc): SketchTranslationPlan {
  const layout = layoutSketch(doc);

  // Build the id → key map and the index → key map from the original order.
  const keyByIndex = new Map<number, string>();
  const keyById = new Map<string, string>();
  doc.shapes.forEach((shape, index) => {
    const key = keyFor(shape, index);
    keyByIndex.set(index, key);
    if (shape.id) keyById.set(shape.id, key);
  });

  // Box shapes (rect/ellipse/text/note/frame), draw-ordered by the layout pass.
  const shapes: PlannedShape[] = [];
  for (const laid of layout.boxes) {
    const index = doc.shapes.indexOf(laid.shape);
    const key = keyByIndex.get(index) ?? keyFor(laid.shape, index);
    const planned: PlannedShape = laid.shape.type === 'frame' && laid.shape.children
      ? {
          key,
          shape: laid.shape,
          box: laid.box,
          order: laid.order,
          childKeys: laid.shape.children.map((id) => keyById.get(id)).filter((k): k is string => k !== undefined),
        }
      : { key, shape: laid.shape, box: laid.box, order: laid.order };
    shapes.push(planned);
  }

  const bindings: PlannedBinding[] = [];
  const freeConnectors: PlannedFreeConnector[] = [];
  const dangling: DanglingConnector[] = [];

  doc.shapes.forEach((shape, index) => {
    const key = keyByIndex.get(index)!;
    if (shape.type === 'line') {
      const points = shape.points;
      // First point is the origin; tldraw positions the polyline at points[0].
      const endpoints = points.length >= 2
        ? { x1: points[0]![0], y1: points[0]![1], x2: points[points.length - 1]![0], y2: points[points.length - 1]![1] }
        : null;
      freeConnectors.push({ key, shape, endpoints, points });
      return;
    }
    if (shape.type !== 'arrow') return;

    const usesRefs = shape.from !== undefined || shape.to !== undefined;
    if (usesRefs) {
      const ends = connectorEndpoints(shape, layout.boxById);
      if (ends && ends.danglingRef !== undefined) {
        dangling.push({ index, danglingRef: ends.danglingRef });
        return;
      }
      if (!ends) {
        // Both refs absent somehow — should not happen for a ref arrow; skip.
        return;
      }
      bindings.push({
        key,
        shape,
        fromKey: shape.from !== undefined ? keyById.get(shape.from) : undefined,
        toKey: shape.to !== undefined ? keyById.get(shape.to) : undefined,
        endpoints: { x1: ends.x1, y1: ends.y1, x2: ends.x2, y2: ends.y2 },
      });
      return;
    }

    // Raw-coord arrow → free connector (no binding).
    const ends = connectorEndpoints(shape, layout.boxById);
    freeConnectors.push({ key, shape, endpoints: ends ? { x1: ends.x1, y1: ends.y1, x2: ends.x2, y2: ends.y2 } : null });
  });

  return { shapes, bindings, freeConnectors, dangling };
}
