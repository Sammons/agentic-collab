/**
 * RFC-010 §13 Q3 — export-response → DUAL-upload → send glue.
 *
 * `executeSketchSend` is the pure orchestration: every side effect (export, upload,
 * send) is an injected dependency, so this `node --test` mocks the postMessage +
 * fetch boundary and asserts the wiring WITHOUT a DOM or a real iframe:
 *   - a PNG `File` is uploaded as the PRIMARY,
 *   - the EDITED-source sidecar `File` is uploaded second,
 *   - BOTH returned fileIds flow into the `/api/dashboard/send` body, in order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSketchSend,
  pngFileFromDataUrl,
  sidecarFileFromExport,
  dataUrlToBytes,
  PNG_FILENAME,
  SIDECAR_FILENAME,
  MAX_DATA_URL_BYTES,
  type SketchSendDeps,
  type SketchSendTarget,
  type UploadedFile,
} from './sketch-send.ts';
import type { SketchExportResult } from './sketch-mount.ts';
import type { SketchDoc } from '../shared/sketch-dsl.ts';

// A 1x1 transparent PNG as a base64 data URL — a real, decodable payload.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ORIGINAL_DOC: SketchDoc = {
  shapes: [{ type: 'rect', text: 'Box', color: 'blue' }],
  notes: [],
};

const TARGET: SketchSendTarget = { agent: 'planner', topic: 'design', doc: ORIGINAL_DOC };

/** Build a deps harness that records every upload + send and returns canned ids. */
function makeDeps(overrides: Partial<SketchSendDeps> = {}): {
  deps: SketchSendDeps;
  uploads: File[];
  sends: { agent: string; topic: string; message: string; fileIds: string[] }[];
  notes: string[];
} {
  const uploads: File[] = [];
  const sends: { agent: string; topic: string; message: string; fileIds: string[] }[] = [];
  const notes: string[] = [];
  let uploadSeq = 0;
  const deps: SketchSendDeps = {
    requestExport: async (): Promise<SketchExportResult> => ({
      dataUrl: TINY_PNG_DATA_URL,
      width: 1,
      height: 1,
      editedDsl: JSON.stringify({ document: { 'shape:1': {} }, session: {} }),
    }),
    uploadFile: async (file: File): Promise<UploadedFile> => {
      uploads.push(file);
      return { ok: true, id: `file-${uploadSeq++}` };
    },
    sendMessage: async (input): Promise<{ ok: boolean }> => {
      sends.push(input);
      return { ok: true };
    },
    notify: (message: string): void => {
      notes.push(message);
    },
    ...overrides,
  };
  return { deps, uploads, sends, notes };
}

test('Send uploads PNG (primary) + edited-source sidecar, both ids flow into send', async () => {
  const { deps, uploads, sends } = makeDeps();
  const outcome = await executeSketchSend(deps, TARGET);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // Two uploads, PNG first then sidecar.
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0]!.name, PNG_FILENAME);
  assert.equal(uploads[0]!.type, 'image/png');
  assert.equal(uploads[1]!.name, SIDECAR_FILENAME);
  assert.equal(uploads[1]!.type, 'application/json');

  // One send, referencing BOTH ids in order (PNG primary, sidecar second).
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.fileIds, ['file-0', 'file-1']);
  assert.equal(sends[0]!.agent, 'planner');
  assert.equal(sends[0]!.topic, 'design');
  assert.deepEqual(outcome, { ok: true, pngFileId: 'file-0', sidecarFileId: 'file-1' });
});

test('sidecar carries the EDITED snapshot when the iframe supplied one', async () => {
  const editedSnapshot = JSON.stringify({ document: { 'shape:edited': { x: 99 } }, session: {} });
  const { deps, uploads } = makeDeps({
    requestExport: async () => ({ dataUrl: TINY_PNG_DATA_URL, width: 1, height: 1, editedDsl: editedSnapshot }),
  });
  await executeSketchSend(deps, TARGET);
  const sidecarText = await uploads[1]!.text();
  assert.equal(sidecarText, editedSnapshot, 'sidecar must be the edited snapshot, not the original DSL');
});

test('sidecar falls back to the ORIGINAL DSL when the iframe could not serialize edits', async () => {
  const { deps, uploads } = makeDeps({
    // No editedDsl in the export result (older frame / serialization failure).
    requestExport: async () => ({ dataUrl: TINY_PNG_DATA_URL, width: 1, height: 1 }),
  });
  await executeSketchSend(deps, TARGET);
  const sidecarText = await uploads[1]!.text();
  assert.equal(sidecarText, JSON.stringify(ORIGINAL_DOC), 'sidecar must fall back to the original DSL');
});

test('export failure short-circuits — no uploads, no send', async () => {
  const { deps, uploads, sends } = makeDeps({
    requestExport: async () => { throw new Error('export timed out'); },
  });
  const outcome = await executeSketchSend(deps, TARGET);
  assert.deepEqual(outcome, { ok: false, stage: 'export', error: 'export timed out' });
  assert.equal(uploads.length, 0);
  assert.equal(sends.length, 0);
});

test('PNG upload failure short-circuits before the sidecar upload and the send', async () => {
  let uploadCount = 0;
  const { deps, sends } = makeDeps({
    uploadFile: async (): Promise<UploadedFile> => {
      uploadCount++;
      return { ok: false, error: 'disk full' };
    },
  });
  const outcome = await executeSketchSend(deps, TARGET);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'upload_png');
  assert.equal(uploadCount, 1, 'only the PNG upload was attempted');
  assert.equal(sends.length, 0);
});

test('sidecar upload failure short-circuits the send (PNG already uploaded)', async () => {
  let uploadCount = 0;
  const { deps, sends } = makeDeps({
    uploadFile: async (): Promise<UploadedFile> => {
      uploadCount++;
      return uploadCount === 1 ? { ok: true, id: 'png-id' } : { ok: false, error: 'sidecar boom' };
    },
  });
  const outcome = await executeSketchSend(deps, TARGET);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'upload_sidecar');
  assert.equal(sends.length, 0);
});

test('send failure surfaces the send stage', async () => {
  const { deps } = makeDeps({
    sendMessage: async () => ({ ok: false, error: 'agent not found' }),
  });
  const outcome = await executeSketchSend(deps, TARGET);
  assert.deepEqual(outcome, { ok: false, stage: 'send', error: 'agent not found' });
});

// ── File-building helpers (pure, bounded) ───────────────────────────────────────

test('pngFileFromDataUrl decodes a real base64 PNG into a non-empty image/png File', async () => {
  const file = pngFileFromDataUrl(TINY_PNG_DATA_URL);
  assert.equal(file.name, PNG_FILENAME);
  assert.equal(file.type, 'image/png');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // PNG magic number: 89 50 4E 47.
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('dataUrlToBytes rejects a non-data-URL', () => {
  assert.throws(() => dataUrlToBytes('https://example.com/x.png'), /not a data URL/);
});

test('pngFileFromDataUrl enforces the size cap (defense-in-depth)', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_DATA_URL_BYTES + 1);
  assert.throws(() => pngFileFromDataUrl(huge), /exceeds the size cap/);
});

test('sidecarFileFromExport with an empty editedDsl falls back to the original DSL', async () => {
  const result: SketchExportResult = { dataUrl: TINY_PNG_DATA_URL, width: 1, height: 1, editedDsl: '' };
  const file = sidecarFileFromExport(result, ORIGINAL_DOC);
  const text = await file.text();
  assert.equal(text, JSON.stringify(ORIGINAL_DOC));
});
