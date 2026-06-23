/**
 * RFC-010 — the IFRAME-SIDE runtime.
 *
 * This file is built (offline, by `build.mjs` via esbuild) into the committed,
 * self-contained bundle at `src/dashboard/vendor/tldraw/tldraw.bundle.js`. It is
 * the ONLY code that imports React / tldraw; that import graph is sealed behind
 * the opaque-origin iframe boundary and never enters the dashboard's module graph
 * (RFC §4.1, §5.1).
 *
 * Q1 scope (this commit): mount `<Tldraw>` with an optional license key, post
 * `sketch:ready`, complete the nonce handshake on `sketch:init`, and stand up the
 * export round-trip PLUMBING (request→response with the raster-ceiling guard) so
 * the wire is testable. The DSL→shape translation is Q2; the real edit/export UX
 * is Q3. Until then `sketch:load` is accepted but renders nothing (a no-op editor),
 * and `sketch:export-request` exports whatever is on the (empty) canvas.
 *
 * Security (RFC §9.1): every inbound message is shape-validated by the protocol
 * type guards, must come from `window.parent`, and (after handshake) must carry
 * the matching nonce. Replies go to `event.source` (the parent window) with
 * `targetOrigin: '*'` — acceptable because the opaque-origin frame has no secrets
 * to leak and the parent re-validates source+nonce on receipt.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, type Editor, type TLImageExportOptions } from 'tldraw';
import { getAssetUrlsByImport } from '@tldraw/assets/imports';
import 'tldraw/tldraw.css';

import {
  SKETCH_PROTOCOL_VERSION,
  isSketchInit,
  isSketchLoad,
  isSketchExportRequest,
  isSketchReset,
  type FrameToParent,
  type SketchExportRequest,
  type SketchNonce,
} from '../../src/shared/sketch-protocol.ts';
import type { SketchDoc } from '../../src/shared/sketch-dsl.ts';

import { decideExport } from '../../src/shared/sketch-raster.ts';
import { translateAndRender } from './translate.tsx';

// Assets (fonts/icons) are imported and inlined as data URIs by esbuild's dataurl
// loader (see build.mjs). getAssetUrlsByImport() returns the data-URI map, so the
// browser fetches NOTHING from tldraw.com / unpkg / jsdelivr (RFC §4.2).
const assetUrls = getAssetUrlsByImport();

// ── Icon-sprite fix (RFC-010 Q2, §VENDOR.md "Known cosmetic limitation") ────────
//
// getAssetUrlsByImport() inlines the merged icon spritesheet as a SINGLE data: URI
// referenced by `#fragment` (e.g. `…0_merged.svg#zoom-in`). Browsers do NOT resolve
// fragment identifiers on data: URIs, so every toolbar icon renders as a filled
// square. The fix: point the icons at the REAL vendored 0_merged.svg file served by
// the vendor route, so the `#fragment` resolves. The file is committed alongside the
// bundle and served by `GET /dashboard/vendor/...`. The frame's <base href> is the
// dashboard origin (the host HTML sets it), so a relative vendor path resolves to
// the real same-site file.
const ICON_SPRITE_URL = new URL('dashboard/vendor/tldraw/0_merged.svg', document.baseURI).href;
if (assetUrls.icons && typeof assetUrls.icons === 'object') {
  for (const iconName of Object.keys(assetUrls.icons)) {
    // Preserve the `#fragment` (the icon name) so the browser selects the right
    // <symbol>/<view> out of the merged sheet, now that the sheet is a real file.
    (assetUrls.icons as Record<string, string>)[iconName] = `${ICON_SPRITE_URL}#${iconName}`;
  }
}

// ── Channel state ─────────────────────────────────────────────────────────────

let editor: Editor | null = null;
/** The handshake nonce from `sketch:init`. Null until the parent hands it to us. */
let nonce: SketchNonce | null = null;
/** License key from `sketch:init` (omitted in dev). Drives a one-time re-mount. */
let licenseKey: string | undefined;
/** The most recently loaded DSL (so `sketch:reset` can re-render the original). */
let loadedDoc: SketchDoc | null = null;
/** True once the operator has edited since the last load (drives `· edited`). */
let dirty = false;

