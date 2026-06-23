/**
 * RFC-010 §13 Q2 — detection-before-escape, THE TRAP (`chat.sketch-detect.test.ts`).
 *
 * A ```sketch block whose JSON contains `"`, `<`, `&`, and `__proto__`-adjacent
 * text is detected on the RAW text and `JSON.parse`s intact (the parsed doc equals
 * expected). A NON-sketch fence is untouched and still renders as a normal code
 * block. This proves the pre-pass runs BEFORE escape+markdown (§7.4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSketches, renderBodyWithSketches, replaceSketchPlaceholders } from './sketch-chat.ts';

test('a sketch block with quotes/</&/__proto__-adjacent text parses intact on RAW text', () => {
  // The text fields carry the exact chars that escape+markdown would mangle.
  const raw = [
    'Here is a diagram:',
    '',
    '```sketch',
    '{',
    '  "shapes": [',
    '    { "type": "rect", "text": "<A> & \\"B\\" __proto__ stuff" },',
    '    { "type": "ellipse", "text": "x < y && z" }',
    '  ]',
    '}',
    '```',
    '',
    'Done.',
  ].join('\n');

  const { blocks } = extractSketches(raw);
  assert.equal(blocks.length, 1, 'one sketch block detected');
  const block = blocks[0]!;
  assert.ok(block.ok, 'block parsed (JSON survived intact on raw text)');
  if (block.ok) {
    // The text fields survived with their real characters (NOT HTML-escaped).
    assert.deepEqual(block.doc.shapes, [
      { type: 'rect', text: '<A> & "B" __proto__ stuff' },
      { type: 'ellipse', text: 'x < y && z' },
    ]);
  }
});

test('a NON-sketch fenced block is untouched (no block detected, no placeholder)', () => {
  const raw = [
    'Some code:',
    '```ts',
    'const x = "<a> & b";',
    '```',
  ].join('\n');
  const { text, blocks } = extractSketches(raw);
  assert.equal(blocks.length, 0, 'no sketch detected');
  assert.equal(text, raw, 'raw text unchanged for a non-sketch fence');
});

test('a non-sketch fence renders as a normal code block (full pipeline)', () => {
  const raw = '```js\nconsole.log("hi");\n```';
  const { html, blocks } = renderBodyWithSketches(raw, (t) => {
    // Mimic the chat pipeline closely enough for the assertion.
    const esc = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return esc.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  });
  assert.equal(blocks.length, 0);
  assert.ok(html.includes('<pre><code>'), 'rendered as a code block');
  assert.ok(html.includes('console.log'), 'code content present');
});

test('the placeholder survives an escape+markdown pass (NUL sentinel, not mangled)', () => {
  const raw = '```sketch\n{"shapes":[{"type":"rect","text":"ok"}]}\n```';
  const { text, blocks } = extractSketches(raw);
  assert.equal(blocks.length, 1);
  // The placeholder is the NUL sentinel; escaping/markdown must not touch it.
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  assert.ok(/\x00SK0\x00/.test(escaped), 'sentinel survives HTML-escape');
  // And the raw JSON is NOT present in the placeholdered text.
  assert.ok(!text.includes('"shapes"'), 'raw JSON replaced by the placeholder');
});

test('multiple sketch blocks get distinct placeholders + indices', () => {
  const raw = [
    '```sketch',
    '{"shapes":[{"type":"rect","text":"one"}]}',
    '```',
    'middle',
    '```sketch',
    '{"shapes":[{"type":"ellipse","text":"two"}]}',
    '```',
  ].join('\n');
  const { text, blocks } = extractSketches(raw);
  assert.equal(blocks.length, 2);
  assert.ok(text.includes('\x00SK0\x00') && text.includes('\x00SK1\x00'), 'two distinct placeholders');
});

test('an invalid sketch block is detected as ok:false (graceful fallback)', () => {
  const raw = '```sketch\n{ not valid json\n```';
  const { blocks } = extractSketches(raw);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.ok, false, 'invalid JSON → ok:false block');
});

test('proto-pollution in a sketch block is rejected (block becomes ok:false)', () => {
  const raw = '```sketch\n{"shapes":[{"type":"rect","__proto__":{"x":1}}]}\n```';
  const { blocks } = extractSketches(raw);
  assert.equal(blocks[0]!.ok, false, 'proto-key sketch is not accepted');
});

test('an injected NUL sentinel in message text cannot spoof a sketch (anti-spoof gate)', () => {
  // §7.4 gate: a message that embeds the raw sentinel bytes `\x00SK0\x00` must NOT
  // be turned into a second sketch mount. The NUL is stripped before extraction, so
  // only placeholders WE inject survive.
  const raw = [
    '```sketch',
    '{"shapes":[{"type":"rect","text":"real"}]}',
    '```',
    'now the attacker tries: \x00SK0\x00 and also \x00SK7\x00',
  ].join('\n');
  const { text, blocks } = extractSketches(raw);
  assert.equal(blocks.length, 1, 'exactly one real block detected');
  // The injected sentinels are gone; the only NUL sentinel left is our own block 0.
  const sentinels = text.match(/\x00SK\d+\x00/g) ?? [];
  assert.deepEqual(sentinels, ['\x00SK0\x00'], 'only the genuine placeholder remains');
  assert.ok(!text.includes('\x00SK7\x00'), 'injected out-of-range sentinel stripped');
});

test('full pipeline: an injected sentinel renders no extra sketch mount', () => {
  const escapeAndMarkdown = (t: string): string =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const raw = [
    '```sketch',
    '{"shapes":[{"type":"rect","text":"real"}]}',
    '```',
    'spoof attempt: \x00SK0\x00',
  ].join('\n');
  const { html, blocks } = renderBodyWithSketches(raw, escapeAndMarkdown);
  assert.equal(blocks.length, 1);
  const mounts = html.match(/data-sketch-id="/g) ?? [];
  assert.equal(mounts.length, 1, 'one real sketch → exactly one mount node, not two');
});

test('replaceSketchPlaceholders drops an out-of-range index to empty (no crash, no leak)', () => {
  // Even if a sentinel for a missing block reached this stage, it renders nothing.
  const out = replaceSketchPlaceholders('before \x00SK9\x00 after', []);
  assert.equal(out, 'before  after', 'out-of-range placeholder → empty string');
});
