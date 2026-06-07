/**
 * RFC-008 PR-D: per-agent Telegram OUTBOUND channel tests.
 *
 * Exercises `POST /api/agents/send` with a `telegram:<name>` address — the
 * agent-first disambiguation (per-agent bot vs legacy destination fallback),
 * the reply-target resolution (last-inbound chat → persona default chatId), the
 * dashboard-message side effect, and the token-never-leaks invariant.
 *
 * Real Database (tmp file), real WebSocketServer + MessageDispatcher + router +
 * node:http server, real TelegramDispatcher. The dispatcher talks to Telegram
 * only through the global `fetch`, which is faked here (mirroring
 * telegram-reconcile.test.ts) so `dispatcher.send` is observable and nothing
 * hits the network.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';
import { TelegramDispatcher } from './telegram.ts';
import { encryptSecret } from './secret-crypto.ts';
import {
  createRouter,
  onMessageFor,
  _resetTelegramReconcileState,
  type RouteContext,
} from './routes.ts';
import type { AgentTelegramConfig, ProxyCommand, ProxyResponse } from '../shared/types.ts';

type SendCall = { url: string; chatId: string; text: string };

describe('per-agent Telegram outbound (RFC-008 PR-D)', () => {
  const realFetch = globalThis.fetch;
  let tmpDir: string;
  let db: Database;
  let wss: WebSocketServer;
  let dispatcher: TelegramDispatcher;
  let ctx: RouteContext;
  let server: Server;
  let port: number;
  let sendCalls: SendCall[];
  /** When set, the faked fetch makes sendMessage return this HTTP status (for the 502 path). */
  let sendStatus: number;

  function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }

  /** Fake fetch: sendMessage records the call + chatId/text + returns `sendStatus`; getUpdates idles until aborted. */
  function installFetch(): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/sendMessage')) {
        const parsed = init?.body ? JSON.parse(init.body as string) as { chat_id: string; text: string } : { chat_id: '', text: '' };
        sendCalls.push({ url, chatId: parsed.chat_id, text: parsed.text });
        if (sendStatus >= 200 && sendStatus < 300) return jsonResponse({ ok: true }, sendStatus);
        return jsonResponse({ ok: false, description: 'forced failure' }, sendStatus);
      }
      // getUpdates: block until aborted so poll loops don't busy-spin.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
  }

  const ORIG_SECRET = process.env['ORCHESTRATOR_SECRET'];

  before(async () => {
    process.env['ORCHESTRATOR_SECRET'] = 'telegram-outbound-test-secret';
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-outbound-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    const locks = new LockManager(db.rawDb);
    const proxyDispatch = async (_id: string, _cmd: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    dispatcher = new TelegramDispatcher();
    ctx = {
      db,
      wss,
      locks,
      proxyDispatch,
      getDashboardHtml: () => '',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null, // no auth for these tests
      messageDispatcher: new MessageDispatcher({ db, locks, proxyDispatch, orchestratorHost: 'http://localhost:3000' }),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as never,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'homes'), skipAutoRegister: true }),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
      filesDir: join(tmpDir, 'files'),
      telegramDispatcher: dispatcher,
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    dispatcher.stopAll();
    ctx.messageDispatcher.stop();
    globalThis.fetch = realFetch;
    if (ORIG_SECRET === undefined) delete process.env['ORCHESTRATOR_SECRET'];
    else process.env['ORCHESTRATOR_SECRET'] = ORIG_SECRET;
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    dispatcher.stopAll();
    ctx.messageDispatcher.stop();
    _resetTelegramReconcileState();
    db.rawDb.exec('DELETE FROM agents; DELETE FROM destinations; DELETE FROM agent_telegram_tokens; DELETE FROM dashboard_messages; DELETE FROM pending_messages;');
    sendCalls = [];
    sendStatus = 200;
    installFetch();
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown; raw: string }> {
    // Use the REAL fetch for the test's own HTTP requests: the faked global
    // `fetch` only stands in for the dispatcher's outbound Telegram calls INSIDE
    // the server process. Hitting the local server must bypass the fake.
    const resp = await realFetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await resp.text();
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: resp.status, data, raw };
  }

  function makeAgent(name: string, telegram: AgentTelegramConfig | null, state: 'void' | 'active' = 'active'): void {
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', agentTelegram: telegram });
    if (state !== 'void') {
      const a = db.getAgent(name)!;
      db.updateAgentState(name, state, a.version);
    }
  }

  function setToken(name: string, token: string): void {
    const ct = encryptSecret(token, name);
    assert.ok(ct, 'encryptSecret should produce ciphertext');
    db.setTelegramToken(name, ct!);
  }

  /** Prime the last-inbound-chat map by replaying an inbound message through onMessageFor. */
  function primeInboundChat(agentName: string, token: string, chatId: string): void {
    onMessageFor(ctx, agentName, token)(chatId, 'inbound priming');
  }

  /** All dashboard messages for a thread, oldest-first. */
  function messagesFor(thread: string) {
    return db.getDashboardThreads(thread, 0)[thread] ?? [];
  }

  it('telegram:<agent> → sends via the agent token to the LAST-INBOUND chat; 200', async () => {
    makeAgent('almanac', { chatId: '-100default', routing: 'self' });
    setToken('almanac', 'TOK-ALMANAC');
    // An inbound message arrived from chat 555 → that becomes the reply target.
    primeInboundChat('almanac', 'TOK-ALMANAC', '555');
    sendCalls = []; // drop any send from priming (there is none for an active agent, but be safe)

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'almanac', to: 'telegram:almanac', message: 'here is your reply', topic: 'telegram',
    });

    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
    assert.equal(sendCalls.length, 1, 'dispatcher.send should be called exactly once');
    assert.ok(sendCalls[0]!.url.includes('/botTOK-ALMANAC/sendMessage'), 'must use the agent token');
    assert.equal(sendCalls[0]!.chatId, '555', 'must target the last-inbound chat');
    assert.equal(sendCalls[0]!.text, 'here is your reply');

    // Dashboard message recorded in the telegram:<agent> thread, sourceAgent = sender.
    const msgs = messagesFor('telegram:almanac');
    const last = msgs[msgs.length - 1]!;
    assert.equal(last.message, 'here is your reply');
    assert.equal(last.sourceAgent, 'almanac');
    assert.equal(last.topic, 'telegram');
  });

  it('falls back to agentTelegram.chatId when there is no last-inbound chat', async () => {
    makeAgent('orphan', { chatId: '-100default', routing: 'self' });
    setToken('orphan', 'TOK-ORPHAN');
    // No primeInboundChat → no last-inbound chat known.

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'someone', to: 'telegram:orphan', message: 'cold reply', topic: 'telegram',
    });

    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]!.chatId, '-100default', 'must fall back to the persona default chatId');
    assert.equal(sendCalls[0]!.text, 'cold reply');
  });

  it('an empty-chatId telegram config is normalized to no-config → not a per-agent send', async () => {
    // The field registry's normalizeTelegram nulls a config with an empty chatId
    // (chatId is the required non-secret default). So such an agent has no
    // effective telegram binding: getAgent(...).agentTelegram is null, and the
    // outbound path falls through to the destination fallback (404 here, no dest).
    makeAgent('nochat', { chatId: '', routing: 'self' });
    setToken('nochat', 'TOK-NOCHAT');
    assert.equal(db.getAgent('nochat')!.agentTelegram, null, 'empty-chatId config must normalize to null');

    const { status } = await api('POST', '/api/agents/send', {
      from: 'x', to: 'telegram:nochat', message: 'hi', topic: 'telegram',
    });

    assert.equal(status, 404, 'falls through to destination fallback; none exists → 404');
    assert.equal(sendCalls.length, 0, 'no send should be attempted');
  });

  it('a per-agent bot with a default chatId but no inbound chat always has a reply target (200)', async () => {
    // The empty-chatId guard in handleTelegramOutbound is defensive: the field
    // registry's normalizeTelegram guarantees a non-empty chatId whenever
    // agentTelegram is non-null, so an empty chatId cannot survive
    // deserialization. This test proves the realistic contract — WITH a default
    // chatId and NO inbound chat, the send still succeeds against the default —
    // which is why the "no chat to reply to" 400 branch is unreachable here and
    // coverage-excluded in the implementation.
    makeAgent('hasdefault', { chatId: '-100only', routing: 'self' });
    setToken('hasdefault', 'TOK-HD');
    // No inbound chat primed → reply target is the default chatId.

    const { status } = await api('POST', '/api/agents/send', {
      from: 'x', to: 'telegram:hasdefault', message: 'hi', topic: 'telegram',
    });

    assert.equal(status, 200, 'a per-agent bot with a default chatId always has a reply target');
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]!.chatId, '-100only');
  });

  it('agent with telegram config but NO token → falls back to destination (404 when none)', async () => {
    makeAgent('tokenless', { chatId: '-100', routing: 'self' });
    // No setToken → getTelegramToken returns null → not a per-agent send.

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'x', to: 'telegram:tokenless', message: 'hi', topic: 'telegram',
    });

    // No destination named "tokenless" either → 404 from the fallback path.
    assert.equal(status, 404);
    assert.match((data as { error: string }).error, /no agent or destination named "tokenless"/);
    assert.equal(sendCalls.length, 0);
  });

  it('agent with telegram config but NO token, WITH a same-named destination → sends via destination', async () => {
    makeAgent('bridged', { chatId: '-100', routing: 'self' });
    // No agent token, but a destination of the same name exists → legacy path.
    db.createDestination({ name: 'bridged', type: 'telegram', config: { botToken: 'DEST-TOK', chatId: '-777' } });

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'sender', to: 'telegram:bridged', message: 'via dest', topic: 'telegram',
    });

    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0]!.url.includes('/botDEST-TOK/sendMessage'), 'must use the destination token');
    assert.equal(sendCalls[0]!.chatId, '-777', 'must use the destination chatId');
    assert.equal(sendCalls[0]!.text, '[sender] via dest', 'destination path prefixes the sender');
  });

  it('telegram:<destname> (no such agent) → legacy destination send still works (regression)', async () => {
    db.createDestination({ name: 'globaltg', type: 'telegram', config: { botToken: 'GLOBAL-TOK', chatId: '-42' } });
    // No agent named "globaltg".

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'worker', to: 'telegram:globaltg', message: 'notify', topic: 'telegram',
    });

    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0]!.url.includes('/botGLOBAL-TOK/sendMessage'));
    assert.equal(sendCalls[0]!.chatId, '-42');
    assert.equal(sendCalls[0]!.text, '[worker] notify');
  });

  it('prefers the AGENT over a same-named destination (and warns)', async () => {
    makeAgent('dual', { chatId: '-100default', routing: 'self' });
    setToken('dual', 'AGENT-TOK');
    db.createDestination({ name: 'dual', type: 'telegram', config: { botToken: 'DEST-TOK', chatId: '-999' } });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    let result: { status: number; raw: string };
    try {
      result = await api('POST', '/api/agents/send', {
        from: 'dual', to: 'telegram:dual', message: 'agent wins', topic: 'telegram',
      });
    } finally {
      console.warn = origWarn;
    }

    assert.equal(result.status, 200);
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0]!.url.includes('/botAGENT-TOK/sendMessage'), 'agent token must win over destination token');
    assert.equal(sendCalls[0]!.chatId, '-100default');
    assert.ok(warns.some((w) => w.includes('dual') && w.includes('agent') && w.includes('destination')), `expected an ambiguity warn, got: ${warns.join('|')}`);
    // The token must NOT appear in any warn line.
    assert.ok(!warns.some((w) => w.includes('AGENT-TOK') || w.includes('DEST-TOK')), 'token must never be logged');
  });

  it('send failure → 502', async () => {
    makeAgent('fails', { chatId: '-100', routing: 'self' });
    setToken('fails', 'TOK-FAILS');
    sendStatus = 403; // Telegram rejects → dispatcher.send returns false.

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'x', to: 'telegram:fails', message: 'will fail', topic: 'telegram',
    });

    assert.equal(status, 502);
    assert.match((data as { error: string }).error, /send failed/i);
    assert.equal(sendCalls.length, 1, 'a send was attempted');
    // No dashboard message recorded on failure.
    assert.equal(messagesFor('telegram:fails').length, 0);
  });

  it('400 when message is missing', async () => {
    makeAgent('needmsg', { chatId: '-100', routing: 'self' });
    setToken('needmsg', 'TOK');

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'x', to: 'telegram:needmsg', message: '', topic: 'telegram',
    });

    // The agents/send route rejects empty message at the top guard (from/to/message/topic required).
    assert.equal(status, 400);
    assert.ok(typeof (data as { error: string }).error === 'string');
    assert.equal(sendCalls.length, 0);
  });

  it('the bot token NEVER appears in any response body (success or failure)', async () => {
    makeAgent('secret', { chatId: '-100', routing: 'self' });
    setToken('secret', 'SUPER-SECRET-TOKEN-XYZ');
    primeInboundChat('secret', 'SUPER-SECRET-TOKEN-XYZ', '321');
    sendCalls = [];

    // Success path.
    const ok = await api('POST', '/api/agents/send', {
      from: 'secret', to: 'telegram:secret', message: 'ping', topic: 'telegram',
    });
    assert.equal(ok.status, 200);
    assert.ok(!ok.raw.includes('SUPER-SECRET-TOKEN-XYZ'), 'token must not be in the 200 body');

    // Failure path.
    sendStatus = 500;
    const fail = await api('POST', '/api/agents/send', {
      from: 'secret', to: 'telegram:secret', message: 'ping again', topic: 'telegram',
    });
    assert.equal(fail.status, 502);
    assert.ok(!fail.raw.includes('SUPER-SECRET-TOKEN-XYZ'), 'token must not be in the 502 body');
  });

  it('POST /api/dashboard/send rejects telegram:<agent> as not dashboard-sendable (400)', async () => {
    makeAgent('dashreject', { chatId: '-100', routing: 'self' });
    setToken('dashreject', 'TOK');

    const { status, data } = await api('POST', '/api/dashboard/send', {
      agent: 'telegram:dashreject', message: 'nope', topic: 'telegram',
    });

    assert.equal(status, 400);
    assert.match((data as { error: string }).error, /not a dashboard-sendable address/);
  });
});
