/**
 * RFC-010 §13 Q2 — docs wiring (`docs.sketch-dsl.test.ts`).
 *
 * `DOC_PAGES` contains `{ slug: 'sketch-dsl' }`; `src/docs/sketch-dsl.md` exists and
 * is non-empty; `GET /docs/sketch-dsl` returns 200 with the page title in the nav.
 * (Without the DOC_PAGES entry the page renders with a fallback title and is missing
 * from the nav — §7.3.)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DOC_PAGES } from './render.ts';
import { Database } from '../orchestrator/database.ts';
import { createRouter, type RouteContext } from '../orchestrator/routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from '../orchestrator/message-dispatcher.ts';
import { AccountStore } from '../orchestrator/accounts.ts';
import { TelegramDispatcher } from '../orchestrator/telegram.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

describe('RFC-010 Q2 docs wiring (/docs/sketch-dsl)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let telegramDispatcher: TelegramDispatcher;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-rfc010-q2-docs-'));
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

  it('DOC_PAGES contains the sketch-dsl entry with its title', () => {
    const entry = DOC_PAGES.find((p) => p.slug === 'sketch-dsl');
    assert.ok(entry, 'sketch-dsl is in DOC_PAGES');
    assert.equal(entry!.title, 'Sketch DSL');
  });

  it('src/docs/sketch-dsl.md exists and is non-empty', () => {
    const mdPath = join(import.meta.dirname!, 'sketch-dsl.md');
    assert.ok(existsSync(mdPath), 'sketch-dsl.md exists');
    const body = readFileSync(mdPath, 'utf-8');
    assert.ok(body.trim().length > 100, 'sketch-dsl.md is non-trivially long');
    assert.ok(body.includes('```sketch'), 'documents the fence convention');
  });

  it('GET /docs/sketch-dsl → 200 with the title and the active nav link', async () => {
    const resp = await fetch(`http://localhost:${port}/docs/sketch-dsl`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
    const html = await resp.text();
    // The <title> carries the page title (proves the DOC_PAGES lookup, not the
    // fallback slug).
    assert.match(html, /<title>Sketch DSL/);
    // The nav contains an active link to /docs/sketch-dsl (proves nav inclusion).
    assert.match(html, /<a href="\/docs\/sketch-dsl"[^>]*class="active"/);
    assert.ok(html.includes('sketch'), 'page body mentions sketch');
  });
});
