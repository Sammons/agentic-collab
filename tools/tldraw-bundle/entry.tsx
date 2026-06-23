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

import { clampScale, withinRasterCeiling } from '../../src/shared/sketch-raster.ts';

// Assets (fonts/icons) are imported and inlined as data URIs by esbuild's dataurl
// loader (see build.mjs). getAssetUrlsByImport() returns the data-URI map, so the
// browser fetches NOTHING from tldraw.com / unpkg / jsdelivr (RFC §4.2).
const assetUrls = getAssetUrlsByImport();

// ── Channel state ─────────────────────────────────────────────────────────────

let editor: Editor | null = null;
/** The handshake nonce from `sketch:init`. Null until the parent hands it to us. */
let nonce: SketchNonce | null = null;
/** License key from `sketch:init` (omitted in dev). Drives a one-time re-mount. */
let licenseKey: string | undefined;

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

async function handleExportRequest(request: SketchExportRequest): Promise<void> {
  if (nonce === null) return;
  const requestId = request.requestId;
  if (!editor) {
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: 'editor not ready' });
    return;
  }

  // Clamp the scale, then enforce the concrete raster ceiling on the would-be
  // pixel dimensions BEFORE asking tldraw to render — a malicious/huge canvas
  // must never reach toImage. We do NOT rely on the upload-size backstop (§9.4).
  const scale = clampScale(request.scale);
  const bounds = editor.getCurrentPageBounds();
  const width = bounds ? bounds.width * scale : 0;
  const height = bounds ? bounds.height * scale : 0;
  if (bounds && !withinRasterCeiling(width, height)) {
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: 'too large' });
    return;
  }

  try {
    const options: TLImageExportOptions = {
      format: 'png',
      background: request.background ?? true,
      scale,
    };
    const result = await editor.toImage([], options);
    if (!result) {
      postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: 'export failed' });
      return;
    }
    const dataUrl = await blobToDataUrl(result.blob);
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: true, dataUrl, width: result.width, height: result.height });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'export threw';
    postToParent({ kind: 'sketch:export-response', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, ok: false, error: message });
  }
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
    // Q2 translates data.doc → editor.createShapes(...). Q1 is a no-op mount.
    return;
  }

  if (isSketchExportRequest(data)) {
    if (data.nonce !== nonce) return;
    void handleExportRequest(data);
    return;
  }

  if (isSketchReset(data)) {
    if (data.nonce !== nonce) return;
    // Q3 discards staged edits and re-renders the original doc. Q1 no-op.
    return;
  }

  // Unknown / malformed messages are dropped silently (RFC §9.1).
});

// ── Mount ─────────────────────────────────────────────────────────────────────

function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        licenseKey={licenseKey}
        assetUrls={assetUrls}
        onMount={(mountedEditor: Editor) => {
          editor = mountedEditor;
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

mount();

// Tell the parent the editor is mounted. This is the ONLY pre-handshake message;
// the parent replies with `sketch:init` (carrying the nonce + optional key).
postToParent({ kind: 'sketch:ready', v: SKETCH_PROTOCOL_VERSION });
