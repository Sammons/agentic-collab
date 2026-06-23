/**
 * RFC-010 §5 / §7.5 — the PARENT-side iframe mount + postMessage driver.
 *
 * Lazily mounts the sandboxed, OPAQUE-ORIGIN tldraw iframe inside a sketch block
 * and drives it over the typed `sketch-protocol` wire:
 *   - generate a one-time handshake nonce (`crypto.randomUUID()`),
 *   - mount `<iframe sandbox="allow-scripts" srcdoc=...>` (NO allow-same-origin →
 *     opaque origin → real isolation, §5.1),
 *   - on `sketch:ready` (the only pre-handshake message), post `sketch:init`
 *     (nonce + optional licenseKey + theme) then `sketch:load` (the validated DSL),
 *   - validate every frame→parent message: `event.source === iframe.contentWindow`
 *     AND the matching nonce (§9.1),
 *   - render the Greenroom chrome (eyebrow, `· edited` marker, Send, Reset).
 *
 * Q2 SCOPE: mount + load the DSL + Reset + the `· edited` marker. The Send →
 * export → upload flow is Q3 (§13). Send is rendered (always enabled, §1.1a) and
 * delegates to an optional `onSend` hook Q3 installs; until then it posts an
 * export-request and surfaces the result via the same hook contract.
 *
 * SECURITY: no secrets ride the wire except the optional, ship-safe license key.
 * The srcdoc host loads the bundle as a cross-origin (CORS) subresource the vendor
 * route permits (§5.1).
 */

import {
  SKETCH_PROTOCOL_VERSION,
  isSketchMessage,
  isSketchReady,
  nonceMatches,
  type SketchDoc,
  type FrameToParent,
  type ParentToFrame,
} from '../shared/sketch-protocol.ts';
import { SketchSendController } from './sketch-send-controller.ts';

export type SketchMountOptions = {
  /** Dashboard auth token (passed to Q3's upload, not to the iframe). */
  readonly token?: string;
  /** tldraw license key for production (omitted in HTTP/localhost dev, §1.0). */
  readonly licenseKey?: string;
  /**
   * Q3 hook: called when the operator clicks Send with the active iframe driver so
   * Q3 can request an export + upload. Absent in Q2 (Send shows a "coming soon"
   * toast). The driver exposes `requestExport` + the original doc for the sidecar.
   */
  readonly onSend?: (driver: SketchCanvasDriver) => void;
};

/** The result of a canvas export: the PNG data URL + the EDITED-source sidecar. */
export type SketchExportResult = {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /**
   * The EDITED canvas as a re-editable tldraw snapshot (JSON string), when the
   * iframe could serialize it. Absent on an older frame / serialization failure;
   * the Send flow falls back to the original DSL sidecar in that case (RFC-010 Q3).
   */
  readonly editedDsl?: string;
};

/** What Q3 needs to drive Send: request a PNG export + read the original DSL. */
export type SketchCanvasDriver = {
  readonly doc: SketchDoc;
  /** Post a `sketch:export-request`; resolves with the PNG + edited sidecar or rejects. */
  requestExport(scale?: number): Promise<SketchExportResult>;
};

