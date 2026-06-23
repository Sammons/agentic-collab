/**
 * RFC-010 §13 Q4 — production-license path (server side).
 *
 * GET /api/sketch/config surfaces the tldraw production license key to the
 * dashboard so it can pass it into `mountSketchCanvas(..., { licenseKey })` →
 * `sketch:init`, dropping the free-tier watermark on the prod HTTPS domain. The
 * key is sourced from the `TLDRAW_LICENSE_KEY` env var into `ctx.tldrawLicenseKey`
 * (wired in main.ts).
 *
 * The load-bearing assertions:
 *   - key SET   → body carries `licenseKey` verbatim.
 *   - key UNSET → body OMITS `licenseKey` (no key crosses the wire; dev path
 *     byte-for-byte the no-key mount the Q3 canvas already takes).
 *   - empty/whitespace-only is treated as unset (defense — main.ts trims, but the
 *     route also guards via the truthiness check).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';
import { TelegramDispatcher } from './telegram.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

function makeServer(
  tmpDir: string,
  patch: Partial<RouteContext>,
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const db = new Database(join(tmpDir, `test-${Math.random()}.db`));
  const wss = new WebSocketServer();
  const proxyDispatch = async (_id: string, _c: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
  const locks = new LockManager(db.rawDb);
  const ctx: RouteContext = {
    db,
    wss,
    locks,
    proxyDispatch,
    getDashboardHtml: () => '<html></html>',
    orchestratorHost: 'http://localhost:3000',
    orchestratorSecret: null,
    messageDispatcher: new MessageDispatcher({ db, locks, proxyDispatch, orchestratorHost: 'http://localhost:3000' }),
    usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as never,
    voiceEnabled: false,
    accountStore: new AccountStore({
      accountsDir: join(tmpDir, `a-${Math.random()}`),
      agentHomesDir: join(tmpDir, `h-${Math.random()}`),
      skipAutoRegister: true,
    }),
    pagesDir: join(tmpDir, 'pages'),
    storesDir: join(tmpDir, 'stores'),
    filesDir: join(tmpDir, 'files'),
    telegramDispatcher: new TelegramDispatcher(),
    ...patch,
  };
  const router = createRouter(ctx);
  const server = createServer(async (req, res) => { await router(req, res); });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('RFC-010 Q4 — GET /api/sketch/config (production-license path)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sketch-config-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('OMITS licenseKey when ctx.tldrawLicenseKey is unset (dev — current state)', async () => {
    const s = await makeServer(tmpDir, {});
    try {
      const res = await fetch(`http://localhost:${s.port}/api/sketch/config`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(body, {}, 'no key on the wire when unset');
      assert.ok(!('licenseKey' in body), 'licenseKey absent, not null/empty');
    } finally {
      await s.close();
    }
  });

  it('OMITS licenseKey when ctx.tldrawLicenseKey is explicitly null', async () => {
    const s = await makeServer(tmpDir, { tldrawLicenseKey: null });
    try {
      const res = await fetch(`http://localhost:${s.port}/api/sketch/config`);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(body, {});
    } finally {
      await s.close();
    }
  });

  it('EMITS the licenseKey verbatim when ctx.tldrawLicenseKey is set', async () => {
    const KEY = 'tldraw-prod-key-abc123';
    const s = await makeServer(tmpDir, { tldrawLicenseKey: KEY });
    try {
      const res = await fetch(`http://localhost:${s.port}/api/sketch/config`);
      assert.equal(res.status, 200);
      const body = await res.json() as { licenseKey?: string };
      assert.equal(body.licenseKey, KEY, 'key surfaced verbatim');
    } finally {
      await s.close();
    }
  });

  it('treats an empty string as unset (omits the key)', async () => {
    const s = await makeServer(tmpDir, { tldrawLicenseKey: '' });
    try {
      const res = await fetch(`http://localhost:${s.port}/api/sketch/config`);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(body, {}, 'empty key is not surfaced');
    } finally {
      await s.close();
    }
  });

  it('does not leak any other ctx field (only licenseKey ever appears)', async () => {
    const KEY = 'only-this-key';
    const s = await makeServer(tmpDir, {
      tldrawLicenseKey: KEY,
      orchestratorSecret: 'SUPER-SECRET-TOKEN',
    });
    try {
      const res = await fetch(`http://localhost:${s.port}/api/sketch/config`);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), ['licenseKey'], 'exactly one field — the ship-safe key');
      assert.ok(!JSON.stringify(body).includes('SUPER-SECRET-TOKEN'), 'no orchestrator secret leaks');
    } finally {
      await s.close();
    }
  });
});
