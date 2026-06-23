/**
 * RFC-010 §13 Q4 — e2e (mock) of the dashboard sketch flow.
 *
 * Proves the DASHBOARD pipeline end-to-end with only the external boundaries
 * mocked at their seam:
 *   - the tldraw iframe / postMessage boundary is a FAKE iframe window that answers
 *     the protocol (responds to `sketch:init` with `sketch:ready`, and to an
 *     `sketch:export-request` with a stub PNG dataURL + an edited-source sidecar),
 *   - the orchestrator is the REAL mock server (`startMockServer`), driven over the
 *     network: the dual upload hits `POST /api/files` (returns distinct fileIds) and
 *     the post-back hits `POST /api/dashboard/send`.
 *
 * Everything INSIDE the deployment boundary is the REAL dashboard code:
 *   - `renderBodyWithSketches` turns a ```sketch block into a static SVG preview +
 *     "Open canvas" mount node,
 *   - `mountSketchCanvas` runs the real parent-side handshake + message pump + driver
 *     against the fake iframe (it only needs a tiny DOM surface, faked below),
 *   - `executeSketchSend` runs the real export → dual-upload → send orchestration.
 *
 * The real tldraw bundle rendering is NOT exercised here (that is the lead's
 * golden-corpus screenshots). This proves the pipeline glue.
 *
 * Determinism: no fixed-sleep-then-assert. The handshake/export are promise-settled;
 * we await the Send outcome and poll the mock request log until the expected calls
 * land.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startMockServer, type MockServer, type RequestLogEntry } from '../mock-server.ts';
import { renderBodyWithSketches } from '../../dashboard/sketch-chat.ts';
import { mountSketchCanvas } from '../../dashboard/sketch-mount.ts';
import { executeSketchSend, type SketchSendDeps, type UploadedFile } from '../../dashboard/sketch-send.ts';
import {
  SKETCH_PROTOCOL_VERSION,
  isSketchInit,
  isSketchLoad,
  isSketchExportRequest,
  type ParentToFrame,
} from '../../shared/sketch-protocol.ts';
import type { SketchDoc } from '../../shared/sketch-dsl.ts';
import type { SketchCanvasDriver, SketchExportResult } from '../../dashboard/sketch-mount.ts';

// ── A 1×1 transparent PNG data URL — a real, decodable payload the Send flow can
//    turn into a `File`. The fake iframe hands this back on export.
const STUB_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The edited-source sidecar the fake iframe serializes (a re-editable tldraw snapshot
// stand-in). Asserting it survives the upload proves the sidecar path is real.
const STUB_EDITED_DSL = JSON.stringify({ document: { 'shape:1': { type: 'geo' } }, session: {} });

const SKETCH_BLOCK = '```sketch\n{"shapes":[{"id":"a","type":"rect","text":"Box","color":"blue"}]}\n```';

/** A minimal escape+markdown stand-in matching the chat pipeline's contract. */
function escapeAndMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ────────────────────────────────────────────────────────────────────────────
// Minimal fake DOM + fake iframe window.
//
// `mountSketchCanvas` touches a small DOM surface (createElement, querySelector,
// closest, appendChild, replaceWith, remove, addEventListener, contentWindow,
// postMessage, isConnected, srcdoc). We fake exactly that surface so the REAL mount
// logic runs unchanged. The fake iframe's `contentWindow` is a fake window that
// answers the postMessage protocol like the real tldraw frame would.
// ────────────────────────────────────────────────────────────────────────────

type Listener = (event: { data: unknown; source: unknown }) => void;

class FakeWindow {
  private listeners: Listener[] = [];
  /** The fake iframe whose contentWindow this is (set after construction). */
  frameContentWindow: FakeWindow | null = null;
  addEventListener(type: string, fn: Listener): void {
    if (type === 'message') this.listeners.push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    if (type === 'message') this.listeners = this.listeners.filter((l) => l !== fn);
  }
  /** Deliver a message to this window's listeners, tagged with a source window. */
  deliver(data: unknown, source: unknown): void {
    for (const fn of [...this.listeners]) fn({ data, source });
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = '';
  tagName: string;
  textContent = '';
  title = '';
  hidden = false;
  type = '';
  srcdoc = '';
  isConnected = true;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private clickHandlers: (() => void)[] = [];
  /** Only set on the fake <iframe>. */
  contentWindow: FakeWindow | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    child.isConnected = this.isConnected;
    this.children.push(child);
    return child;
  }
  replaceWith(replacement: FakeElement): void {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children[idx] = replacement;
    replacement.parent = this.parent;
    replacement.isConnected = this.parent.isConnected;
    this.parent = null;
    this.isConnected = false;
  }
  remove(): void {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
    this.parent = null;
    this.isConnected = false;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'click') this.clickHandlers.push(fn);
  }
  /** Test-only: fire the element's click handlers. */
  click(): void {
    for (const fn of [...this.clickHandlers]) fn();
  }

  /** Depth-first descendants (excluding self). */
  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }
  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector;
  }
  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((el) => el.matches(selector)) ?? null;
  }
  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }
}

