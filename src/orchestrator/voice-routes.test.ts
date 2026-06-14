import { describe, it, before, after, beforeEach } from 'node:test';
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

describe('voice routes', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'voice-routes-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/voice/status', () => {
    it('reports both providers disabled by default', async () => {
      const s = await makeServer(tmpDir, {});
      try {
        const res = await fetch(`http://localhost:${s.port}/api/voice/status`);
        const body = await res.json() as {
          enabled: boolean;
          providers?: { elevenlabs: boolean; whisper: boolean };
          defaultProvider?: string | null;
        };
        assert.equal(res.status, 200);
        assert.equal(body.enabled, false);
        assert.deepEqual(body.providers, { elevenlabs: false, whisper: false });
        assert.equal(body.defaultProvider ?? null, null);
      } finally {
        await s.close();
      }
    });

    it('reports whisper enabled when whisperOpts is set', async () => {
      const s = await makeServer(tmpDir, {
        whisperOpts: { url: 'http://example.test/v1/audio/transcriptions' },
        defaultSttProvider: 'whisper',
      });
      try {
        const res = await fetch(`http://localhost:${s.port}/api/voice/status`);
        const body = await res.json() as {
          enabled: boolean;
          providers: { elevenlabs: boolean; whisper: boolean };
          defaultProvider: string | null;
        };
        assert.equal(body.enabled, true);
        assert.deepEqual(body.providers, { elevenlabs: false, whisper: true });
        assert.equal(body.defaultProvider, 'whisper');
      } finally {
        await s.close();
      }
    });

    it('reports both providers and defaultProvider when both configured', async () => {
      const s = await makeServer(tmpDir, {
        voiceEnabled: true,
        whisperOpts: { url: 'http://example.test/v1/audio/transcriptions' },
        defaultSttProvider: 'elevenlabs',
      });
      try {
        const res = await fetch(`http://localhost:${s.port}/api/voice/status`);
        const body = await res.json() as {
          enabled: boolean;
          providers: { elevenlabs: boolean; whisper: boolean };
          defaultProvider: string | null;
        };
        assert.deepEqual(body.providers, { elevenlabs: true, whisper: true });
        assert.equal(body.defaultProvider, 'elevenlabs');
      } finally {
        await s.close();
      }
    });
  });

  describe('POST /api/voice/transcribe', () => {
    it('returns 503 when whisper is not configured', async () => {
      const s = await makeServer(tmpDir, {});
      try {
        const res = await fetch(`http://localhost:${s.port}/api/voice/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm' },
          body: new Uint8Array([1, 2, 3]),
        });
        assert.equal(res.status, 503);
        const body = await res.json() as { error: string };
        assert.match(body.error, /Whisper not configured/);
      } finally {
        await s.close();
      }
    });

    it('returns 400 when Content-Type is not audio/*', async () => {
      const s = await makeServer(tmpDir, {
        whisperOpts: { url: 'http://example.test/v1/audio/transcriptions' },
      });
      try {
        const res = await fetch(`http://localhost:${s.port}/api/voice/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(res.status, 400);
        const body = await res.json() as { error: string };
        assert.match(body.error, /audio\/\*/);
      } finally {
        await s.close();
      }
    });

    it('returns 400 on empty audio body', async () => {
      const s = await makeServer(tmpDir, {
        whisperOpts: { url: 'http://example.test/v1/audio/transcriptions' },
      });
      try {
        const res = await fetch(`http://localhost:${s.port}/api/voice/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm' },
          body: new Uint8Array(0),
        });
        assert.equal(res.status, 400);
        const body = await res.json() as { error: string };
        assert.match(body.error, /Empty audio/);
      } finally {
        await s.close();
      }
    });
  });
});
