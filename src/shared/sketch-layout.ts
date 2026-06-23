/**
 * RFC-010 §7.2 — the shared layout pass.
 *
 * Both the zero-dep static SVG preview (`src/dashboard/sketch-svg.ts`) and the
 * iframe tldraw translator (`tools/tldraw-bundle/entry.tsx`) need to turn a
 * validated `SketchDoc` into concrete pixel boxes: defaults for omitted sizes, and
 * flow-layout positions (row/col with gaps) when the agent declared structure
 * instead of absolute coords. Putting it in `src/shared/` keeps the preview and the
 * canvas geometrically consistent and lets the layout math be unit-tested directly.
 *
 * The pass is intentionally simple (per RFC §7.2 "simple flow"): it places
 * non-connector, non-child shapes that LACK absolute coords in a row or column
 * with a fixed gap; shapes WITH absolute coords keep them (absolute overrides
 * layout). Connectors (arrow/line) and frame children are positioned by reference,
 * not by the flow.
 */

import type { SketchDoc, SketchShape, SketchColor } from './sketch-dsl.ts';

/** Default box dimensions when the agent omits w/h. */
export const DEFAULT_W = 160;
export const DEFAULT_H = 80;
export const DEFAULT_TEXT_W = 200;
export const DEFAULT_TEXT_H = 32;
export const DEFAULT_NOTE_SIZE = 120;
/** Padding a frame adds around its children's bounding box. */
export const FRAME_PADDING = 24;
/** Where the flow starts. */
export const FLOW_ORIGIN_X = 40;
export const FLOW_ORIGIN_Y = 40;

/** A concrete, laid-out rectangle for a shape (pixels). */
export type LaidOutBox = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** A laid-out shape: the descriptor plus its computed box + draw order. */
export type LaidOutShape = {
  readonly shape: SketchShape;
  readonly box: LaidOutBox;
  /** Resolved draw order (ascending = back to front). */
  readonly order: number;
};

/** The full layout result: positioned boxes by index + the id→box map. */
export type SketchLayoutResult = {
  /** Laid-out non-connector shapes (rect/ellipse/text/note/frame), draw-ordered. */
  readonly boxes: readonly LaidOutShape[];
  /** Map of shape id → its laid-out box (for connector endpoint resolution). */
  readonly boxById: ReadonlyMap<string, LaidOutBox>;
  /** Overall content bounds (for the SVG viewBox). */
  readonly bounds: LaidOutBox;
};

type BoxShape = Extract<SketchShape, { type: 'rect' | 'ellipse' | 'text' | 'note' | 'frame' }>;

/** True for shapes that occupy a box (everything except connectors). */
function isBoxShape(shape: SketchShape): shape is BoxShape {
  return shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'text' || shape.type === 'note' || shape.type === 'frame';
}

function defaultSize(shape: SketchShape): { w: number; h: number } {
  if (shape.type === 'text') return { w: DEFAULT_TEXT_W, h: DEFAULT_TEXT_H };
  if (shape.type === 'note') return { w: DEFAULT_NOTE_SIZE, h: DEFAULT_NOTE_SIZE };
  return { w: DEFAULT_W, h: DEFAULT_H };
}

/**
 * Compute pixel boxes for every shape in a doc. Absolute coords win; otherwise
 * flow layout (or a default grid-ish row when no layout is declared) places them.
 * Frames are sized to wrap their resolved children when they omit explicit size.
 */
