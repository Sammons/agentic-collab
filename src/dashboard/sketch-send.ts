/**
 * RFC-010 §13 Q3 — the parent-side Send flow: export the (possibly edited) canvas,
 * then DUAL-upload through the EXISTING file pipeline and post-back.
 *
 * Flow (always-on Send, §1.1a — works edited or not):
 *   1. `driver.requestExport(scale?)` posts a `sketch:export-request` and resolves
 *      with the PNG dataURL (reflecting current edits) + the EDITED-source sidecar
 *      (a re-editable tldraw snapshot, §Q3 operator decision). `requestId`
 *      correlation lives in the driver — a stale response for an old request never
 *      resolves the wrong promise.
 *   2. Upload the PNG (PRIMARY) via `POST /api/files` — the same octet-stream upload
 *      `chat.ts` already uses (`uploadFileToStorage`).
 *   3. Upload the EDITED-source sidecar via a second `POST /api/files`. The sidecar
 *      carries the edited tldraw snapshot so the agent receives re-editable source;
 *      when the iframe could not serialize it, fall back to the ORIGINAL DSL.
 *   4. `POST /api/dashboard/send` referencing BOTH `fileId`s.
 *
 * This module is the testable GLUE: every side effect (export, upload, send) is an
 * injected dependency, so a `node --test` mocks the postMessage + fetch boundary and
 * asserts the wiring (two uploads, both ids flow into send) without a DOM or a real
 * iframe. The DOM-driven entry point (`runSketchSend`) wires the real driver + the
 * real `fetch`-backed deps; `executeSketchSend` is the pure orchestration it calls.
 */

import type { SketchCanvasDriver, SketchExportResult } from './sketch-mount.ts';
import type { SketchDoc } from '../shared/sketch-dsl.ts';
import { MAX_SCALE } from '../shared/sketch-raster.ts';

/** A file uploaded to the orchestrator store. */
export type UploadedFile = { readonly ok: boolean; readonly id?: string; readonly error?: string };

/** The dependency boundary the Send flow needs — every side effect is injected. */
export type SketchSendDeps = {
  /** Export the current canvas (PNG + edited sidecar). Resolves or rejects. */
  readonly requestExport: (scale?: number) => Promise<SketchExportResult>;
  /** Upload one file via the existing `POST /api/files` pipeline. */
  readonly uploadFile: (file: File) => Promise<UploadedFile>;
  /** Post the dashboard message referencing the uploaded fileIds. */
  readonly sendMessage: (input: { agent: string; topic: string; message: string; fileIds: string[] }) => Promise<{ ok: boolean; error?: string }>;
  /** Surface a transient message to the operator (toast). */
  readonly notify: (message: string, kind?: 'info' | 'error') => void;
};

/** Where the sketch reply goes: the agent that drew it + a topic. */
export type SketchSendTarget = {
  readonly agent: string;
  readonly topic: string;
  /** The original validated DSL (sidecar fallback when the edited snapshot is absent). */
  readonly doc: SketchDoc;
};

export type SketchSendOutcome =
  | { readonly ok: true; readonly pngFileId: string; readonly sidecarFileId: string }
  | { readonly ok: false; readonly stage: 'export' | 'upload_png' | 'upload_sidecar' | 'send'; readonly error: string };

/** A bound, finite cap on a data-URL the iframe can hand back (defense-in-depth). */
export const MAX_DATA_URL_BYTES = 64 * 1024 * 1024; // 64 MB — well under the 100 MB upload net.

/** Filenames for the two uploaded artifacts. */
export const PNG_FILENAME = 'sketch.png';
export const SIDECAR_FILENAME = 'sketch.tldr.json';

/** The message text attached to the dashboard send. */
const SEND_MESSAGE = 'Sketch (PNG + re-editable source attached)';

/**
 * Decode a `data:` URL's base64 payload into bytes (browser + node). Returns a
 * `Uint8Array` over a concrete `ArrayBuffer` (not a shared/resizable buffer) so it
 * is a valid `BlobPart` for the `File` constructor under the strict DOM lib.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) {
    throw new Error('not a data URL');
  }
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!meta.includes(';base64')) {
    // Non-base64 data URLs are URL-encoded text — decode and UTF-8 encode.
    return utf8Bytes(decodeURIComponent(payload));
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** UTF-8 encode into a `Uint8Array<ArrayBuffer>` (a valid `BlobPart`). */
function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  // Copy into a fresh ArrayBuffer-backed view so the type is exactly ArrayBuffer
  // (TextEncoder's return is typed over ArrayBufferLike, which BlobPart rejects).
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

