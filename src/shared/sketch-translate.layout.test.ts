/**
 * RFC-010 §13 Q2 — layout + z-order translation (`sketch-translate.layout.test.ts`).
 *
 * A `layout: { mode:'flow', direction:'row', gap }` doc with omitted coords yields
 * monotonically increasing x positions; `z` maps to ordered draw indices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSketchTranslation } from './sketch-translate.ts';
import { layoutSketch } from './sketch-layout.ts';
import { validateSketchDoc, isSketchParseFailure, type SketchDoc } from './sketch-dsl.ts';

function doc(value: unknown): SketchDoc {
  const result = validateSketchDoc(value);
  assert.ok(!isSketchParseFailure(result), `valid doc expected: ${JSON.stringify(result)}`);
  return result;
}

test('flow row layout with omitted coords → monotonically increasing x', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { id: 'b', type: 'rect', text: 'B' },
      { id: 'c', type: 'rect', text: 'C' },
    ],
    layout: { mode: 'flow', direction: 'row', gap: 48 },
  }));
  const xs = ['id:a', 'id:b', 'id:c'].map((k) => plan.shapes.find((s) => s.key === k)!.box.x);
  assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!, `x increasing: ${xs.join(',')}`);
  // The gap is honored: x[1] - (x[0] + w) === gap (default w=160).
  assert.equal(xs[1]! - (xs[0]! + 160), 48, 'row gap honored');
  // y stays constant in a row.
  const ys = ['id:a', 'id:b', 'id:c'].map((k) => plan.shapes.find((s) => s.key === k)!.box.y);
  assert.equal(new Set(ys).size, 1, 'all same y in a row');
});

test('flow col layout → monotonically increasing y, constant x', () => {
  const result = layoutSketch(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { id: 'b', type: 'rect', text: 'B' },
    ],
    layout: { mode: 'flow', direction: 'col', gap: 20 },
  }));
  const a = result.boxById.get('a')!;
  const b = result.boxById.get('b')!;
  assert.equal(a.x, b.x, 'same x in a column');
  assert.ok(b.y > a.y, 'y increases down the column');
  assert.equal(b.y - (a.y + a.h), 20, 'col gap honored');
});

test('absolute coords override layout for a specific shape', () => {
  const result = layoutSketch(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A', x: 500, y: 300 },
      { id: 'b', type: 'rect', text: 'B' },
    ],
    layout: { mode: 'flow', direction: 'row', gap: 48 },
  }));
  const a = result.boxById.get('a')!;
  assert.equal(a.x, 500, 'absolute x respected');
  assert.equal(a.y, 300, 'absolute y respected');
});

test('z-order maps to ascending draw order (back to front)', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'front', type: 'rect', text: 'front', z: 10 },
      { id: 'back', type: 'rect', text: 'back', z: 1 },
      { id: 'mid', type: 'rect', text: 'mid', z: 5 },
    ],
  }));
  // plan.shapes is sorted ascending by order; lower z draws first (behind).
  const order = plan.shapes.map((s) => s.key);
  assert.deepEqual(order, ['id:back', 'id:mid', 'id:front'], 'sorted back→front by z');
});

test('frames sort behind their children (lower order)', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'child', type: 'rect', text: 'child' },
      { id: 'grp', type: 'frame', text: 'group', children: ['child'] },
    ],
  }));
  const frameOrder = plan.shapes.find((s) => s.key === 'id:grp')!.order;
  const childOrder = plan.shapes.find((s) => s.key === 'id:child')!.order;
  assert.ok(frameOrder < childOrder, 'frame behind child');
});
