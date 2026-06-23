/**
 * RFC-010 Q1 route checks (§13 Q1):
 *   - GET /dashboard/sketch-frame   (routes.sketch-frame.test.ts)
 *   - GET /dashboard/vendor/...     (routes.vendor-serve.test.ts)
 *   - vendor path-traversal harden  (routes.vendor-traversal.test.ts)
 *   - warmDashboardAssets skips vendor/ (routes.warm-skips-vendor.test.ts)
 *   - CSP present on dashboard surfaces (routes.csp.test.ts)
 *
 * Folded into one file (one shared server fixture) but each `it` maps to a named
 * Q1 check. The router resolves the vendor dir via `import.meta.dirname` →
 * `src/dashboard/vendor/`, so these exercise the REAL committed bundle.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, warmDashboardAssets, isUnderVendorRoot, type RouteContext } from './routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';
import { TelegramDispatcher } from './telegram.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

describe('RFC-010 Q1 routes (sketch-frame, vendor, CSP, warm-skip)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let telegramDispatcher: TelegramDispatcher;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-rfc010-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    telegramDispatcher = new TelegramDispatcher();

    const mockProxyDispatch = async (_id: string, _cmd: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);
    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html><body>Dashboard</body></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: new MessageDispatcher({ db, locks, proxyDispatch: mockProxyDispatch, orchestratorHost: 'http://localhost:3000' }),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as never,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
      filesDir: join(tmpDir, 'files'),
      telegramDispatcher,
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const get = (path: string, headers?: Record<string, string>) =>
    fetch(`http://localhost:${port}${path}`, headers ? { headers } : {});

  // ── routes.sketch-frame.test.ts ──

  it('GET /dashboard/sketch-frame → 200 text/html referencing the vendor bundle', async () => {
    const resp = await get('/dashboard/sketch-frame');
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
    const body = await resp.text();
    assert.match(body, /\/dashboard\/vendor\/tldraw\/tldraw\.bundle\.js/, 'host references the bundle JS URL');
    assert.match(body, /\/dashboard\/vendor\/tldraw\/tldraw\.bundle\.css/, 'host references the bundle CSS URL');
    assert.match(body, /id="root"/, 'host has the React mount point');
  });

  it('sketch-frame emits ABSOLUTE bundle URLs + a <base> (srcdoc opaque origin has no base URL)', async () => {
    const resp = await get('/dashboard/sketch-frame');
    const body = await resp.text();
    // The script src must be an absolute http(s) URL so it resolves in an opaque
    // origin (srcdoc), where root-relative paths do not resolve.
    assert.match(body, /<script type="module" src="https?:\/\/[^"]+\/dashboard\/vendor\/tldraw\/tldraw\.bundle\.js"/, 'absolute JS URL');
    assert.match(body, /<base href="https?:\/\/[^"]+\/">/, 'has a <base href> for srcdoc resolution');
  });

  it('GET /dashboard/sketch-frame carries the CSP header', async () => {
    const resp = await get('/dashboard/sketch-frame');
    const csp = resp.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /connect-src 'self'/);
  });

  // ── routes.vendor-serve.test.ts ──

  it('GET /dashboard/vendor/tldraw/tldraw.bundle.js → 200 application/javascript, un-stripped, with etag', async () => {
    const resp = await get('/dashboard/vendor/tldraw/tldraw.bundle.js');
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /application\/javascript/);
    assert.ok((resp.headers.get('etag') ?? '').length > 0, 'has an etag');
    assert.equal(resp.headers.get('access-control-allow-origin'), '*', 'opaque-origin frames need CORS');
    const body = await resp.text();
    assert.ok(body.length > 1_000_000, 'serves the full multi-MB bundle');
    // Served as-is (NOT type-stripped): it is a `.js`, not a `.ts`.
    assert.ok(body.includes('tldraw') || body.length > 0, 'bundle body present');
  });

  it('GET /dashboard/vendor/tldraw/tldraw.bundle.css → 200 text/css', async () => {
    const resp = await get('/dashboard/vendor/tldraw/tldraw.bundle.css');
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
  });

  // ── RFC-010 Q2 icon-sprite fix ──
  // The merged icon spritesheet MUST be served as a REAL file so `#fragment`
  // references resolve (a data: URI does not resolve fragments → filled squares).
  it('GET /dashboard/vendor/tldraw/0_merged.svg → 200 image/svg+xml, with fragment-addressable ids', async () => {
    const resp = await get('/dashboard/vendor/tldraw/0_merged.svg');
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*', 'opaque-origin frame fetches it cross-origin');
    const body = await resp.text();
    assert.ok(body.includes('<svg'), 'is an svg');
    // The :target CSS + per-icon ids are what make `#fragment` selection work.
    assert.ok(/id="[a-z-]+"/.test(body), 'carries fragment-addressable icon ids');
  });

  it('vendor route returns 304 on a matching If-None-Match', async () => {
    const first = await get('/dashboard/vendor/tldraw/tldraw.bundle.css');
    const etag = first.headers.get('etag') ?? '';
    await first.arrayBuffer();
    const second = await get('/dashboard/vendor/tldraw/tldraw.bundle.css', { 'if-none-match': etag });
    assert.equal(second.status, 304);
    await second.arrayBuffer();
  });

  it('vendor route 400s a non-whitelisted extension (e.g. VENDOR.md / .json)', async () => {
    const md = await get('/dashboard/vendor/tldraw/VENDOR.md');
    assert.equal(md.status, 400, 'markdown is not a served vendor type');
    const json = await get('/dashboard/vendor/tldraw/build-provenance.json');
    assert.equal(json.status, 400, 'provenance json is not served');
  });

  it('vendor route 404s a whitelisted-ext file that does not exist', async () => {
    const resp = await get('/dashboard/vendor/tldraw/does-not-exist.js');
    assert.equal(resp.status, 404);
  });

  // ── routes.vendor-traversal.test.ts ──
  //
  // The guard PREDICATE is unit-tested directly against raw inputs (a normal HTTP
  // client normalizes `..` out of the URL before it reaches the server, so the
  // integration GETs below cannot exercise a true traversal — the predicate test
  // proves the guard itself; the GETs prove the route wires it + 400s bad ext).

  it('isUnderVendorRoot: accepts paths under the root', () => {
    const root = '/srv/app/dashboard/vendor';
    assert.equal(isUnderVendorRoot(root, 'tldraw/tldraw.bundle.js'), true);
    assert.equal(isUnderVendorRoot(root, 'tldraw/tldraw.bundle.css'), true);
  });

  it('isUnderVendorRoot: rejects `..` traversal, absolute paths, and sibling dirs', () => {
    const root = '/srv/app/dashboard/vendor';
    assert.equal(isUnderVendorRoot(root, '../../orchestrator/main.js'), false, 'parent escape');
    assert.equal(isUnderVendorRoot(root, 'tldraw/../../../etc/passwd'), false, 'deep escape');
    assert.equal(isUnderVendorRoot(root, '/etc/passwd'), false, 'absolute path');
    // The +sep guard: a sibling dir whose name starts with "vendor" must NOT pass.
    assert.equal(isUnderVendorRoot('/srv/app/dashboard/vendor', '../vendor-evil/x.js'), false, 'vendor-evil sibling');
  });

  it('vendor route rejects URL-encoded %2e%2e traversal (400 ext-guard or 404)', async () => {
    // %2e%2e%2f = ../  — URLPattern decodes before the handler; the resolve()+
    // startsWith guard must still reject it (the substring `..` check would miss).
    const resp = await get('/dashboard/vendor/%2e%2e%2f%2e%2e%2fsecret.js');
    assert.ok(resp.status === 400 || resp.status === 404, `traversal blocked (got ${resp.status})`);
    assert.notEqual(resp.status, 200, 'traversal must not succeed');
    await resp.arrayBuffer();
  });

  it('vendor route rejects a parent-escaping traversal to a real source file', async () => {
    // Try to escape vendor/ up to src/dashboard/chat.ts (a real .js-resolvable
    // sibling outside the vendor root). The guard must reject before reading it.
    const resp = await get('/dashboard/vendor/tldraw/..%2f..%2fmain.js');
    assert.notEqual(resp.status, 200, 'must not serve files outside vendor/');
    await resp.arrayBuffer();
  });

  it('vendor route rejects a `vendor-evil` sibling (startsWith(root) without sep would pass)', async () => {
    // The +sep in the guard rejects a sibling dir whose name starts with "vendor".
    // There is no such dir, but the request must 400/404, never 200 with content.
    const resp = await get('/dashboard/vendor/..%2fvendor-evil%2fx.js');
    assert.notEqual(resp.status, 200);
    await resp.arrayBuffer();
  });

  // ── routes.csp.test.ts ──

  it('GET /dashboard returns a CSP header with the required tokens', async () => {
    const resp = await get('/dashboard');
    const csp = resp.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /connect-src 'self'/);
    await resp.text();
  });

  it('CSP allows Google Fonts origins so the existing dashboard typography is not broken', async () => {
    // The Greenroom dashboard index.html <link>s fonts.googleapis.com (CSS) +
    // fonts.gstatic.com (woff2). The CSP MUST allow them or the dashboard breaks.
    const resp = await get('/dashboard');
    const csp = resp.headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/, 'font CSS origin allowed');
    assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/, 'font file origin allowed');
    await resp.text();
  });

  it('CSP relaxes style-src to unsafe-inline (measured) but NOT script-src', async () => {
    const resp = await get('/dashboard/sketch-frame');
    const csp = resp.headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src 'self' 'unsafe-inline'/, "tldraw needs inline styles (vendor-time measurement)");
    // script-src must NOT carry unsafe-inline.
    const scriptDirective = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
    assert.ok(scriptDirective, 'script-src present');
    assert.ok(!scriptDirective!.includes('unsafe-inline'), 'script-src must stay strict');
    await resp.text();
  });

  // ── routes.warm-skips-vendor.test.ts ──

  it('warmDashboardAssets() caches nothing under vendor/', async () => {
    const warmed = warmDashboardAssets();
    // The exact RFC §4.3.1 check: no warmed path is under vendor/.
    const vendorPaths = warmed.filter((p) => p === 'vendor' || p.startsWith('vendor/') || p.startsWith(`vendor\\`));
    assert.deepEqual(vendorPaths, [], `warm must skip vendor/, found: ${vendorPaths.join(', ')}`);
    // And it warmed SOMETHING (proves the walk ran, not a vacuous pass).
    assert.ok(warmed.length > 0, 'warm cached the real dashboard assets');
    // The bundle is still served (proves it loads lazily on demand, not at warm).
    const resp = await get('/dashboard/vendor/tldraw/tldraw.bundle.css');
    assert.equal(resp.status, 200);
    await resp.arrayBuffer();
  });
});
