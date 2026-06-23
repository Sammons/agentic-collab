/**
 * RFC-010 §7 + §9.4 — the agent → sketch DSL: types + the hand-rolled,
 * proto-pollution-safe validator.
 *
 * An agent emits a fenced ```sketch block whose body is a JSON object
 * `{ "shapes": [...], "layout"?: {...} }`. This module is the single source of
 * truth for that contract: it defines the validated `SketchDoc` / `SketchShape`
 * types and `parseSketchDsl(raw) -> SketchDoc | SketchParseFailure`, run on BOTH
 * sides (dashboard before the SVG preview/mount; iframe before `createShapes`).
 *
 * Security posture (RFC §9.4):
 *   - PROTO-POLLUTION-SAFE: any object carrying `__proto__` / `constructor` /
 *     `prototype` as a key (at any depth) is rejected. We NEVER spread a parsed
 *     object; every field is copied one-by-one by name so a hostile descriptor
 *     cannot smuggle unexpected keys into a downstream tldraw record.
 *   - BOUNDED: every numeric is finite + within a concrete max magnitude; the
 *     shape count, raw block size, text length, id length, points count, and
 *     children count are all capped.
 *   - PARTIAL FAILURE: one malformed shape fails THAT shape (it is skipped and a
 *     note is collected), not the whole doc — so a single bad box does not blank
 *     an otherwise-good sketch. The doc as a whole fails only on a structural
 *     problem (non-object, missing/non-array `shapes`, over-cap raw size, a
 *     proto-pollution key, zero valid shapes).
 *
 * This file is `src/shared/` so the tested code and the shipped code are the same
 * code on both sides of the iframe boundary.
 */

// ── Limits (RFC §9.4) ─────────────────────────────────────────────────────────

/** Max magnitude for a coordinate (x/y/x1/y1/x2/y2/points/gap). */
export const MAX_COORD = 100_000;
/** Max for a positive dimension (w/h) — strictly > 0, <= this. */
export const MAX_DIM = 50_000;
/** Max shapes in a single doc. Over → doc fails (renders as plain code). */
export const MAX_SHAPES = 500;
/** Max raw fenced-block size in bytes (the JSON text). */
export const MAX_RAW_BYTES = 64 * 1024;
/** Max length of a shape's `text` field. */
export const MAX_TEXT_LEN = 2_048;
/** Max length of a shape `id`. */
export const MAX_ID_LEN = 64;
/** Max points in a `line`. */
export const MAX_POINTS = 256;
/** Max `children` ids in a `frame`. */
export const MAX_CHILDREN = MAX_SHAPES;
/** Max magnitude of a `z` order integer. */
export const MAX_Z = 100_000;

/** Allowed shape ids: ascii letters, digits, dash, underscore. */
const ID_CHARSET = /^[A-Za-z0-9_-]+$/;

// ── Enums (RFC §7.2) ──────────────────────────────────────────────────────────

/** tldraw's named color palette (RFC §7.2). */
export const SKETCH_COLORS = [
  'black', 'blue', 'green', 'red', 'orange', 'yellow', 'violet',
  'light-blue', 'light-green', 'light-red', 'light-violet', 'grey', 'white',
] as const;
export type SketchColor = (typeof SKETCH_COLORS)[number];

/** tldraw fill styles. */
export const SKETCH_FILLS = ['none', 'semi', 'solid', 'pattern'] as const;
export type SketchFill = (typeof SKETCH_FILLS)[number];

/** tldraw line/arrow dash styles. */
export const SKETCH_DASHES = ['draw', 'solid', 'dashed', 'dotted'] as const;
export type SketchDash = (typeof SKETCH_DASHES)[number];

/** The known shape types. */
export const SKETCH_TYPES = ['rect', 'ellipse', 'text', 'note', 'frame', 'arrow', 'line'] as const;
export type SketchType = (typeof SKETCH_TYPES)[number];