/** Fetch the opaque-origin host HTML (absolute bundle URLs + <base>) for srcdoc. */
async function fetchFrameHtml(): Promise<string> {
  const res = await fetch('/dashboard/sketch-frame', { headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error(`sketch-frame ${res.status}`);
  return res.text();
}

/**
 * Mount the live tldraw canvas into a sketch block, replacing the static preview.
 * Returns once the iframe element is in the DOM (the editor mounts asynchronously;
 * the DSL loads on `sketch:ready`).
 */
export function mountSketchCanvas(blockEl: HTMLElement, doc: SketchDoc, options: SketchMountOptions = {}): void {
  const nonce = crypto.randomUUID();
  // Pure controller owns dirty-state + requestId correlation (DOM-free, unit-tested).
  const controller = new SketchSendController<SketchExportResult>();

  // ── Build the chrome ──────────────────────────────────────────────────────
  const head = blockEl.querySelector<HTMLElement>('.sketch-head');
  const editedMarker = document.createElement('span');
  editedMarker.className = 'sketch-edited';
  editedMarker.textContent = '· edited';
  editedMarker.hidden = true;

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'btn primary sketch-send';
  sendBtn.textContent = 'Send sketch';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn ghost sketch-reset';
  resetBtn.textContent = 'Reset';

  // The "Open canvas" button is replaced by Send + Reset once mounted.
  const openBtn = head?.querySelector<HTMLButtonElement>('.sketch-open');
  if (openBtn) openBtn.remove();
  if (head) {
    head.appendChild(editedMarker);
    head.appendChild(resetBtn);
    head.appendChild(sendBtn);
  }

  // ── Swap the static SVG preview for the live canvas ──────────────────────────
  const previewEl = blockEl.querySelector<HTMLElement>('.sketch-preview');
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'sketch-canvas';
  const loading = document.createElement('div');
  loading.className = 'sketch-loading';
  loading.textContent = 'loading canvas…';
  canvasWrap.appendChild(loading);
  if (previewEl) previewEl.replaceWith(canvasWrap); else blockEl.appendChild(canvasWrap);

  const iframe = document.createElement('iframe');
  iframe.className = 'sketch-iframe';
  iframe.title = 'sketch canvas';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.hidden = true;

  // ── The driver Q3 uses for Send ──────────────────────────────────────────────
  const post = (message: ParentToFrame): void => {
    const win = iframe.contentWindow;
    if (!win) return;
    // Opaque-origin frame: target with '*' (no origin to name); the frame
    // re-validates window.parent + nonce. Payload carries no secret beyond the
    // ship-safe license key.
    win.postMessage(message, '*');
  };

  const driver: SketchCanvasDriver = {
    doc,
    requestExport(scale?: number) {
      return new Promise((resolve, reject) => {
        const requestId = controller.registerExport(resolve, reject);
        post({ kind: 'sketch:export-request', v: SKETCH_PROTOCOL_VERSION, nonce, requestId, format: 'png', background: true, ...(scale !== undefined ? { scale } : {}) });
        // Safety timeout so a never-answering frame doesn't leak a pending promise.
        setTimeout(() => {
          controller.timeoutExport(requestId, new Error('export timed out'));
        }, 20_000);
      });
    },
  };

  // ── The message pump (parent side) ───────────────────────────────────────────
  const onMessage = (event: MessageEvent): void => {
    // Self-remove when the iframe has been detached from the DOM (a feed re-render
    // via replaceChildren destroys the iframe). This is what stops listeners from
    // STACKING across re-renders / re-opens: a stale listener removes itself the
    // first time a message arrives after its iframe is gone.
    if (!iframe.isConnected) {
      window.removeEventListener('message', onMessage);
      return;
    }
    if (event.source !== iframe.contentWindow) return; // window-identity check (§9.1)
    const data: unknown = event.data;
    if (!isSketchMessage(data)) return;

    if (isSketchReady(data)) {
      loading.remove();
      iframe.hidden = false;
      // Handshake: init (nonce + optional key + theme), then load the DSL.
      post({ kind: 'sketch:init', v: SKETCH_PROTOCOL_VERSION, nonce, theme: 'greenroom-light', ...(options.licenseKey ? { licenseKey: options.licenseKey } : {}) });
      post({ kind: 'sketch:load', v: SKETCH_PROTOCOL_VERSION, nonce, doc });
      return;
    }

    // Every post-handshake message must carry the matching nonce.
    if (!nonceMatches(data, nonce)) return;
    const message = data as FrameToParent;

    if (message.kind === 'sketch:dirty') {
      // dirty drives ONLY the `· edited` marker (NOT Send's enabled state, §1.1a).
      const intent = controller.applyDirty(message.dirty);
      editedMarker.hidden = !intent.markerVisible;
      return;
    }
    if (message.kind === 'sketch:export-response') {
      // requestId correlation lives in the controller: a stale / unknown id is
      // ignored and never resolves the wrong promise (§13 Q3).
      const outcome = message.ok
        ? {
            ok: true as const,
            value: {
              dataUrl: message.dataUrl,
              width: message.width,
              height: message.height,
              ...(message.editedDsl !== undefined ? { editedDsl: message.editedDsl } : {}),
            },
          }
        : { ok: false as const, error: new Error(message.error) };
      controller.settleExport(message.requestId, outcome);
      return;
    }
    // sketch:error → surface to console (a toast is Q3's polish).
    if (message.kind === 'sketch:error') {
      console.warn(`[sketch] iframe ${message.where}: ${message.message}`);
    }
  };
  window.addEventListener('message', onMessage);

  // Reset re-renders the original doc (discards staged edits).
  resetBtn.addEventListener('click', () => {
    post({ kind: 'sketch:reset', v: SKETCH_PROTOCOL_VERSION, nonce });
    const intent = controller.reset();
    editedMarker.hidden = !intent.markerVisible;
  });

  // Send: Q3 installs the export→upload→post-back flow via options.onSend.
  sendBtn.addEventListener('click', () => {
    if (options.onSend) options.onSend(driver);
    else import('./util.ts').then((m) => m.toast('Send lands in RFC-010 Q3'));
  });

  // ── Mount the iframe via srcdoc (opaque origin) ──────────────────────────────
  fetchFrameHtml()
    .then((srcdoc) => {
      iframe.srcdoc = srcdoc;
      canvasWrap.appendChild(iframe);
    })
    .catch((error: unknown) => {
      loading.textContent = `canvas unavailable: ${error instanceof Error ? error.message : 'load failed'}`;
      window.removeEventListener('message', onMessage);
    });
}