/** Build the PNG `File` from the export data URL (bounded by `MAX_DATA_URL_BYTES`). */
export function pngFileFromDataUrl(dataUrl: string): File {
  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    throw new Error('exported image exceeds the size cap');
  }
  const bytes = dataUrlToBytes(dataUrl);
  return new File([bytes], PNG_FILENAME, { type: 'image/png' });
}

/**
 * Build the EDITED-source sidecar `File`. Prefers the iframe's edited tldraw
 * snapshot (re-editable source reflecting the operator's edits); falls back to the
 * original DSL JSON when the iframe could not serialize the snapshot.
 */
export function sidecarFileFromExport(result: SketchExportResult, originalDoc: SketchDoc): File {
  const content = result.editedDsl !== undefined && result.editedDsl.length > 0
    ? result.editedDsl
    : JSON.stringify(originalDoc);
  if (content.length > MAX_DATA_URL_BYTES) {
    throw new Error('sidecar exceeds the size cap');
  }
  return new File([utf8Bytes(content)], SIDECAR_FILENAME, { type: 'application/json' });
}

/**
 * Orchestrate export → dual-upload → send. Pure of DOM/fetch (everything is in
 * `deps`), so it is unit-testable end-to-end. Returns a tagged outcome; the caller
 * (`runSketchSend`) maps it to toasts.
 */
export async function executeSketchSend(deps: SketchSendDeps, target: SketchSendTarget): Promise<SketchSendOutcome> {
  // 1. Export the CURRENT canvas (always works, even unedited — §1.1a). Default
  //    scale is the crisp MAX_SCALE so a small diagram exports sharp; the iframe
  //    clamps it down to the raster ceiling.
  let exported: SketchExportResult;
  try {
    exported = await deps.requestExport(MAX_SCALE);
  } catch (error: unknown) {
    return { ok: false, stage: 'export', error: error instanceof Error ? error.message : 'export failed' };
  }

  // 2. Build both files (bounded). A malformed/oversized dataURL fails the export stage.
  let pngFile: File;
  let sidecarFile: File;
  try {
    pngFile = pngFileFromDataUrl(exported.dataUrl);
    sidecarFile = sidecarFileFromExport(exported, target.doc);
  } catch (error: unknown) {
    return { ok: false, stage: 'export', error: error instanceof Error ? error.message : 'could not build files' };
  }

  // 3. Upload the PNG (PRIMARY) first.
  const pngUpload = await deps.uploadFile(pngFile);
  if (!pngUpload.ok || !pngUpload.id) {
    return { ok: false, stage: 'upload_png', error: pngUpload.error ?? 'PNG upload failed' };
  }

  // 4. Upload the EDITED-source sidecar.
  const sidecarUpload = await deps.uploadFile(sidecarFile);
  if (!sidecarUpload.ok || !sidecarUpload.id) {
    return { ok: false, stage: 'upload_sidecar', error: sidecarUpload.error ?? 'sidecar upload failed' };
  }

  // 5. Post-back referencing BOTH fileIds (PNG primary, sidecar second).
  const send = await deps.sendMessage({
    agent: target.agent,
    topic: target.topic,
    message: SEND_MESSAGE,
    fileIds: [pngUpload.id, sidecarUpload.id],
  });
  if (!send.ok) {
    return { ok: false, stage: 'send', error: send.error ?? 'send failed' };
  }

  return { ok: true, pngFileId: pngUpload.id, sidecarFileId: sidecarUpload.id };
}

/**
 * DOM entry point: wire the real driver + real `fetch`-backed deps and run the Send
 * flow, mapping the outcome to operator-facing toasts. Called from `chat.ts`'s
 * `onSend` hook with the active driver and the message's target context.
 */
export function runSketchSend(
  driver: SketchCanvasDriver,
  target: { agent: string; topic: string },
  deps: Pick<SketchSendDeps, 'uploadFile' | 'sendMessage' | 'notify'>,
): Promise<SketchSendOutcome> {
  const fullDeps: SketchSendDeps = {
    requestExport: (scale) => driver.requestExport(scale),
    uploadFile: deps.uploadFile,
    sendMessage: deps.sendMessage,
    notify: deps.notify,
  };
  deps.notify('Exporting sketch…');
  return executeSketchSend(fullDeps, { agent: target.agent, topic: target.topic, doc: driver.doc }).then((outcome) => {
    if (outcome.ok) {
      deps.notify(`Sketch sent to @${target.agent}`);
    } else {
      deps.notify(`Sketch send failed (${outcome.stage}): ${outcome.error}`, 'error');
    }
    return outcome;
  });
}
