/**
 * RFC-010 §7.4 / §7.5 — the chat-side sketch detection + render (PURE logic).
 *
 * THE TRAP (RFC §7.4, binding): `chat.ts` renders a message body by
 * `escapeHtml(text)` then `renderMarkdown(...)`. By the time markdown runs, the
 * fence info-string (the `sketch` after ```) has been DISCARDED and the body is
 * HTML-escaped (so `"` is `&quot;`, breaking `JSON.parse`). Therefore the sketch
 * pre-pass MUST run on the RAW message text BEFORE escape + markdown.
 *
 * This module does exactly that, as a pure string transform so it is unit-testable
 * without a DOM:
 *   1. `extractSketches(rawText)` finds ```sketch fences in the RAW text, validates
 *      each body with `parseSketchDsl`, and returns the text with each fence
 *      replaced by a sentinel placeholder, plus the parsed blocks.
 *   2. The caller runs the existing escape + markdown on the placeholdered text.
 *   3. `replaceSketchPlaceholders(html, blocks)` swaps each placeholder for either
 *      a static-SVG-preview MOUNT NODE (valid) or a plain code block + an
 *      "unparseable sketch" note (invalid).
 *
 * The mount node carries a `data-sketch-id` (an index into a per-message stash the
 * caller keeps), NOT the raw JSON inlined as a giant attribute. `wireSketches` in
 * chat.ts reads that stash to lazily mount the iframe on "open canvas".
 */

import { parseSketchDsl, isSketchParseFailure, type SketchDoc } from '../shared/sketch-dsl.ts';
import { renderSketchSvg } from './sketch-svg.ts';

/** A detected sketch block: valid (carries the doc) or invalid (carries the raw). */
export type SketchBlock =
  | { readonly ok: true; readonly doc: SketchDoc; readonly raw: string }
  | { readonly ok: false; readonly raw: string };

export type ExtractResult = {
  /** The raw text with each ```sketch fence replaced by a sentinel placeholder. */
  readonly text: string;
  /** The detected blocks, indexed; the placeholder for block N is the Nth sentinel. */
  readonly blocks: readonly SketchBlock[];
};

/** Sentinel placeholder for block N. Uses NULs so escape+markdown leave it intact. */
function placeholder(index: number): string {
  return `\x00SK${index}\x00`;
}

/**
 * Matches a fenced block whose info-string is exactly `sketch` (optionally with
 * trailing whitespace). Captures the raw, un-escaped body. The `m` is needed so
 * the fences are recognized at line starts; `g` to find all.
 *
 * NOTE: this runs on RAW text, so the body still has its real `"`/`<`/`&`.
 */
const SKETCH_FENCE = /```sketch[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Step 1: extract ```sketch fences from RAW message text (before escape+markdown).
 * Returns the placeholdered text + the validated/invalid blocks.
 */
export function extractSketches(rawText: string): ExtractResult {
  const blocks: SketchBlock[] = [];
  const text = rawText.replace(SKETCH_FENCE, (_match, body: string) => {
    const result = parseSketchDsl(body);
    const index = blocks.length;
    if (isSketchParseFailure(result)) {
      blocks.push({ ok: false, raw: body });
    } else {
      blocks.push({ ok: true, doc: result, raw: body });
    }
    return placeholder(index);
  });
  return { text, blocks };
}

/** Escape for safe interpolation into HTML attributes / text. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build the static-SVG-preview mount node HTML for a valid block. */
function renderMountNode(block: Extract<SketchBlock, { ok: true }>, sketchId: number): string {
  const svg = renderSketchSvg(block.doc);
  const noteCount = block.doc.notes.length;
  const note = noteCount > 0
    ? `<span class="sketch-note">${noteCount} shape${noteCount === 1 ? '' : 's'} skipped</span>`
    : '';
  // The raw DSL is stashed by the caller under data-sketch-id; it is NOT inlined.
  return `<div class="sketch-block" data-sketch-id="${sketchId}">` +
    `<div class="sketch-head"><span class="sketch-eyebrow">SKETCH</span>${note}` +
    `<button type="button" class="btn ghost sketch-open" data-sketch-open="${sketchId}">Open canvas</button></div>` +
    `<div class="sketch-preview">${svg}</div>` +
    `</div>`;
}

/** Build the graceful fallback for an invalid block: plain code block + a note. */
function renderInvalidBlock(block: Extract<SketchBlock, { ok: false }>): string {
  const code = esc(block.raw.replace(/\n$/, ''));
  return `<div class="sketch-block invalid">` +
    `<pre class="sketch-source"><code>${code}</code></pre>` +
    `<span class="sketch-note">unparseable sketch — showing source</span>` +
    `</div>`;
}

/**
 * Step 3: swap each sentinel placeholder in the rendered HTML for the SVG-preview
 * mount node (valid) or the plain-code fallback (invalid). Placeholders may have
 * been wrapped in `<p>...</p>` by markdown; we replace the bare sentinel, leaving
 * any wrapping tags (harmless).
 */
export function replaceSketchPlaceholders(html: string, blocks: readonly SketchBlock[]): string {
  return html.replace(/\x00SK(\d+)\x00/g, (_match, idxStr: string) => {
    const index = Number(idxStr);
    const block = blocks[index];
    if (!block) return '';
    return block.ok ? renderMountNode(block, index) : renderInvalidBlock(block);
  });
}

/**
 * Convenience: run the full pre-pass on raw text given the standard escape+markdown
 * step as a callback. Returns the final HTML AND the detected blocks (so the caller
 * can stash the valid blocks' DSL for the iframe). This keeps the ORDERING correct
 * (extract on raw → escape+markdown → replace) in one place.
 */
export function renderBodyWithSketches(
  rawText: string,
  escapeAndMarkdown: (text: string) => string,
): { html: string; blocks: readonly SketchBlock[] } {
  const { text, blocks } = extractSketches(rawText);
  if (blocks.length === 0) {
    return { html: escapeAndMarkdown(text), blocks };
  }
  const rendered = escapeAndMarkdown(text);
  const html = replaceSketchPlaceholders(rendered, blocks);
  return { html, blocks };
}
