/**
 * RFC-010 §13 Q2 — `parseSketchDsl` validator checks (`sketch-dsl.test.ts`).
 *
 * Covers: a valid doc → typed shapes; each shape type; connector-by-id;
 * malformed / proto-pollution / out-of-bounds rejection; the cap set; partial
 * (per-shape) failure leaving other shapes intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSketchDsl,
  validateSketchDoc,
  isSketchParseFailure,
  MAX_SHAPES,
  MAX_COORD,
  MAX_DIM,
  MAX_TEXT_LEN,
  MAX_RAW_BYTES,
  type SketchDoc,
  type SketchParseFailure,
} from './sketch-dsl.ts';

function expectDoc(result: SketchDoc | SketchParseFailure): SketchDoc {
  assert.ok(!isSketchParseFailure(result), `expected a doc, got failure: ${JSON.stringify(result)}`);
  return result;
}

function expectFailure(result: SketchDoc | SketchParseFailure): SketchParseFailure {
  assert.ok(isSketchParseFailure(result), `expected a failure, got doc: ${JSON.stringify(result)}`);
  return result;
}

test('valid full doc parses to typed shapes (single deepEqual per shape set)', () => {
  const raw = JSON.stringify({
    shapes: [
      { id: 'orch', type: 'rect', text: 'Orchestrator', color: 'blue', z: 1 },
      { id: 'proxy', type: 'rect', text: 'Proxy', color: 'green', z: 1 },
      { id: 'db', type: 'ellipse', text: 'SQLite', color: 'violet', z: 1 },
      { type: 'arrow', from: 'orch', to: 'proxy', text: 'HTTP' },
    ],
    layout: { mode: 'flow', direction: 'row', gap: 48 },
  });
  const doc = expectDoc(parseSketchDsl(raw));
  assert.deepEqual(doc, {
    shapes: [
      { type: 'rect', id: 'orch', color: 'blue', z: 1, text: 'Orchestrator' },
      { type: 'rect', id: 'proxy', color: 'green', z: 1, text: 'Proxy' },
      { type: 'ellipse', id: 'db', color: 'violet', z: 1, text: 'SQLite' },
      { type: 'arrow', from: 'orch', to: 'proxy', text: 'HTTP' },
    ],
    layout: { mode: 'flow', direction: 'row', gap: 48 },
    notes: [],
  });
});

test('each shape type validates with its per-type fields', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [
      { type: 'rect', x: 10, y: 20, w: 100, h: 50, text: 'box', fill: 'solid' },
      { type: 'ellipse', x: 0, y: 0, w: 80, h: 80 },
      { type: 'text', text: 'a label', x: 5, y: 5, w: 120 },
      { type: 'note', text: 'sticky', color: 'yellow' },
      { type: 'frame', text: 'Group', children: ['a', 'b'] },
      { type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10, dash: 'dotted' },
      { type: 'line', points: [[0, 0], [10, 10], [20, 0]], color: 'red' },
    ],
  }));
  assert.deepEqual(doc.shapes, [
    { type: 'rect', x: 10, y: 20, w: 100, h: 50, text: 'box', fill: 'solid' },
    { type: 'ellipse', x: 0, y: 0, w: 80, h: 80 },
    { type: 'text', text: 'a label', x: 5, y: 5, w: 120 },
    { type: 'note', text: 'sticky', color: 'yellow' },
    { type: 'frame', text: 'Group', children: ['a', 'b'] },
    { type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10, dash: 'dotted' },
    { type: 'line', points: [[0, 0], [10, 10], [20, 0]], color: 'red' },
  ]);
});

test('connector-by-id: arrow with from/to keeps the id refs', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { id: 'b', type: 'rect', text: 'B' },
      { type: 'arrow', from: 'a', to: 'b' },
    ],
  }));
  const arrow = doc.shapes[2];
  assert.deepEqual(arrow, { type: 'arrow', from: 'a', to: 'b' });
});

test('proto-pollution: __proto__ / constructor / prototype keys reject the whole doc', () => {
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const f = expectFailure(validateSketchDoc({ shapes: [{ type: 'rect', [bad]: { polluted: true } }] }));
    assert.equal(f.kind, 'sketch_proto_key', `${bad} should trigger proto_key`);
  }
  // A `constructor` own-key nested deep is also caught. (`__proto__` as an OWN key
  // can only come from JSON.parse / Object.defineProperty — the literal and bracket
  // syntaxes both invoke the prototype setter; the raw-JSON __proto__ case is in
  // the next test. `constructor` IS a normal own key via a computed property.)
  const deep = expectFailure(validateSketchDoc({ shapes: [{ type: 'frame', children: [], meta: { ['constructor']: { x: 1 } } }] }));
  assert.equal(deep.kind, 'sketch_proto_key');
});

test('proto-pollution via raw JSON string is caught (JSON.parse own-prop __proto__)', () => {
  const f = expectFailure(parseSketchDsl('{"shapes":[{"type":"rect","__proto__":{"x":1}}]}'));
  assert.equal(f.kind, 'sketch_proto_key');
});

test('field-copy: an unexpected key never survives into the validated shape', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [{ type: 'rect', text: 'box', evilKey: 'whatever', onclick: 'alert(1)' }],
  }));
  const shape = doc.shapes[0]!;
  assert.deepEqual(Object.keys(shape).sort(), ['text', 'type']);
  assert.ok(!('evilKey' in shape));
  assert.ok(!('onclick' in shape));
});

test('non-object / missing shapes / non-array shapes fail at doc level', () => {
  assert.equal(expectFailure(validateSketchDoc(42)).kind, 'sketch_not_object');
  assert.equal(expectFailure(validateSketchDoc([])).kind, 'sketch_not_object'); // bare array rejected
  assert.equal(expectFailure(validateSketchDoc({})).kind, 'sketch_bad_shapes');
  assert.equal(expectFailure(validateSketchDoc({ shapes: 'nope' })).kind, 'sketch_bad_shapes');
});

test('unknown shape type is skipped (partial failure), not fatal', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [
      { type: 'rect', text: 'ok' },
      { type: 'pentagon', text: 'unknown' },
    ],
  }));
  assert.equal(doc.shapes.length, 1);
  assert.equal(doc.shapes[0]!.type, 'rect');
  assert.ok(doc.notes.length >= 1, 'a skip note is recorded');
});

test('a doc of only unknown/invalid shapes fails with no_valid_shapes', () => {
  const f = expectFailure(validateSketchDoc({ shapes: [{ type: 'pentagon' }, { type: 'text' }] }));
  assert.equal(f.kind, 'sketch_no_valid_shapes');
});

test('non-finite and out-of-bound coords/dims are rejected per field', () => {
  // NaN / Infinity coord on a box → that coord is dropped (box still valid via defaults).
  const doc = expectDoc(validateSketchDoc({
    shapes: [{ type: 'rect', x: Number.NaN, y: Infinity, w: 100, h: 50 }],
  }));
  const shape = doc.shapes[0]!;
  assert.ok(!('x' in shape), 'NaN x dropped');
  assert.ok(!('y' in shape), 'Infinity y dropped');
  assert.deepEqual(shape, { type: 'rect', w: 100, h: 50 });
});

test('out-of-bound coord magnitude is rejected; w/h over MAX_DIM rejected', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [{ type: 'rect', x: MAX_COORD + 1, w: MAX_DIM + 1, h: 50 }],
  }));
  const shape = doc.shapes[0]!;
  assert.ok(!('x' in shape), 'over-MAX_COORD x dropped');
  assert.ok(!('w' in shape), 'over-MAX_DIM w dropped');
  assert.deepEqual(shape, { type: 'rect', h: 50 });
});

test('arrow with non-finite coords (and no refs) is skipped', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [
      { type: 'rect', text: 'keep' },
      { type: 'arrow', x1: 0, y1: 0, x2: Infinity, y2: 0 },
    ],
  }));
  assert.equal(doc.shapes.length, 1);
  assert.equal(doc.shapes[0]!.type, 'rect');
});

test('bad color / fill / dash values are dropped (enum guard)', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [{ type: 'rect', color: 'chartreuse', fill: 'plaid', text: 'x' }],
  }));
  const shape = doc.shapes[0]!;
  assert.ok(!('color' in shape));
  assert.ok(!('fill' in shape));
  assert.deepEqual(shape, { type: 'rect', text: 'x' });
});

test('over-cap shape count fails the doc', () => {
  const shapes = Array.from({ length: MAX_SHAPES + 1 }, () => ({ type: 'rect', text: 'x' }));
  assert.equal(expectFailure(validateSketchDoc({ shapes })).kind, 'sketch_too_large');
});

test('over-cap raw block size fails before parse', () => {
  const big = 'x'.repeat(MAX_RAW_BYTES + 10);
  const raw = JSON.stringify({ shapes: [{ type: 'rect', text: big.slice(0, MAX_TEXT_LEN) }] }) + ' '.repeat(MAX_RAW_BYTES);
  assert.equal(expectFailure(parseSketchDsl(raw)).kind, 'sketch_too_large');
});

test('oversized text on a box is dropped; on a text shape it skips the shape', () => {
  const longText = 'a'.repeat(MAX_TEXT_LEN + 1);
  // On a rect, text is optional → dropped, shape stays.
  const rectDoc = expectDoc(validateSketchDoc({ shapes: [{ type: 'rect', text: longText }] }));
  assert.deepEqual(rectDoc.shapes[0], { type: 'rect' });
  // On a text shape, text is required → invalid → skipped → no valid shapes.
  const textFail = expectFailure(validateSketchDoc({ shapes: [{ type: 'text', text: longText }] }));
  assert.equal(textFail.kind, 'sketch_no_valid_shapes');
});

test('bad id charset / length is dropped; valid id kept', () => {
  const doc = expectDoc(validateSketchDoc({
    shapes: [
      { id: 'good_id-1', type: 'rect', text: 'a' },
      { id: 'bad id with spaces', type: 'rect', text: 'b' },
      { id: 'x'.repeat(100), type: 'rect', text: 'c' },
    ],
  }));
  assert.equal((doc.shapes[0] as { id?: string }).id, 'good_id-1');
  assert.ok(!('id' in doc.shapes[1]!), 'space id dropped');
  assert.ok(!('id' in doc.shapes[2]!), 'over-long id dropped');
});

test('dangling connector ref is preserved as data (translator drops it iframe-side)', () => {
  // The validator keeps the from/to ids; resolution (and the dangling-ref drop)
  // happens in the iframe translator against the id map (sketch-translate.test).
  const doc = expectDoc(validateSketchDoc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { type: 'arrow', from: 'a', to: 'ghost' },
    ],
  }));
  assert.deepEqual(doc.shapes[1], { type: 'arrow', from: 'a', to: 'ghost' });
});

test('over-cap points on a line skips the line', () => {
  const points = Array.from({ length: 300 }, (_v, i) => [i, i]);
  const f = expectFailure(validateSketchDoc({ shapes: [{ type: 'line', points }] }));
  assert.equal(f.kind, 'sketch_no_valid_shapes');
});

test('line needs >= 2 points', () => {
  const f = expectFailure(validateSketchDoc({ shapes: [{ type: 'line', points: [[0, 0]] }] }));
  assert.equal(f.kind, 'sketch_no_valid_shapes');
});

test('parseSketchDsl rejects non-JSON and non-string input', () => {
  assert.equal(expectFailure(parseSketchDsl('not json {{{')).kind, 'sketch_not_object');
  assert.equal(expectFailure(parseSketchDsl(42 as unknown)).kind, 'sketch_not_object');
});

test('layout defaults: partial layout fills direction=row, gap=48; bad mode drops layout', () => {
  const withDir = expectDoc(validateSketchDoc({ shapes: [{ type: 'rect', text: 'x' }], layout: { mode: 'flow' } }));
  assert.deepEqual(withDir.layout, { mode: 'flow', direction: 'row', gap: 48 });
  const badMode = expectDoc(validateSketchDoc({ shapes: [{ type: 'rect', text: 'x' }], layout: { mode: 'grid' } }));
  assert.equal(badMode.layout, undefined);
});