/** Layout modes. */
export const SKETCH_LAYOUT_MODES = ['flow'] as const;
export type SketchLayoutMode = (typeof SKETCH_LAYOUT_MODES)[number];
export const SKETCH_LAYOUT_DIRECTIONS = ['row', 'col'] as const;
export type SketchLayoutDirection = (typeof SKETCH_LAYOUT_DIRECTIONS)[number];

// ── Validated shape types (discriminated on `type`, RFC `kind_is_the_discriminator` analogue) ──

type Common = {
  readonly id?: string;
  readonly color?: SketchColor;
  readonly z?: number;
};

export type SketchRect = Common & {
  readonly type: 'rect';
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly text?: string;
  readonly fill?: SketchFill;
};

export type SketchEllipse = Common & {
  readonly type: 'ellipse';
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly text?: string;
  readonly fill?: SketchFill;
};

export type SketchText = Common & {
  readonly type: 'text';
  readonly text: string;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
};

export type SketchNote = Common & {
  readonly type: 'note';
  readonly text: string;
  readonly x?: number;
  readonly y?: number;
};

export type SketchFrame = Common & {
  readonly type: 'frame';
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly text?: string;
  readonly children?: readonly string[];
};

export type SketchArrow = Common & {
  readonly type: 'arrow';
  readonly from?: string;
  readonly to?: string;
  readonly x1?: number;
  readonly y1?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly text?: string;
  readonly dash?: SketchDash;
};

export type SketchLine = Common & {
  readonly type: 'line';
  readonly points: readonly (readonly [number, number])[];
  readonly dash?: SketchDash;
};

/** A single validated shape descriptor. */
export type SketchShape =
  | SketchRect
  | SketchEllipse
  | SketchText
  | SketchNote
  | SketchFrame
  | SketchArrow
  | SketchLine;

export type SketchLayout = {
  readonly mode: SketchLayoutMode;
  readonly direction: SketchLayoutDirection;
  readonly gap: number;
};

/** The validated sketch document carried by `sketch:load`. */
export type SketchDoc = {
  readonly shapes: readonly SketchShape[];
  readonly layout?: SketchLayout;
  /**
   * Human-readable notes about shapes that were skipped during validation
   * (per-shape partial failure). Empty when every shape validated. These surface
   * in the UI ("2 shapes skipped") without failing the whole doc.
   */
  readonly notes: readonly string[];
};

// ── Failure variants (RFC `failures_are_local_tagged_unions`) ────────────────

export type SketchParseFailure =
  | { readonly kind: 'sketch_not_object'; readonly message: string }
  | { readonly kind: 'sketch_proto_key'; readonly message: string }
  | { readonly kind: 'sketch_too_large'; readonly message: string }
  | { readonly kind: 'sketch_bad_shapes'; readonly message: string }
  | { readonly kind: 'sketch_no_valid_shapes'; readonly message: string };

/** True when a parse result is a failure (not a doc). */
export function isSketchParseFailure(value: SketchDoc | SketchParseFailure): value is SketchParseFailure {
  return !('shapes' in value);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a value recursively and return true if any object key is a dangerous
 * prototype-pollution key. Arrays are traversed; primitives are leaves. Bounded
 * by a depth cap so a pathological nesting cannot blow the stack.
 */
function hasProtoKey(value: unknown, depth = 0): boolean {
  if (depth > 32) return true; // treat pathological nesting as hostile
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasProtoKey(item, depth + 1)) return true;
    }
    return false;
  }
  if (isPlainObject(value)) {
    // Use Object.keys (own enumerable) — a literal `{"__proto__": x}` from
    // JSON.parse is an own property, so this catches it.
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) return true;
      if (hasProtoKey(value[key], depth + 1)) return true;
    }
  }
  return false;
}

/** A finite number within +/- MAX_COORD. */
function isCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORD;
}

/** A finite dimension strictly > 0, <= MAX_DIM. */
function isDim(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DIM;
}

/** A finite z within +/- MAX_Z (any sign; mapped to fractional index later). */
function isZ(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_Z;
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LEN && ID_CHARSET.test(value);
}

