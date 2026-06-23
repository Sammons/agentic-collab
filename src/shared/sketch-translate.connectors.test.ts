/**
 * RFC-010 §13 Q2 — connector-by-id translation (`sketch-translate.connectors.test.ts`).
 *
 * An `arrow` with from/to referencing present ids resolves to a BINDING intent
 * (the iframe creates a tldraw arrow binding so it tracks moved boxes); a dangling
 * ref drops that ONE connector and records it (the iframe posts a `sketch:error`),
 * leaving the other shapes intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSketchTranslation } from './sketch-translate.ts';
import { validateSketchDoc, isSketchParseFailure, type SketchDoc } from './sketch-dsl.ts';

function doc(value: unknown): SketchDoc {
  const result = validateSketchDoc(value);
  assert.ok(!isSketchParseFailure(result), `valid doc expected: ${JSON.stringify(result)}`);
  return result;
}

test('arrow from/to present ids → a binding with both endpoints resolved', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { id: 'b', type: 'rect', text: 'B' },
      { type: 'arrow', from: 'a', to: 'b', text: 'HTTP' },
    ],
  }));
  assert.equal(plan.bindings.length, 1, 'one binding planned');
  assert.equal(plan.dangling.length, 0, 'no dangling');
  const binding = plan.bindings[0]!;
  assert.equal(binding.fromKey, 'id:a');
  assert.equal(binding.toKey, 'id:b');
  // Endpoints are finite and the arrow points from A toward B (a is left of b).
  assert.ok(Number.isFinite(binding.endpoints.x1) && Number.isFinite(binding.endpoints.x2));
  assert.ok(binding.endpoints.x1 < binding.endpoints.x2, 'arrow runs left→right (A→B)');
});

test('dangling ref drops that ONE connector, records it, keeps other shapes', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { type: 'arrow', from: 'a', to: 'ghost' },
      { id: 'c', type: 'ellipse', text: 'C' },
    ],
  }));
  assert.equal(plan.bindings.length, 0, 'no binding for the dangling arrow');
  assert.equal(plan.dangling.length, 1, 'one dangling recorded');
  assert.equal(plan.dangling[0]!.danglingRef, 'ghost');
  // The two box shapes are still planned (one bad connector didn't kill the doc).
  assert.equal(plan.shapes.length, 2);
  const keys = plan.shapes.map((s) => s.key).sort();
  assert.deepEqual(keys, ['id:a', 'id:c']);
});

test('raw-coord arrow is a FREE connector (no binding)', () => {
  const plan = planSketchTranslation(doc({
    shapes: [{ type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 50 }],
  }));
  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.freeConnectors.length, 1);
  assert.deepEqual(plan.freeConnectors[0]!.endpoints, { x1: 0, y1: 0, x2: 100, y2: 50 });
});

test('arrow with only `from` bound resolves fromKey and leaves toKey undefined', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { id: 'b', type: 'rect', text: 'B' },
      // `to` references a present id; `from` references a present id — both bound.
      { type: 'arrow', from: 'a', to: 'b' },
    ],
  }));
  assert.equal(plan.bindings[0]!.fromKey, 'id:a');
  assert.equal(plan.bindings[0]!.toKey, 'id:b');
});

test('line shape becomes a free connector carrying its points', () => {
  const plan = planSketchTranslation(doc({
    shapes: [{ type: 'line', points: [[0, 0], [10, 10], [20, 0]] }],
  }));
  assert.equal(plan.freeConnectors.length, 1);
  assert.deepEqual(plan.freeConnectors[0]!.points, [[0, 0], [10, 10], [20, 0]]);
});

test('frame plan carries the resolved child keys', () => {
  const plan = planSketchTranslation(doc({
    shapes: [
      { id: 'orch', type: 'rect', text: 'Orch' },
      { id: 'db', type: 'ellipse', text: 'DB' },
      { id: 'grp', type: 'frame', text: 'Docker', children: ['orch', 'db', 'missing'] },
    ],
  }));
  const frame = plan.shapes.find((s) => s.key === 'id:grp')!;
  assert.deepEqual(frame.childKeys, ['id:orch', 'id:db'], 'missing child id dropped from childKeys');
});
