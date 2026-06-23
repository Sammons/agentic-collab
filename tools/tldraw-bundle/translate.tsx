/**
 * RFC-010 §7.2 — the IFRAME-SIDE translator: applies a `SketchTranslationPlan`
 * (computed by the pure `src/shared/sketch-translate.ts`) to a live tldraw editor.
 *
 * This is the thin tldraw-API adapter the RFC §7.2 calls for: a per-descriptor-type
 * lookup that builds `TLShapePartial`s by EXPLICIT FIELD-COPY (never spreading the
 * parsed descriptor, §9.4), creates them via `editor.createShapes(...)`, and creates
 * tldraw arrow BINDINGS for connector-by-id so arrows track moved boxes
 * (`editor.createBindings(...)`). z-order maps to tldraw's fractional index; frames
 * are real tldraw frame shapes; the layout pass already computed pixel positions.
 *
 * The brittle DECISIONS (which shapes, geometry, bindings, dangling drops) live in
 * the pure plan, unit-tested in `node --test`. This file only maps plan → API, so a
 * tldraw API change touches one small file. It runs only in the browser bundle.
 */

import {
  createShapeId,
  createBindingId,
  toRichText,
  type Editor,
  type TLShapeId,
  type TLShapePartial,
} from 'tldraw';

import { planSketchTranslation } from '../../src/shared/sketch-translate.ts';
import type { SketchDoc, SketchShape } from '../../src/shared/sketch-dsl.ts';

/** Map a sketch color name to a tldraw color (they share the named palette). */
function tlColor(shape: SketchShape): string {
  return ('color' in shape && shape.color) ? shape.color : 'black';
}

function tlFill(shape: SketchShape): string {
  return ('fill' in shape && shape.fill) ? shape.fill : 'none';
}

function tlDash(shape: SketchShape): string {
  if ((shape.type === 'arrow' || shape.type === 'line') && shape.dash) return shape.dash;
  return 'draw';
}

/**
 * Translate a validated `SketchDoc` and render it into the editor. Returns the list
 * of dangling connector refs so the caller can post `sketch:error` for each.
 */