/** Post a message back to the parent window. */
function postToParent(message: FrameToParent): void {
  // The parent re-validates `event.source === iframe.contentWindow` + nonce, so
  // '*' is safe here: an opaque-origin frame cannot target the parent by origin
  // string, and the payload carries no secret.
  window.parent.postMessage(message, '*');
}

function postError(where: string, message: string): void {
  if (nonce === null) return;
  postToParent({ kind: 'sketch:error', v: SKETCH_PROTOCOL_VERSION, nonce, where, message });
}

// ── Export (raster-ceiling guard BEFORE toImage, RFC §9.4) ────────────────────

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Serialize the EDITED canvas as a re-editable tldraw snapshot (RFC-010 Q3). The
 * operator decided the Send sidecar carries the EDITED source (reflecting the
 * operator's edits, re-loadable via `loadSnapshot`), not the original DSL. Returns
 * a JSON string, or `undefined` if serialization fails (the PNG still ships; the
 * parent falls back to the original DSL sidecar).
 */
function serializeEditedSnapshot(activeEditor: Editor): string | undefined {
  try {
    const snapshot = activeEditor.getSnapshot();
    return JSON.stringify(snapshot);
  } catch {
    return undefined;
  }
}

async function handleExportRequest(request: SketchExportRequest): Promise<void> {
  if (nonce === null) return;
  const requestId = request.requestId;
  if (!editor) {
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: 'editor not ready' });
    return;
  }

  // Apply the export GATE BEFORE asking tldraw to render — a malicious/huge canvas
  // must never reach toImage at a dangerous size, and a large-but-legitimate canvas
  // degrades to a smaller image rather than failing (RFC §9.4 + Q3 edge cap). The
  // gate is a pure function (`decideExport`) shared with `node --test`. We do NOT
  // rely on the upload-size backstop.
  const bounds = editor.getCurrentPageBounds();
  const decision = decideExport(bounds ? { width: bounds.width, height: bounds.height } : null, request.scale);
  if (!decision.proceed) {
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: decision.error });
    return;
  }

  try {
    const options: TLImageExportOptions = {
      format: 'png',
      background: request.background ?? true,
      scale: decision.scale,
    };
    const result = await editor.toImage([], options);
    if (!result) {
      postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: 'export failed' });
      return;
    }
    const dataUrl = await blobToDataUrl(result.blob);
    const editedDsl = serializeEditedSnapshot(editor);
    postToParent({
      kind: 'sketch:export-response',
      v: SKETCH_PROTOCOL_VERSION,
      nonce,
      requestId,
      ok: true,
      dataUrl,
      width: result.width,
      height: result.height,
      ...(editedDsl !== undefined ? { editedDsl } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'export threw';
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: message });
  }
}

// ── Render a validated DSL doc into the editor (RFC §7.2) ─────────────────────

/**
 * Clear the canvas and render `doc`. Used by `sketch:load` and `sketch:reset` (the
 * latter discards staged edits by re-rendering the original doc). Posts a
 * `sketch:error` for each dangling connector ref the translator dropped. Resets the
 * dirty flag (a fresh render is, by definition, un-edited).
 */
function renderDoc(doc: SketchDoc): void {
  if (!editor || nonce === null) return;
  loadedDoc = doc;
  // Replace everything currently on the page (a reset/reload starts clean).
  const existing = editor.getCurrentPageShapeIds();
  if (existing.size > 0) editor.deleteShapes([...existing]);
  let result: { dangling: { index: number; danglingRef: string }[] };
  try {
    result = translateAndRender(editor, doc);
  } catch (error: unknown) {
    postError('translate', error instanceof Error ? error.message : 'translate failed');
    return;
  }
  for (const drop of result.dangling) {
    postError('connector', `shape ${drop.index}: dangling ref "${drop.danglingRef}" — connector dropped`);
  }
  // A fresh render is un-edited; tell the parent so the `· edited` marker clears.
  dirty = false;
  postToParent({ kind: 'sketch:dirty', v: SKETCH_PROTOCOL_VERSION, nonce, dirty: false });
}

