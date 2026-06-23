/**
 * RFC-010 §13 Q4 — production-license path (dashboard side).
 *
 * `loadSketchConfig` fetches `GET /api/sketch/config` once at boot and stashes a
 * non-empty `licenseKey` on `state.sketchLicenseKey` so the sketch canvas mount can
 * forward it into `sketch:init`. It must be best-effort: a missing key (dev), a
 * non-200, an unreachable server, or a malformed body leaves the key null (free-tier
 * mount, unchanged behavior). DOM-free: it only touches `fetch` (a Node global) +
 * `state`.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadSketchConfig, state } from './state.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  state.sketchLicenseKey = null;
});

/** Stub `fetch` with a canned `/api/sketch/config` response. */
function stubFetch(impl: (url: string) => { status: number; body: unknown } | Promise<never>): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const out = await impl(url);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body,
    } as Response;
  }) as typeof fetch;
}

test('stashes a non-empty licenseKey from the config response', async () => {
  let requested = '';
  stubFetch((url) => {
    requested = url;
    return { status: 200, body: { licenseKey: 'tldraw-prod-xyz' } };
  });
  await loadSketchConfig();
  assert.equal(requested, '/api/sketch/config', 'hits the config endpoint');
  assert.equal(state.sketchLicenseKey, 'tldraw-prod-xyz');
});

test('leaves the key null when the body omits licenseKey (dev path)', async () => {
  stubFetch(() => ({ status: 200, body: {} }));
  await loadSketchConfig();
  assert.equal(state.sketchLicenseKey, null);
});

test('ignores an empty-string licenseKey (treated as unset)', async () => {
  stubFetch(() => ({ status: 200, body: { licenseKey: '' } }));
  await loadSketchConfig();
  assert.equal(state.sketchLicenseKey, null);
});

test('ignores a non-string licenseKey shape', async () => {
  stubFetch(() => ({ status: 200, body: { licenseKey: 12345 } }));
  await loadSketchConfig();
  assert.equal(state.sketchLicenseKey, null);
});

test('leaves the key null on a non-200 response', async () => {
  stubFetch(() => ({ status: 404, body: { error: 'not found' } }));
  await loadSketchConfig();
  assert.equal(state.sketchLicenseKey, null);
});

test('leaves the key null when fetch rejects (server unreachable)', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  await loadSketchConfig();
  assert.equal(state.sketchLicenseKey, null);
});