function isValidText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LEN;
}

function inEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

// ── Per-shape validation ──────────────────────────────────────────────────────
//
// Each validator copies named fields ONE BY ONE (never spreads `raw`). It returns
// the validated shape OR null (skip + note). The `out` object is freshly built so
// no unexpected key from `raw` can survive into the doc / a tldraw record.

type ShapeValidator = (raw: Record<string, unknown>, note: (reason: string) => void) => SketchShape | null;

/** Copy the optional `id`/`color`/`z` common fields into a target, validating each. */
function copyCommon(raw: Record<string, unknown>): { id?: string; color?: SketchColor; z?: number } {
  const out: { id?: string; color?: SketchColor; z?: number } = {};
  if (raw['id'] !== undefined && isValidId(raw['id'])) out.id = raw['id'];
  if (raw['color'] !== undefined && inEnum(raw['color'], SKETCH_COLORS)) out.color = raw['color'];
  if (raw['z'] !== undefined && isZ(raw['z'])) out.z = raw['z'];
  return out;
}

/** The mutable shape of a box body (rect/ellipse share fields except `type`). */
type MutableBox = {
  type: 'rect' | 'ellipse';
  id?: string;
  color?: SketchColor;
  z?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  fill?: SketchFill;
};

/**
 * `rect` and `ellipse` share the same field set; this builds the common box body
 * with named, validated field-copies (never spreading `raw`). The caller stamps
 * the discriminant `type`.
 */
function validateBox(type: 'rect' | 'ellipse', raw: Record<string, unknown>): SketchRect | SketchEllipse {
  const common = copyCommon(raw);
  // The spread below is over our own freshly-built `common`, never over `raw`.
  const out: MutableBox = { type, ...common };
  if (raw['x'] !== undefined && isCoord(raw['x'])) out.x = raw['x'];
  if (raw['y'] !== undefined && isCoord(raw['y'])) out.y = raw['y'];
  if (raw['w'] !== undefined && isDim(raw['w'])) out.w = raw['w'];
  if (raw['h'] !== undefined && isDim(raw['h'])) out.h = raw['h'];
  if (raw['text'] !== undefined && isValidText(raw['text'])) out.text = raw['text'];
  if (raw['fill'] !== undefined && inEnum(raw['fill'], SKETCH_FILLS)) out.fill = raw['fill'];
  return out as SketchRect | SketchEllipse;
}

const validateRect: ShapeValidator = (raw) => validateBox('rect', raw);
const validateEllipse: ShapeValidator = (raw) => validateBox('ellipse', raw);

const validateText: ShapeValidator = (raw, note) => {
  if (!isValidText(raw['text']) || typeof raw['text'] !== 'string' || raw['text'].length === 0) {
    note('text shape requires a non-empty `text`');
    return null;
  }
  const common = copyCommon(raw);
  const out: SketchText = { type: 'text', text: raw['text'], ...common };
  const mut = out as { -readonly [K in keyof SketchText]?: SketchText[K] };
  if (raw['x'] !== undefined && isCoord(raw['x'])) mut.x = raw['x'];
  if (raw['y'] !== undefined && isCoord(raw['y'])) mut.y = raw['y'];
  if (raw['w'] !== undefined && isDim(raw['w'])) mut.w = raw['w'];
  return out;
};

const validateNote: ShapeValidator = (raw, note) => {
  if (!isValidText(raw['text']) || typeof raw['text'] !== 'string' || raw['text'].length === 0) {
    note('note shape requires a non-empty `text`');
    return null;
  }
  const common = copyCommon(raw);
  const out: SketchNote = { type: 'note', text: raw['text'], ...common };
  const mut = out as { -readonly [K in keyof SketchNote]?: SketchNote[K] };
  if (raw['x'] !== undefined && isCoord(raw['x'])) mut.x = raw['x'];
  if (raw['y'] !== undefined && isCoord(raw['y'])) mut.y = raw['y'];
  return out;
};

