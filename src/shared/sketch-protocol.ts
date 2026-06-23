/**
 * RFC-010 §5.3 — the typed postMessage protocol between the dashboard (parent)
 * and the sandboxed, opaque-origin tldraw iframe (child).
 *
 * Both sides import these types. The dashboard imports them as `.ts`; the iframe
 * runtime (built from `tools/tldraw-bundle/entry.tsx`) imports the same file so the
 * wire contract has a single source of truth.
 *
 * Security model (RFC §5.1, §9.1):
 *   - The iframe runs in an OPAQUE origin (sandbox="allow-scripts", NO
 *     allow-same-origin), so `event.origin` is the string `"null"`. Origin
 *     equality alone cannot authenticate the channel.
 *   - The parent therefore validates `event.source === iframe.contentWindow`
 *     (window identity) AND a one-time handshake `nonce` it generated.
 *   - The child validates that messages come from `window.parent` and carry the
 *     matching nonce.
 *   - `sketch:ready` is the ONLY pre-handshake message (it carries no nonce —
 *     it is what tells the parent the editor is mounted so it may send `init`).
 *
 * No secrets ride the wire except the optional license key in `sketch:init`,
 * which is a domain-restricted, client-validated, ship-safe value (RFC §1).
 */

/** Protocol version. Bump only on a breaking wire change. */
export const SKETCH_PROTOCOL_VERSION = 1 as const;

/** Theme tokens the iframe understands. v1 ships one. */
export type SketchTheme = 'greenroom-light';

/** A handshake nonce — `crypto.randomUUID()` from the parent. */
export type SketchNonce = string;

// ── The shape descriptor doc (the validated DSL §7) ───────────────────────────
// The full validator + rich descriptor schema live in `src/shared/sketch-dsl.ts`
// (Q2). The protocol re-exports them so the `sketch:load` payload is typed
// end-to-end against the same source of truth both sides validate against.

export type { SketchDoc, SketchShape } from './sketch-dsl.ts';
import type { SketchDoc } from './sketch-dsl.ts';

// ── Parent → iframe ───────────────────────────────────────────────────────────

/** Sent once after `sketch:ready`. Carries the handshake nonce + display prefs. */
export type SketchInit = {
  readonly kind: 'sketch:init';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
  readonly nonce: SketchNonce;
  /** Omitted in HTTP/localhost dev (tldraw is free + unlicensed there, §1.0). */
  readonly licenseKey?: string;
  readonly readOnly?: boolean;
  readonly theme: SketchTheme;
};

/** The validated DSL to render. */
export type SketchLoad = {
  readonly kind: 'sketch:load';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
  readonly nonce: SketchNonce;
  readonly doc: SketchDoc;
};

/** Ask the iframe to rasterize the current canvas. */
export type SketchExportRequest = {
  readonly kind: 'sketch:export-request';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
  readonly nonce: SketchNonce;
  readonly requestId: string;
  readonly format: 'png';
  readonly scale?: number;
  readonly background?: boolean;
};

/** Discard staged edits; re-render the original `sketch:load` doc. */
export type SketchReset = {
  readonly kind: 'sketch:reset';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
  readonly nonce: SketchNonce;
};

/** Union of all parent→iframe messages. */
export type ParentToFrame = SketchInit | SketchLoad | SketchExportRequest | SketchReset;

// ── iframe → parent ───────────────────────────────────────────────────────────

/** Bundle loaded + editor mounted. The ONLY pre-handshake message (no nonce). */
export type SketchReady = {
  readonly kind: 'sketch:ready';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
};

/** The operator has/hasn't edited since load. Drives ONLY the `· edited` marker. */
export type SketchDirty = {
  readonly kind: 'sketch:dirty';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
  readonly nonce: SketchNonce;
  readonly dirty: boolean;
};

/**
 * A rasterized PNG (as a data URL), correlated by `requestId`.
 *
 * RFC-010 Q3: the success response also carries `editedDsl` — the EDITED canvas
 * serialized as a re-editable tldraw snapshot (`editor.getSnapshot()` → JSON
 * string). The operator decided the Send sidecar must carry the EDITED source (so
 * the agent receives re-editable material reflecting the operator's edits), NOT the
 * original DSL. The snapshot is lossless + reloadable (`loadSnapshot`); the parent
 * uploads it as the `.tldr.json` sidecar alongside the PNG. It is OPTIONAL on the
 * wire so an older frame (or a snapshot-serialization failure) still returns a valid
 * PNG response — the parent falls back to the original DSL sidecar when it is absent.
 */