export function translateAndRender(editor: Editor, doc: SketchDoc): { dangling: { index: number; danglingRef: string }[] } {
  const plan = planSketchTranslation(doc);

  // Stable plan-key → tldraw shape id so bindings can reference created shapes.
  const idByKey = new Map<string, TLShapeId>();
  const partials: TLShapePartial[] = [];

  // ── Box shapes (back to front by plan order) ────────────────────────────────
  for (const planned of plan.shapes) {
    const shapeId = createShapeId();
    idByKey.set(planned.key, shapeId);
    const partial = boxPartial(shapeId, planned.shape, planned.box);
    if (partial) partials.push(partial);
  }

  // ── Free connectors (raw-coord arrows + lines) ───────────────────────────────
  for (const free of plan.freeConnectors) {
    const shapeId = createShapeId();
    idByKey.set(free.key, shapeId);
    if (free.shape.type === 'line' && free.points) {
      partials.push(linePartial(shapeId, free.shape, free.points));
    } else if (free.endpoints) {
      partials.push(arrowPartial(shapeId, free.shape, free.endpoints));
    }
  }

  // ── Bound connectors (arrow-by-id) ───────────────────────────────────────────
  // Create the arrow shape first; bindings are created after all shapes exist.
  const bindingPlan: { arrowId: TLShapeId; fromId?: TLShapeId; toId?: TLShapeId }[] = [];
  for (const binding of plan.bindings) {
    const arrowId = createShapeId();
    idByKey.set(binding.key, arrowId);
    partials.push(arrowPartial(arrowId, binding.shape, binding.endpoints));
    bindingPlan.push({
      arrowId,
      fromId: binding.fromKey ? idByKey.get(binding.fromKey) : undefined,
      toId: binding.toKey ? idByKey.get(binding.toKey) : undefined,
    });
  }

  editor.createShapes(partials);

  // ── Arrow bindings (so connectors track moved boxes, §7.2) ───────────────────
  const bindings = [];
  for (const plan of bindingPlan) {
    if (plan.fromId) {
      bindings.push({
        id: createBindingId(),
        type: 'arrow' as const,
        fromId: plan.arrowId,
        toId: plan.fromId,
        props: { terminal: 'start' as const, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      });
    }
    if (plan.toId) {
      bindings.push({
        id: createBindingId(),
        type: 'arrow' as const,
        fromId: plan.arrowId,
        toId: plan.toId,
        props: { terminal: 'end' as const, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      });
    }
  }
  if (bindings.length > 0) editor.createBindings(bindings);

  // Frame children: parent the child shapes to their frame (tldraw frames own
  // their children by parentId; re-parent created children).
  for (const planned of plan.shapes) {
    if (planned.shape.type !== 'frame' || !planned.childKeys) continue;
    const frameId = idByKey.get(planned.key);
    if (!frameId) continue;
    const childIds = planned.childKeys.map((k) => idByKey.get(k)).filter((id): id is TLShapeId => id !== undefined);
    if (childIds.length > 0) editor.reparentShapes(childIds, frameId);
  }

  // Fit the view to the rendered content.
  editor.zoomToFit({ animation: { duration: 0 } });

  return { dangling: [...plan.dangling] };
}

/** Build a TLShapePartial for a box shape via explicit field-copy (§9.4). */
function boxPartial(id: TLShapeId, shape: SketchShape, box: { x: number; y: number; w: number; h: number }): TLShapePartial | null {
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
      return {
        id,
        type: 'geo',
        x: box.x,
        y: box.y,
        props: {
          geo: shape.type === 'ellipse' ? 'ellipse' : 'rectangle',
          w: box.w,
          h: box.h,
          color: tlColor(shape),
          fill: tlFill(shape),
          richText: toRichText(shape.text ?? ''),
        },
      } as TLShapePartial;
    case 'text':
      return {
        id,
        type: 'text',
        x: box.x,
        y: box.y,
        props: { richText: toRichText(shape.text), color: tlColor(shape), w: box.w, autoSize: false },
      } as TLShapePartial;
    case 'note':
      return {
        id,
        type: 'note',
        x: box.x,
        y: box.y,
        props: { richText: toRichText(shape.text), color: tlColor(shape) },
      } as TLShapePartial;
    case 'frame':
      return {
        id,
        type: 'frame',
        x: box.x,
        y: box.y,
        props: { w: box.w, h: box.h, name: shape.text ?? '' },
      } as TLShapePartial;
    default:
      return null;
  }
}

function arrowPartial(id: TLShapeId, shape: SketchShape, ends: { x1: number; y1: number; x2: number; y2: number }): TLShapePartial {
  return {
    id,
    type: 'arrow',
    x: 0,
    y: 0,
    props: {
      start: { x: ends.x1, y: ends.y1 },
      end: { x: ends.x2, y: ends.y2 },
      color: tlColor(shape),
      dash: tlDash(shape),
      richText: toRichText('text' in shape && shape.text ? shape.text : ''),
    },
  } as TLShapePartial;
}

function linePartial(id: TLShapeId, shape: SketchShape, points: readonly (readonly [number, number])[]): TLShapePartial {
  // tldraw line points are an object keyed by index-id with {id,index,x,y}.
  const origin = points[0] ?? [0, 0];
  const pointEntries: Record<string, { id: string; index: string; x: number; y: number }> = {};
  points.forEach((p, i) => {
    const key = `p${i}`;
    pointEntries[key] = { id: key, index: `a${i + 1}`, x: p[0] - origin[0], y: p[1] - origin[1] };
  });
  return {
    id,
    type: 'line',
    x: origin[0],
    y: origin[1],
    props: { color: tlColor(shape), dash: tlDash(shape), points: pointEntries },
  } as TLShapePartial;
}