const validateFrame: ShapeValidator = (raw, note) => {
  const common = copyCommon(raw);
  const out: SketchFrame = { type: 'frame', ...common };
  const mut = out as { -readonly [K in keyof SketchFrame]?: SketchFrame[K] };
  if (raw['x'] !== undefined && isCoord(raw['x'])) mut.x = raw['x'];
  if (raw['y'] !== undefined && isCoord(raw['y'])) mut.y = raw['y'];
  if (raw['w'] !== undefined && isDim(raw['w'])) mut.w = raw['w'];
  if (raw['h'] !== undefined && isDim(raw['h'])) mut.h = raw['h'];
  if (raw['text'] !== undefined && isValidText(raw['text'])) mut.text = raw['text'];
  if (raw['children'] !== undefined) {
    if (!Array.isArray(raw['children']) || raw['children'].length > MAX_CHILDREN) {
      note('frame `children` must be an array within the children cap');
      return null;
    }
    const children: string[] = [];
    for (const child of raw['children']) {
      if (isValidId(child)) children.push(child);
    }
    mut.children = children;
  }
  return out;
};

const validateArrow: ShapeValidator = (raw, note) => {
  const hasRefs = raw['from'] !== undefined || raw['to'] !== undefined;
  const hasCoords = raw['x1'] !== undefined || raw['y1'] !== undefined || raw['x2'] !== undefined || raw['y2'] !== undefined;
  const common = copyCommon(raw);
  const out: SketchArrow = { type: 'arrow', ...common };
  const mut = out as { -readonly [K in keyof SketchArrow]?: SketchArrow[K] };

  // Connector-by-id is preferred; raw coords are the fallback. At least one mode
  // must be expressible.
  if (hasRefs) {
    if (raw['from'] !== undefined) {
      if (!isValidId(raw['from'])) { note('arrow `from` must be a valid id'); return null; }
      mut.from = raw['from'];
    }
    if (raw['to'] !== undefined) {
      if (!isValidId(raw['to'])) { note('arrow `to` must be a valid id'); return null; }
      mut.to = raw['to'];
    }
  } else if (hasCoords) {
    if (!isCoord(raw['x1']) || !isCoord(raw['y1']) || !isCoord(raw['x2']) || !isCoord(raw['y2'])) {
      note('arrow coords (x1,y1,x2,y2) must all be finite, in-bounds numbers');
      return null;
    }
    mut.x1 = raw['x1']; mut.y1 = raw['y1']; mut.x2 = raw['x2']; mut.y2 = raw['y2'];
  } else {
    note('arrow requires either from/to or x1,y1,x2,y2');
    return null;
  }
  if (raw['text'] !== undefined && isValidText(raw['text'])) mut.text = raw['text'];
  if (raw['dash'] !== undefined && inEnum(raw['dash'], SKETCH_DASHES)) mut.dash = raw['dash'];
  return out;
};

const validateLine: ShapeValidator = (raw, note) => {
  const points = raw['points'];
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS) {
    note('line requires a `points` array of 2..cap [x,y] pairs');
    return null;
  }
  const copied: [number, number][] = [];
  for (const pt of points) {
    if (!Array.isArray(pt) || pt.length !== 2 || !isCoord(pt[0]) || !isCoord(pt[1])) {
      note('line point must be a finite, in-bounds [x,y] pair');
      return null;
    }
    copied.push([pt[0], pt[1]]);
  }
  const common = copyCommon(raw);
  const out: SketchLine = { type: 'line', points: copied, ...common };
  const mut = out as { -readonly [K in keyof SketchLine]?: SketchLine[K] };
  if (raw['dash'] !== undefined && inEnum(raw['dash'], SKETCH_DASHES)) mut.dash = raw['dash'];
  return out;
};

/** Dispatch table: descriptor type → validator (RFC `dispatch_is_a_lookup_not_a_chain`). */
const VALIDATORS: Record<SketchType, ShapeValidator> = {
  rect: validateRect,
  ellipse: validateEllipse,
  text: validateText,
  note: validateNote,
  frame: validateFrame,
  arrow: validateArrow,
  line: validateLine,
};