export function layoutSketch(doc: SketchDoc): SketchLayoutResult {
  const boxById = new Map<string, LaidOutBox>();
  const boxes: { shape: SketchShape; box: { x: number; y: number; w: number; h: number }; order: number }[] = [];

  // First pass: place the flow/absolute boxes (every non-frame box shape, including
  // frame children — they flow normally; the frame in the second pass WRAPS them).
  const direction = doc.layout?.direction ?? 'row';
  const gap = doc.layout?.gap ?? 48;
  let cursorX = FLOW_ORIGIN_X;
  let cursorY = FLOW_ORIGIN_Y;

  // We assign order from array index so z (when present) can override below.
  doc.shapes.forEach((shape, index) => {
    if (!isBoxShape(shape)) return;
    if (shape.type === 'frame') return; // frames placed in second pass (need children)

    const size = defaultSize(shape);
    const w = 'w' in shape && typeof shape.w === 'number' ? shape.w : size.w;
    const h = 'h' in shape && typeof shape.h === 'number' ? shape.h : size.h;
    const hasAbs = typeof shape.x === 'number' && typeof shape.y === 'number';
    let x: number;
    let y: number;
    if (hasAbs) {
      x = shape.x as number;
      y = shape.y as number;
    } else {
      x = cursorX;
      y = cursorY;
      if (direction === 'row') cursorX += w + gap;
      else cursorY += h + gap;
    }
    const box = { x, y, w, h };
    boxes.push({ shape, box, order: shape.z ?? index });
    if (shape.id) boxById.set(shape.id, box);
  });

  // Second pass: place frames + their children. A frame with explicit coords uses
  // them; otherwise it wraps the bounding box of its already-placed children, or
  // falls into the flow if it has no resolvable children.
  doc.shapes.forEach((shape, index) => {
    if (shape.type !== 'frame') return;
    const childBoxes: LaidOutBox[] = [];
    if (shape.children) {
      for (const id of shape.children) {
        const cb = boxById.get(id);
        if (cb) childBoxes.push(cb);
      }
    }
    let box: { x: number; y: number; w: number; h: number };
    const hasAbs = typeof shape.x === 'number' && typeof shape.y === 'number';
    if (hasAbs) {
      box = {
        x: shape.x as number,
        y: shape.y as number,
        w: typeof shape.w === 'number' ? shape.w : DEFAULT_W * 2,
        h: typeof shape.h === 'number' ? shape.h : DEFAULT_H * 2,
      };
    } else if (childBoxes.length > 0) {
      const minX = Math.min(...childBoxes.map((b) => b.x));
      const minY = Math.min(...childBoxes.map((b) => b.y));
      const maxX = Math.max(...childBoxes.map((b) => b.x + b.w));
      const maxY = Math.max(...childBoxes.map((b) => b.y + b.h));
      box = {
        x: minX - FRAME_PADDING,
        y: minY - FRAME_PADDING,
        w: maxX - minX + FRAME_PADDING * 2,
        h: maxY - minY + FRAME_PADDING * 2,
      };
    } else {
      box = {
        x: cursorX,
        y: cursorY,
        w: typeof shape.w === 'number' ? shape.w : DEFAULT_W * 2,
        h: typeof shape.h === 'number' ? shape.h : DEFAULT_H * 2,
      };
      if (direction === 'row') cursorX += box.w + gap;
      else cursorY += box.h + gap;
    }
    // Frames render BEHIND their children — push their order low.
    boxes.push({ shape, box, order: shape.z ?? index - doc.shapes.length });
    if (shape.id) boxById.set(shape.id, box);
  });

  // Sort boxes by resolved order (ascending = back to front).
  boxes.sort((a, b) => a.order - b.order);

  // Compute overall bounds.
  const bounds = boxes.length > 0
    ? {
        x: Math.min(...boxes.map((b) => b.box.x)),
        y: Math.min(...boxes.map((b) => b.box.y)),
        w: 0,
        h: 0,
      }
    : { x: 0, y: 0, w: 100, h: 100 };
  if (boxes.length > 0) {
    const maxX = Math.max(...boxes.map((b) => b.box.x + b.box.w));
    const maxY = Math.max(...boxes.map((b) => b.box.y + b.box.h));
    (bounds as { w: number; h: number }).w = maxX - bounds.x;
    (bounds as { w: number; h: number }).h = maxY - bounds.y;
  }

  return { boxes, boxById, bounds };
}

/** Center point of a box. */
export function boxCenter(box: LaidOutBox): { cx: number; cy: number } {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

/**
 * Compute a connector's endpoints. When `from`/`to` resolve to boxes, the endpoint
 * is the point on each box's edge along the line between their centers (so the
 * arrow touches the box, not the center). Returns null when a ref is dangling.
 */
export function connectorEndpoints(
  shape: Extract<SketchShape, { type: 'arrow' }>,
  boxById: ReadonlyMap<string, LaidOutBox>,
): { x1: number; y1: number; x2: number; y2: number; danglingRef?: string } | null {
  if (shape.from !== undefined || shape.to !== undefined) {
    const fromBox = shape.from !== undefined ? boxById.get(shape.from) : undefined;
    const toBox = shape.to !== undefined ? boxById.get(shape.to) : undefined;
    if (shape.from !== undefined && !fromBox) return { x1: 0, y1: 0, x2: 0, y2: 0, danglingRef: shape.from };
    if (shape.to !== undefined && !toBox) return { x1: 0, y1: 0, x2: 0, y2: 0, danglingRef: shape.to };
    if (fromBox && toBox) {
      const a = boxCenter(fromBox);
      const b = boxCenter(toBox);
      const start = edgePoint(fromBox, a, b);
      const end = edgePoint(toBox, b, a);
      return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
    }
    return null;
  }
  // Raw-coord fallback.
  if (typeof shape.x1 === 'number' && typeof shape.y1 === 'number' && typeof shape.x2 === 'number' && typeof shape.y2 === 'number') {
    return { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
  }
  return null;
}

/** The point where the line from `center` toward `toward` exits the box edge. */
function edgePoint(box: LaidOutBox, center: { cx: number; cy: number }, toward: { cx: number; cy: number }): { x: number; y: number } {
  const dx = toward.cx - center.cx;
  const dy = toward.cy - center.cy;
  if (dx === 0 && dy === 0) return { x: center.cx, y: center.cy };
  const halfW = box.w / 2;
  const halfH = box.h / 2;
  // Scale so the larger of |dx|/halfW, |dy|/halfH equals 1 (touches the edge).
  const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  return { x: center.cx + dx * scale, y: center.cy + dy * scale };
}

/** Map a sketch color name to a CSS hex for the SVG preview (Greenroom-ish). */
export const COLOR_HEX: Record<SketchColor, string> = {
  black: '#1d1d1f',
  blue: '#4263eb',
  green: '#2f9e44',
  red: '#e03131',
  orange: '#e8590c',
  yellow: '#f08c00',
  violet: '#7048e8',
  'light-blue': '#4dabf7',
  'light-green': '#69db7c',
  'light-red': '#ff8787',
  'light-violet': '#b197fc',
  grey: '#868e96',
  white: '#ffffff',
};