/**
 * The fake iframe runtime: answers the postMessage protocol the way the real tldraw
 * frame would, but with stub payloads (no real bundle). It mirrors the security
 * shape: it posts back with `source` = its own contentWindow so the parent's
 * `event.source === iframe.contentWindow` identity check passes, and it echoes the
 * handshake nonce on every post-handshake message.
 */
function wireFakeIframe(iframe: FakeElement, parentWindow: FakeWindow): { dirtyAfterReady: () => void } {
  const frameWindow = new FakeWindow();
  iframe.contentWindow = frameWindow;
  let nonce = '';

  // The parent posts to the frame via iframe.contentWindow.postMessage(msg, '*').
  // Model that by giving the frame window a postMessage that drives the protocol.
  (frameWindow as unknown as { postMessage: (msg: unknown) => void }).postMessage = (msg: unknown) => {
    const message = msg as ParentToFrame;
    if (isSketchInit(message)) {
      nonce = message.nonce;
      return;
    }
    if (isSketchLoad(message)) {
      // Loaded — nothing to do for the stub; the real frame would render here.
      return;
    }
    if (isSketchExportRequest(message)) {
      // Answer with a stub PNG + edited sidecar, correlated by requestId + nonce.
      parentWindow.deliver(
        {
          kind: 'sketch:export-response',
          v: SKETCH_PROTOCOL_VERSION,
          nonce,
          requestId: message.requestId,
          ok: true,
          dataUrl: STUB_PNG_DATA_URL,
          width: 100,
          height: 80,
          editedDsl: STUB_EDITED_DSL,
        },
        frameWindow,
      );
      return;
    }
    // sketch:reset → no-op for the stub.
  };

  // After the iframe is mounted (srcdoc set), the real frame posts `sketch:ready`.
  // Drive that asynchronously so the parent's `addEventListener` is already wired.
  return {
    dirtyAfterReady: () => {
      parentWindow.deliver(
        { kind: 'sketch:dirty', v: SKETCH_PROTOCOL_VERSION, nonce, dirty: true },
        frameWindow,
      );
    },
  };
}

// ── The test ──────────────────────────────────────────────────────────────────

let mock: MockServer;

before(async () => {
  // Find a free port first (startMockServer builds its url from the literal port,
  // so passing 0 would yield http://localhost:0). Mirrors runner.ts.
  const port = await freePort();
  mock = await startMockServer(port);
});

