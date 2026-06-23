/**
 * RFC-010 §13 Q2 — sketch render to mount node / fallback (`chat.sketch-render.test.ts`).
 *
 * A valid ```sketch block becomes an SVG-preview MOUNT NODE (with `data-sketch-id`,
 * NOT the raw JSON, and an "open canvas" control); an invalid block becomes a plain
 * code block + an "unparseable sketch" note.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBodyWithSketches } from './sketch-chat.ts';

/** A minimal escape+markdown stand-in for the chat pipeline. */
function escapeAndMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

test('a valid sketch block becomes an SVG-preview mount node with data-sketch-id + open control', () => {
  const raw = '```sketch\n{"shapes":[{"id":"a","type":"rect","text":"Box"}]}\n```';
  const { html, blocks } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0]!.ok);
  assert.ok(html.includes('data-sketch-id="0"'), 'mount node carries the sketch id');
  assert.ok(html.includes('class="sketch-block"'), 'is a sketch block');
  assert.ok(html.includes('<svg'), 'static SVG preview rendered inline');
  assert.ok(html.includes('data-sketch-open="0"'), 'has the open-canvas control');
  assert.ok(html.includes('Open canvas'), 'control label present');
  // The raw JSON is NOT inlined into the markup.
  assert.ok(!html.includes('"shapes"'), 'raw JSON not present in the rendered markup');
});

test('an invalid sketch block becomes a plain code block + unparseable note', () => {
  const raw = '```sketch\nnot json at all {{{\n```';
  const { html, blocks } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.ok, false);
  assert.ok(html.includes('sketch-block invalid'), 'marked invalid');
  assert.ok(html.includes('<pre'), 'shows the source as a code block');
  assert.ok(html.includes('unparseable sketch'), 'has the unparseable note');
});

test('the SVG preview escapes agent text (no raw script survives into markup)', () => {
  const raw = '```sketch\n{"shapes":[{"type":"rect","text":"<script>alert(1)</script>"}]}\n```';
  const { html } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'no raw script tag');
  assert.ok(html.includes('&lt;script&gt;'), 'agent text escaped in the SVG label');
});

test('surrounding prose still renders normally around a sketch block', () => {
  const raw = 'before\n\n```sketch\n{"shapes":[{"type":"rect","text":"x"}]}\n```\n\nafter';
  const { html } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.ok(html.includes('before'), 'leading prose kept');
  assert.ok(html.includes('after'), 'trailing prose kept');
  assert.ok(html.includes('sketch-block'), 'sketch rendered between them');
});

test('a doc with skipped shapes surfaces a skip note in the mount node', () => {
  const raw = '```sketch\n{"shapes":[{"type":"rect","text":"ok"},{"type":"pentagon"}]}\n```';
  const { html, blocks } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.ok(blocks[0]!.ok);
  assert.ok(html.includes('skipped'), 'skip note rendered');
});

test('no sketch block → the pipeline output is exactly escapeAndMarkdown(text)', () => {
  const raw = 'just <b>text</b> & stuff';
  const { html, blocks } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.equal(blocks.length, 0);
  assert.equal(html, escapeAndMarkdown(raw), 'unchanged path is a clean pass-through');
});
