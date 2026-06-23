/**
 * RFC-010 §13 Q3 — Send is ALWAYS enabled; `dirty` drives ONLY the `· edited`
 * marker; `reset` clears it.
 *
 * The controller (`SketchSendController`) is the DOM-free state machine the canvas
 * chrome delegates to; this `node --test` asserts the Q3 invariants on it directly
 * (no DOM, no iframe). The one DOM fact — that `mountSketchCanvas` creates the Send
 * button WITHOUT a `disabled` attribute and never sets `disabled` from dirty — is
 * asserted by source inspection so a future regression that gates Send is caught.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SketchSendController } from './sketch-send-controller.ts';

test('Send is always enabled — the controller exposes no Send-gating API and a constant true', () => {
  const controller = new SketchSendController<unknown>();
  assert.equal(controller.sendAlwaysEnabled, true);
  // Dirty state must NOT be coupled to any "can send" notion: there is no method on
  // the controller that returns a Send-enabled decision driven by dirty.
  assert.equal(typeof (controller as unknown as { canSend?: unknown }).canSend, 'undefined');
});

test('a fresh controller starts un-dirty (marker hidden before any edit)', () => {
  const controller = new SketchSendController<unknown>();
  assert.equal(controller.dirty, false);
});

test('dirty:true reveals the marker; dirty:false hides it (marker tracks iframe truth)', () => {
  const controller = new SketchSendController<unknown>();
  assert.deepEqual(controller.applyDirty(true), { markerVisible: true });
  assert.equal(controller.dirty, true);
  assert.deepEqual(controller.applyDirty(false), { markerVisible: false });
  assert.equal(controller.dirty, false);
});

test('reset clears dirty and hides the marker', () => {
  const controller = new SketchSendController<unknown>();
  controller.applyDirty(true);
  assert.equal(controller.dirty, true);
  const intent = controller.reset();
  assert.deepEqual(intent, { markerVisible: false });
  assert.equal(controller.dirty, false);
});

test('Send works regardless of dirty — an export can be registered whether dirty or not', () => {
  const controller = new SketchSendController<string>();
  // Un-dirty: still allowed to export (Send always on, §1.1a).
  let resolvedClean = '';
  const idClean = controller.registerExport((v) => { resolvedClean = v; }, () => {});
  controller.settleExport(idClean, { ok: true, value: 'clean-export' });
  assert.equal(resolvedClean, 'clean-export');

  // Dirty: also allowed.
  controller.applyDirty(true);
  let resolvedDirty = '';
  const idDirty = controller.registerExport((v) => { resolvedDirty = v; }, () => {});
  controller.settleExport(idDirty, { ok: true, value: 'dirty-export' });
  assert.equal(resolvedDirty, 'dirty-export');
});

test('mountSketchCanvas creates the Send button without a disabled attribute (source check)', () => {
  const source = readFileSync(join(import.meta.dirname!, 'sketch-mount.ts'), 'utf-8');
  // The Send button must be always-actionable: no `sendBtn.disabled = ...` anywhere,
  // and the chrome must never set disabled from a dirty signal.
  assert.ok(!/sendBtn\.disabled/.test(source), 'Send button must never be disabled (always-on, §1.1a)');
  // dirty only touches the edited marker's visibility, never the Send button.
  assert.ok(source.includes('editedMarker.hidden = !intent.markerVisible'), 'dirty drives only the marker');
});