/** Reserve an OS-assigned free port, then release it for the mock to bind. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const finder = createServer();
    finder.listen(0, () => {
      const addr = finder.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      finder.close(() => resolve(p));
    });
  });
}

after(() => {
  // Force-close idle keep-alive sockets so the process can exit promptly — the
  // repeated request-log polling opens undici keep-alive connections that would
  // otherwise hold the loop until their idle timeout. `close()` alone waits for them.
  mock.server.closeAllConnections?.();
  mock.close();
});

beforeEach(async () => {
  await fetch(`${mock.url}/test/reset`, { method: 'POST' });
});

/** Poll the mock request log until `predicate` holds or the deadline passes. */
async function waitForRequests(
  predicate: (log: RequestLogEntry[]) => boolean,
  timeoutMs = 5000,
): Promise<RequestLogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${mock.url}/test/request-log`);
    const log = (await res.json()) as RequestLogEntry[];
    if (predicate(log)) return log;
    if (Date.now() >= deadline) {
      throw new Error(`request-log predicate not satisfied within ${timeoutMs}ms; saw ${log.length} requests`);
    }
    // Yield to the event loop without a fixed sleep-then-assert (re-checks each tick).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('e2e (mock): sketch block → preview → mount → handshake → dirty → Send → dual upload + send', async () => {
  // ── 1. A message with a ```sketch block renders a static SVG preview + mount node.
  const { html, blocks } = renderBodyWithSketches(SKETCH_BLOCK, escapeAndMarkdown);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0]!.ok, 'the block parsed');
  assert.ok(html.includes('<svg'), 'static SVG preview rendered inline (no iframe yet)');
  assert.ok(html.includes('class="sketch-block"'), 'is a sketch block');
  assert.ok(html.includes('data-sketch-open="0"'), 'has the "Open canvas" control');
  assert.ok(!html.includes('"shapes"'), 'raw DSL JSON is NOT inlined into the markup');

  // ── 2. Build the mount node DOM the way the dashboard markup does, so the REAL
  //    mountSketchCanvas can find `.sketch-head`, `.sketch-preview`, `.sketch-open`.
  const block = blocks[0]!;
  assert.ok(block.ok);
  const doc: SketchDoc = block.doc;

  const parentWindow = new FakeWindow();
  const blockEl = new FakeElement('div');
  blockEl.className = 'sketch-block';
  const head = new FakeElement('div');
  head.className = 'sketch-head';
  const openBtn = new FakeElement('button');
  openBtn.className = 'btn ghost sketch-open';
  head.appendChild(openBtn);
  const preview = new FakeElement('div');
  preview.className = 'sketch-preview';
  blockEl.appendChild(head);
  blockEl.appendChild(preview);

  // ── 3. Patch the globals mountSketchCanvas uses, scoped + restored in finally.
  const realDocument = (globalThis as { document?: unknown }).document;
  const realWindow = (globalThis as { window?: unknown }).window;
  const realFetch = globalThis.fetch;

  // The fake iframe is created on `document.createElement('iframe')`; capture it.
  let createdIframe: FakeElement | null = null;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => {
      const el = new FakeElement(tag);
      if (tag === 'iframe') createdIframe = el;
      return el;
    },
  };
  (globalThis as { window?: unknown }).window = parentWindow;
  // mountSketchCanvas fetches '/dashboard/sketch-frame' for the srcdoc. The fake
  // iframe ignores the srcdoc body entirely (no real bundle is loaded — that is the
  // mocked seam), so answer with a trivial stub document. Any other relative fetch is
  // a bug in the test (the Send deps below talk to the mock via absolute URLs).
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/dashboard/sketch-frame') {
      return new Response('<!doctype html><html><body><!-- stub sketch frame --></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // Record the Send outcome so the assertions are not a tautology.
  let sendDriver: SketchCanvasDriver | null = null;
  let dirtyHook: (() => void) | null = null;

  try {
    // ── 4. Mount the canvas (real code). It generates a nonce, builds the chrome,
    //    swaps the preview for the canvas, wires the message pump, and fetches the
    //    srcdoc. `onSend` captures the driver so we can run the real Send flow.
    //    Cast: the fake DOM implements only the subset of HTMLElement that
    //    mountSketchCanvas touches (createElement/querySelector/closest/append/
    //    replaceWith/remove/event listeners) — the compiler can't prove the
    //    structural match against the full lib.dom HTMLElement, so assert it.
    mountSketchCanvas(blockEl as unknown as HTMLElement, doc, {
      token: 'test-token',
      licenseKey: 'tldraw-prod-key', // production path — proves the key forwards.
      onSend: (driver) => { sendDriver = driver; },
    });

    // Wait until the iframe element exists + srcdoc is set (the async fetch settled),
    // then wire the fake frame and drive the `sketch:ready` handshake.
    await waitFor(() => createdIframe !== null && createdIframe.srcdoc.length > 0);
    const iframe = createdIframe!;
    const fakeFrame = wireFakeIframe(iframe, parentWindow);
    dirtyHook = fakeFrame.dirtyAfterReady;

    // Capture what the parent posts to the frame during the handshake so we can
    // assert the init carries the nonce + the (ship-safe) license key.
    const postedToFrame: unknown[] = [];
    const frameWin = iframe.contentWindow!;
    const realPost = (frameWin as unknown as { postMessage: (m: unknown) => void }).postMessage;
    (frameWin as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => {
      postedToFrame.push(m);
      realPost(m);
    };

    // ── 5. Frame posts `sketch:ready` (the only pre-handshake message). The real
    //    parent responds with `sketch:init` (nonce + license key + theme) then
    //    `sketch:load` (the DSL).
    parentWindow.deliver({ kind: 'sketch:ready', v: SKETCH_PROTOCOL_VERSION }, frameWin);

    const init = postedToFrame.find((m) => isSketchInit(m)) as
      | { nonce: string; licenseKey?: string; theme: string }
      | undefined;
    assert.ok(init, 'parent posted sketch:init after ready');
    assert.equal(init.theme, 'greenroom-light');
    assert.ok(typeof init.nonce === 'string' && init.nonce.length > 0, 'init carries a nonce');
    assert.equal(init.licenseKey, 'tldraw-prod-key', 'the ship-safe license key rides sketch:init');
    assert.ok(postedToFrame.some((m) => isSketchLoad(m)), 'parent posted sketch:load with the DSL');

    // The iframe is now visible; the loading shim was removed.
    assert.equal(iframe.hidden, false, 'iframe shown after ready');

    // ── 6. The operator edits → the frame posts `sketch:dirty` → the "· edited"
    //    marker becomes visible (drives ONLY the marker, not Send's enabled state).
    const marker = head.querySelector('.sketch-edited');
    assert.ok(marker, 'the edited marker exists in the chrome');
    assert.equal(marker.hidden, true, 'marker hidden before any edit');
    dirtyHook();
    assert.equal(marker.hidden, false, 'marker visible after sketch:dirty');

    // ── 7. Click Send → onSend fires with the driver. Run the REAL export →
    //    dual-upload → send orchestration, wiring the uploads/send to the mock
    //    orchestrator over the network.
    const sendBtn = head.querySelector('.sketch-send');
    assert.ok(sendBtn, 'Send button exists');
    sendBtn.click();
    assert.ok(sendDriver, 'onSend fired with the driver on click');

    const target = { agent: 'planner', topic: 'design', doc };
    const deps: SketchSendDeps = {
      requestExport: (scale) => sendDriver!.requestExport(scale),
      uploadFile: async (file): Promise<UploadedFile> => uploadToMock(file),
      sendMessage: (input) => sendToMock(input),
      notify: () => {},
    };
    const outcome = await executeSketchSend(deps, target);

    assert.equal(outcome.ok, true, 'Send succeeded end-to-end');
    if (!outcome.ok) return;
    // Distinct fileIds from the two uploads.
    assert.notEqual(outcome.pngFileId, outcome.sidecarFileId, 'two distinct uploaded ids');

    // ── 8. Assert the dual upload + send actually hit the mock orchestrator.
    const log = await waitForRequests((entries) => {
      const uploads = entries.filter((e) => e.method === 'POST' && e.path === '/api/files');
      const sends = entries.filter((e) => e.method === 'POST' && e.path === '/api/dashboard/send');
      return uploads.length >= 2 && sends.length >= 1;
    });

    const uploads = log.filter((e) => e.method === 'POST' && e.path === '/api/files');
    assert.equal(uploads.length, 2, 'exactly two uploads (PNG primary + sidecar)');

    const send = log.find((e) => e.method === 'POST' && e.path === '/api/dashboard/send');
    assert.ok(send, 'one post-back to /api/dashboard/send');
    const sendBody = send.requestBody as { agent: string; topic: string; fileIds: string[] };
    // Targeted at the source agent, in the message's topic.
    assert.equal(sendBody.agent, 'agent:planner', 'addressed to the source agent');
    assert.equal(sendBody.topic, 'design');
    // BOTH fileIds, PNG primary then sidecar, matching the upload-returned ids.
    assert.equal(sendBody.fileIds.length, 2, 'both fileIds referenced');
    assert.deepEqual(sendBody.fileIds, [outcome.pngFileId, outcome.sidecarFileId], 'PNG primary, sidecar second');
  } finally {
    if (realDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = realDocument;
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
    globalThis.fetch = realFetch;
  }
});

// ── Mock-orchestrator-backed deps (real network calls to the mock server) ──────

async function uploadToMock(file: File): Promise<UploadedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await fetch(`${mock.url}/api/files?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  const body = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  return body.id !== undefined
    ? { ok: !!body.ok, id: body.id }
    : { ok: !!body.ok, ...(body.error !== undefined ? { error: body.error } : {}) };
}

async function sendToMock(input: { agent: string; topic: string; message: string; fileIds: string[] }): Promise<{ ok: boolean }> {
  const targetAddr = input.agent.includes(':') ? input.agent : `agent:${input.agent}`;
  const res = await fetch(`${mock.url}/api/dashboard/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: targetAddr, message: input.message, topic: input.topic, fileIds: input.fileIds }),
  });
  return { ok: res.ok };
}

/** Poll a synchronous predicate until true or timeout, yielding each event-loop tick. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor predicate not satisfied within timeout');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