// ── Message pump ──────────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  // Channel auth: only the embedding parent may drive this frame.
  if (event.source !== window.parent) return;

  const data: unknown = event.data;

  if (isSketchInit(data)) {
    // The init message ESTABLISHES the nonce. Reject a re-init that tries to
    // change the nonce after the handshake (a hijack attempt).
    if (nonce !== null && data.nonce !== nonce) return;
    nonce = data.nonce;
    if (data.licenseKey && data.licenseKey !== licenseKey) {
      licenseKey = data.licenseKey;
      // Re-mount so <Tldraw licenseKey=...> picks up the key. Cheap: happens once.
      mount();
    }
    return;
  }

  // Every post-handshake message must carry the matching nonce.
  if (nonce === null) return;

  if (isSketchLoad(data)) {
    if (data.nonce !== nonce) return;
    // Q2: translate data.doc → editor.createShapes(...) + createBindings(...).
    renderDoc(data.doc as SketchDoc);
    return;
  }

  if (isSketchExportRequest(data)) {
    if (data.nonce !== nonce) return;
    void handleExportRequest(data);
    return;
  }

  if (isSketchReset(data)) {
    if (data.nonce !== nonce) return;
    // Discard staged edits by re-rendering the original loaded doc (§5.3, §8).
    if (loadedDoc) renderDoc(loadedDoc);
    return;
  }

  // Unknown / malformed messages are dropped silently (RFC §9.1).
});

// ── Mount ─────────────────────────────────────────────────────────────────────

/** Debounce handle for the dirty-change notifier. */
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
/** Guards the one-time `sketch:ready` (a license-key re-mount re-fires onMount). */
let readyPosted = false;

function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        licenseKey={licenseKey}
        assetUrls={assetUrls}
        onMount={(mountedEditor: Editor) => {
          editor = mountedEditor;
          // Tell the parent the editor is mounted ONLY once it actually exists.
          // (Posting `sketch:ready` at module top-level — before React's onMount —
          // races: `sketch:load` could arrive while `editor` is still null, and
          // `renderDoc` would bail. The editor is the precondition for "ready".)
          if (!readyPosted) {
            readyPosted = true;
            postToParent({ kind: 'sketch:ready', v: SKETCH_PROTOCOL_VERSION });
          } else if (loadedDoc) {
            // A license-key re-mount: re-render whatever was loaded before.
            renderDoc(loadedDoc);
          }
          // Dirty tracking (RFC §5.3 / §8): a USER store change since the last load
          // marks the sketch edited. `renderDoc` (load/reset) sets dirty=false and
          // notifies; we only flip to true on a user-sourced change. Debounced so a
          // drag doesn't spam the parent.
          mountedEditor.store.listen(
            () => {
              if (nonce === null || dirty) return;
              dirty = true;
              if (dirtyTimer) clearTimeout(dirtyTimer);
              dirtyTimer = setTimeout(() => {
                if (nonce !== null) {
                  postToParent({ kind: 'sketch:dirty', v: SKETCH_PROTOCOL_VERSION, nonce, dirty: true });
                }
              }, 250);
            },
            { source: 'user', scope: 'document' },
          );
        }}
      />
    </div>
  );
}

let root: ReturnType<typeof createRoot> | null = null;

function mount(): void {
  const container = document.getElementById('root');
  if (!container) {
    postError('mount', 'no #root element in iframe host');
    return;
  }
  if (!root) {
    root = createRoot(container);
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// `sketch:ready` is posted from <Tldraw onMount> (once the editor exists), NOT
// here — see the onMount handler. The parent replies with `sketch:init` then
// `sketch:load`; by then `editor` is guaranteed non-null.
mount();