export type SketchExportResponse =
  | {
      readonly kind: 'sketch:export-response';
      readonly v: typeof SKETCH_PROTOCOL_VERSION;
      readonly nonce: SketchNonce;
      readonly requestId: string;
      readonly ok: true;
      readonly dataUrl: string;
      readonly width: number;
      readonly height: number;
      /** Edited canvas as a re-editable tldraw snapshot (JSON string). Optional. */
      readonly editedDsl?: string;
    }
  | {
      readonly kind: 'sketch:export-response';
      readonly v: typeof SKETCH_PROTOCOL_VERSION;
      readonly nonce: SketchNonce;
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

/** A parse/render/export failure to surface. */
export type SketchError = {
  readonly kind: 'sketch:error';
  readonly v: typeof SKETCH_PROTOCOL_VERSION;
  readonly nonce: SketchNonce;
  readonly where: string;
  readonly message: string;
};

/** Union of all iframe→parent messages. */
export type FrameToParent = SketchReady | SketchDirty | SketchExportResponse | SketchError;

/** Either direction. */
export type SketchMessage = ParentToFrame | FrameToParent;

// ── Type guards ───────────────────────────────────────────────────────────────
//
// Hand-rolled per `handroll_validation_at_boundaries`. Every message arriving over
// postMessage is `unknown` (it crosses a trust boundary — the opaque-origin frame
// or, defensively, anything that got a window handle). These guards narrow it
// before any field is read. The guards do NOT check the nonce — nonce matching is
// the channel-auth step the parent/child apply on top of the shape check (so that
// a shape-valid-but-wrong-nonce message is dropped as a security event, distinct
// from a malformed message).

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProtocolEnvelope(value: unknown): value is { kind: string; v: number } {
  return isObject(value) && typeof value['kind'] === 'string' && value['v'] === SKETCH_PROTOCOL_VERSION;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** True when `value` is a structurally valid `sketch:ready`. */
export function isSketchReady(value: unknown): value is SketchReady {
  return isProtocolEnvelope(value) && value.kind === 'sketch:ready';
}

/** True when `value` is a structurally valid `sketch:init`. */
export function isSketchInit(value: unknown): value is SketchInit {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:init') return false;
  const message = value as Record<string, unknown>;
  if (!isString(message['nonce'])) return false;
  if (message['theme'] !== 'greenroom-light') return false;
  if (message['licenseKey'] !== undefined && !isString(message['licenseKey'])) return false;
  if (message['readOnly'] !== undefined && typeof message['readOnly'] !== 'boolean') return false;
  return true;
}

/** True when `value` is a structurally valid `sketch:load`. */
export function isSketchLoad(value: unknown): value is SketchLoad {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:load') return false;
  const message = value as Record<string, unknown>;
  if (!isString(message['nonce'])) return false;
  const doc = message['doc'];
  return isObject(doc) && Array.isArray((doc as Record<string, unknown>)['shapes']);
}

/** True when `value` is a structurally valid `sketch:export-request`. */
export function isSketchExportRequest(value: unknown): value is SketchExportRequest {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:export-request') return false;
  const message = value as Record<string, unknown>;
  if (!isString(message['nonce'])) return false;
  if (!isString(message['requestId'])) return false;
  if (message['format'] !== 'png') return false;
  if (message['scale'] !== undefined && typeof message['scale'] !== 'number') return false;
  return true;
}

/** True when `value` is a structurally valid `sketch:reset`. */
export function isSketchReset(value: unknown): value is SketchReset {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:reset') return false;
  return isString((value as Record<string, unknown>)['nonce']);
}

/** True when `value` is a structurally valid `sketch:dirty`. */
export function isSketchDirty(value: unknown): value is SketchDirty {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:dirty') return false;
  const message = value as Record<string, unknown>;
  return isString(message['nonce']) && typeof message['dirty'] === 'boolean';
}

/** True when `value` is a structurally valid `sketch:export-response`. */
export function isSketchExportResponse(value: unknown): value is SketchExportResponse {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:export-response') return false;
  const message = value as Record<string, unknown>;
  if (!isString(message['nonce'])) return false;
  if (!isString(message['requestId'])) return false;
  if (message['ok'] === true) {
    if (!isString(message['dataUrl']) || typeof message['width'] !== 'number' || typeof message['height'] !== 'number') return false;
    // editedDsl is optional; when present it must be a string (the serialized snapshot).
    if (message['editedDsl'] !== undefined && !isString(message['editedDsl'])) return false;
    return true;
  }
  if (message['ok'] === false) {
    return isString(message['error']);
  }
  return false;
}

/** True when `value` is a structurally valid `sketch:error`. */
export function isSketchError(value: unknown): value is SketchError {
  if (!isProtocolEnvelope(value) || value.kind !== 'sketch:error') return false;
  const message = value as Record<string, unknown>;
  return isString(message['nonce']) && isString(message['where']) && isString(message['message']);
}

/** Any structurally valid protocol message in either direction. */
export function isSketchMessage(value: unknown): value is SketchMessage {
  return (
    isSketchReady(value) ||
    isSketchInit(value) ||
    isSketchLoad(value) ||
    isSketchExportRequest(value) ||
    isSketchReset(value) ||
    isSketchDirty(value) ||
    isSketchExportResponse(value) ||
    isSketchError(value)
  );
}

/**
 * Authenticate a frame→parent (or parent→frame) message that has already been
 * shape-validated. Returns true only when the message carries the expected
 * handshake nonce. `sketch:ready` is exempt (the pre-handshake message that
 * establishes the channel) — callers check `isSketchReady` separately before the
 * nonce exists. Any other message with a missing/mismatched nonce is dropped.
 */
export function nonceMatches(value: SketchMessage, expected: SketchNonce): boolean {
  if (value.kind === 'sketch:ready') return true;
  return value.nonce === expected;
}
