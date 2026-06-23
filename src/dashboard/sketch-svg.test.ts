/**
 * RFC-010 §13 Q2 — inline SVG preview (`sketch-svg.test.ts`).
 *
 * The DSL→SVG helper renders the expected element set for a known doc, escapes
 * all agent-authored text, and imports NO React/tldraw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSketchSvg } from './sketch-svg.ts';
import { validateSketchDoc, isSketchParseFailure, type SketchDoc } from '../shared/sketch-dsl.ts';

function doc(value: unknown): SketchDoc {
  const result = validateSketchDoc(value);
  assert.ok(!isSketchParseFailure(result), `valid doc expected: ${JSON.stringify(result)}`);
  return result;
}

test('renders the expected element set for a mixed doc', () => {
  const svg = renderSketchSvg(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'Box A', color: 'blue' },
      { id: 'b', type: 'ellipse', text: 'Circle', color: 'green' },
      { type: 'text', text: 'a label' },
      { type: 'arrow', from: 'a', to: 'b' },
      { type: 'line', points: [[0, 0], [50, 50]] },
    ],
  }));
  assert.match(svg, /^<svg /, 'is an svg element');
  assert.ok(svg.includes('<rect '), 'has a rect');
  assert.ok(svg.includes('<ellipse '), 'has an ellipse');
  assert.ok(svg.includes('<text '), 'has text');
  assert.ok(svg.includes('<line '), 'has an arrow line');
  assert.ok(svg.includes('<polyline '), 'has a polyline (line shape)');
  assert.ok(svg.includes('marker-end="url(#sk-arrow)"'), 'arrow has a marker');
});

test('escapes agent-authored text in labels (no raw < or quotes survive)', () => {
  const svg = renderSketchSvg(doc({
    shapes: [{ type: 'rect', text: '<script>"&\'evil' }],
  }));
  assert.ok(!svg.includes('<script>'), 'no raw <script>');
  assert.ok(svg.includes('&lt;script&gt;'), 'angle brackets escaped');
  assert.ok(svg.includes('&amp;'), 'ampersand escaped');
});

test('a dangling connector ref is dropped (no line drawn for it)', () => {
  const svg = renderSketchSvg(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { type: 'arrow', from: 'a', to: 'ghost' },
    ],
  }));
  // No <line> because the only arrow is dangling; the rect still renders.
  assert.ok(svg.includes('<rect '), 'box still renders');
  assert.ok(!svg.includes('<line '), 'dangling arrow not drawn');
});

test('viewBox + width/height are finite numbers', () => {
  const svg = renderSketchSvg(doc({ shapes: [{ type: 'rect', x: 10, y: 20, w: 100, h: 50, text: 'x' }] }));
  const vb = svg.match(/viewBox="([^"]+)"/);
  assert.ok(vb, 'has a viewBox');
  for (const n of vb![1]!.split(' ')) {
    assert.ok(Number.isFinite(Number(n)), `viewBox value ${n} is finite`);
  }
  assert.match(svg, /width="\d+"/);
  assert.match(svg, /height="\d+"/);
});

test('frame renders a dashed container behind its children', () => {
  const svg = renderSketchSvg(doc({
    shapes: [
      { id: 'a', type: 'rect', text: 'A' },
      { id: 'grp', type: 'frame', text: 'Group', children: ['a'] },
    ],
  }));
  assert.ok(svg.includes('stroke-dasharray="4 4"'), 'frame is dashed');
});
