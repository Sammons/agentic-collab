/**
 * RFC-010 §1.1c / §5.2 — the zero-dep static SVG preview of a sketch.
 *
 * Renders a validated `SketchDoc` into an inline SVG string for the chat message
 * feed. NO tldraw, NO React, NO iframe — pure vanilla TS so the normal chat path
 * (and the inline-preview path) pay nothing for the heavy editor. This is the
 * default render; the heavy tldraw canvas is lazy-loaded only when the operator
 * clicks "open canvas". It also doubles as the graceful path when the iframe /
 * bundle is unavailable.
 *
 * SECURITY: every piece of agent-authored text (`text`, ids in notes) is escaped
 * before it touches the SVG/DOM. SVG text content is escaped the same way HTML is
 * (`& < > " '`) because the SVG sits inside the dashboard's HTML document.
 */

import type { SketchDoc, SketchShape } from '../shared/sketch-dsl.ts';
import {
  layoutSketch,
  connectorEndpoints,
  COLOR_HEX,
  type LaidOutBox,
} from '../shared/sketch-layout.ts';

/** Viewport the preview renders into (the SVG scales to fit this box). */
const PREVIEW_MAX_W = 640;
const PREVIEW_MAX_H = 360;
/** Padding around the content bounds inside the viewBox. */
const VIEW_PADDING = 16;

/** Escape text for safe interpolation into SVG/HTML markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Numeric attribute formatter: round to 2dp, guard against non-finite. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return (Math.round(value * 100) / 100).toString();
}

function colorOf(shape: SketchShape): string {
  const color = 'color' in shape ? shape.color : undefined;
  return color ? COLOR_HEX[color] : COLOR_HEX.black;
}

function fillOf(shape: SketchShape, stroke: string): string {
  const fill = 'fill' in shape ? shape.fill : undefined;
  if (!fill || fill === 'none') return 'none';
  if (fill === 'solid') return stroke;
  // semi / pattern → a light tint (we don't have tldraw's hatch, approximate).
  return stroke;
}

function fillOpacity(shape: SketchShape): string {
  const fill = 'fill' in shape ? shape.fill : undefined;
  if (fill === 'semi' || fill === 'pattern') return '0.18';
  if (fill === 'solid') return '0.9';
  return '1';
}

/** Wrap/clip label text to fit a box width (single line, ellipsized). */
function labelText(text: string, boxW: number): string {
  const maxChars = Math.max(4, Math.floor(boxW / 7));
  const trimmed = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
  return esc(trimmed);
}

function renderBoxLabel(text: string | undefined, box: LaidOutBox, color: string): string {
  if (!text) return '';
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return `<text x="${num(cx)}" y="${num(cy)}" text-anchor="middle" dominant-baseline="central" font-size="13" font-family="var(--mono, monospace)" fill="${color}">${labelText(text, box.w)}</text>`;
}

/** Render one box-shape (rect/ellipse/text/note/frame). */
function renderBox(shape: SketchShape, box: LaidOutBox): string {
  const stroke = colorOf(shape);
  switch (shape.type) {
    case 'rect': {
      const fill = fillOf(shape, stroke);
      return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="6" fill="${fill}" fill-opacity="${fillOpacity(shape)}" stroke="${stroke}" stroke-width="2"/>` + renderBoxLabel(shape.text, box, stroke);
    }
    case 'ellipse': {
      const fill = fillOf(shape, stroke);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      return `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(box.w / 2)}" ry="${num(box.h / 2)}" fill="${fill}" fill-opacity="${fillOpacity(shape)}" stroke="${stroke}" stroke-width="2"/>` + renderBoxLabel(shape.text, box, stroke);
    }
    case 'text': {
      // Left-aligned text shape (no box outline).
      return `<text x="${num(box.x)}" y="${num(box.y + 16)}" font-size="14" font-family="var(--mono, monospace)" fill="${stroke}">${labelText(shape.text, box.w)}</text>`;
    }
    case 'note': {
      const fill = stroke === COLOR_HEX.black ? COLOR_HEX.yellow : stroke;
      return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="2" fill="${fill}" fill-opacity="0.25" stroke="${fill}" stroke-width="1.5"/>` + renderBoxLabel(shape.text, box, COLOR_HEX.black);
    }
    case 'frame': {
      const label = shape.text
        ? `<text x="${num(box.x + 8)}" y="${num(box.y + 14)}" font-size="11" font-family="var(--mono, monospace)" fill="${stroke}" fill-opacity="0.8">${labelText(shape.text, box.w - 16)}</text>`
        : '';
      return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="4" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.7"/>` + label;
    }
    default:
      return '';
  }
}

function dashArray(shape: Extract<SketchShape, { type: 'arrow' | 'line' }>): string {
  const dash = 'dash' in shape ? shape.dash : undefined;
  if (dash === 'dashed') return ' stroke-dasharray="6 4"';
  if (dash === 'dotted') return ' stroke-dasharray="2 4"';
  return '';
}

/**
 * Render a `SketchDoc` to an inline `<svg>` string. The doc must already be
 * validated (`parseSketchDsl`). Returns a self-contained SVG element string sized
 * to fit `PREVIEW_MAX_W` x `PREVIEW_MAX_H` while preserving aspect ratio.
 */
export function renderSketchSvg(doc: SketchDoc): string {
  const { boxes, boxById, bounds } = layoutSketch(doc);

  const vbX = bounds.x - VIEW_PADDING;
  const vbY = bounds.y - VIEW_PADDING;
  const vbW = Math.max(1, bounds.w + VIEW_PADDING * 2);
  const vbH = Math.max(1, bounds.h + VIEW_PADDING * 2);

  // Fit into the preview box, preserving aspect ratio.
  const scale = Math.min(PREVIEW_MAX_W / vbW, PREVIEW_MAX_H / vbH, 1);
  const renderW = Math.round(vbW * scale);
  const renderH = Math.round(vbH * scale);

  const parts: string[] = [];

  // Arrow marker (one shared definition).
  parts.push(
    `<defs><marker id="sk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`,
  );

  // Box shapes (already draw-ordered back-to-front).
  for (const laid of boxes) {
    parts.push(renderBox(laid.shape, laid.box));
  }

  // Connectors render last (on top of boxes).
  for (const shape of doc.shapes) {
    if (shape.type === 'arrow') {
      const ends = connectorEndpoints(shape, boxById);
      if (!ends || ends.danglingRef !== undefined) continue;
      const stroke = colorOf(shape);
      parts.push(
        `<g color="${stroke}"><line x1="${num(ends.x1)}" y1="${num(ends.y1)}" x2="${num(ends.x2)}" y2="${num(ends.y2)}" stroke="${stroke}" stroke-width="2"${dashArray(shape)} marker-end="url(#sk-arrow)"/></g>`,
      );
      if (shape.text) {
        const mx = (ends.x1 + ends.x2) / 2;
        const my = (ends.y1 + ends.y2) / 2;
        parts.push(
          `<text x="${num(mx)}" y="${num(my - 4)}" text-anchor="middle" font-size="11" font-family="var(--mono, monospace)" fill="${stroke}">${labelText(shape.text, 80)}</text>`,
        );
      }
    } else if (shape.type === 'line') {
      const stroke = colorOf(shape);
      const points = shape.points.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
      parts.push(`<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="2"${dashArray(shape)}/>`);
    }
  }

  return `<svg class="sketch-svg" width="${renderW}" height="${renderH}" viewBox="${num(vbX)} ${num(vbY)} ${num(vbW)} ${num(vbH)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="sketch preview">${parts.join('')}</svg>`;
}