// ── Doc-level validation ──────────────────────────────────────────────────────

function validateLayout(raw: unknown): SketchLayout | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (!inEnum(raw['mode'], SKETCH_LAYOUT_MODES)) return undefined;
  const direction = inEnum(raw['direction'], SKETCH_LAYOUT_DIRECTIONS) ? raw['direction'] : 'row';
  const gap = isCoord(raw['gap']) && raw['gap'] >= 0 ? raw['gap'] : 48;
  return { mode: raw['mode'], direction, gap };
}

/**
 * Validate an ALREADY-PARSED value (the JSON object) into a `SketchDoc`. Use this
 * when you already have the object; `parseSketchDsl` is the entry point that takes
 * the raw fenced-block string.
 */
export function validateSketchDoc(value: unknown): SketchDoc | SketchParseFailure {
  if (!isPlainObject(value)) {
    return { kind: 'sketch_not_object', message: 'sketch must be a JSON object { "shapes": [...] }' };
  }
  // Proto-pollution guard FIRST, on the whole tree (RFC §9.4).
  if (hasProtoKey(value)) {
    return { kind: 'sketch_proto_key', message: 'sketch contains a forbidden __proto__/constructor/prototype key' };
  }
  const shapesRaw = value['shapes'];
  if (!Array.isArray(shapesRaw)) {
    return { kind: 'sketch_bad_shapes', message: 'sketch.shapes must be an array' };
  }
  if (shapesRaw.length > MAX_SHAPES) {
    return { kind: 'sketch_too_large', message: `sketch has too many shapes (max ${MAX_SHAPES})` };
  }

  const shapes: SketchShape[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (let index = 0; index < shapesRaw.length; index++) {
    const raw = shapesRaw[index];
    if (!isPlainObject(raw)) {
      skipped++;
      continue;
    }
    const type = raw['type'];
    if (!inEnum(type, SKETCH_TYPES)) {
      skipped++;
      continue;
    }
    const validator = VALIDATORS[type];
    const note = (reason: string): void => {
      notes.push(`shape ${index} (${type}): ${reason}`);
    };
    const validated = validator(raw, note);
    if (validated === null) {
      skipped++;
      continue;
    }
    shapes.push(validated);
  }

  if (skipped > 0 && notes.length === 0) {
    notes.push(`${skipped} shape(s) skipped (unknown type or malformed)`);
  } else if (skipped > notes.length) {
    notes.push(`${skipped - notes.length} additional shape(s) skipped (unknown type or malformed)`);
  }

  if (shapes.length === 0) {
    return { kind: 'sketch_no_valid_shapes', message: 'sketch had no valid shapes' };
  }

  const layout = validateLayout(value['layout']);
  const doc: SketchDoc = layout ? { shapes, layout, notes } : { shapes, notes };
  return doc;
}

/**
 * Parse a RAW fenced-block body (the un-escaped text between ```sketch and ```)
 * into a validated `SketchDoc`, or a failure. This is the boundary entry point
 * (RFC §7.4 — it runs on the RAW message text BEFORE HTML-escape so the JSON's
 * quotes survive).
 */
export function parseSketchDsl(raw: unknown): SketchDoc | SketchParseFailure {
  if (typeof raw !== 'string') {
    return { kind: 'sketch_not_object', message: 'sketch body must be a string of JSON' };
  }
  // Cap the raw size before parsing (RFC §9.4). TextEncoder is available in both
  // Node and the browser/iframe, so the same code measures bytes on both sides.
  if (new TextEncoder().encode(raw).length > MAX_RAW_BYTES) {
    return { kind: 'sketch_too_large', message: `sketch block exceeds ${MAX_RAW_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'sketch_not_object', message: 'sketch body is not valid JSON' };
  }
  return validateSketchDoc(parsed);
}
