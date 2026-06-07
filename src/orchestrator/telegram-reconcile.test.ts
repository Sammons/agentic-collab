/**
 * RFC-008 PR-C: per-agent Telegram bot reconcile + inbound routing tests.
 *
 * Exercises reconcileTelegramBots (desired-set diff, token dedup, legacy
 * destination coexistence, restart-on-change) and onMessageFor (self/prefix/
 * passthrough routing, telegram-aware envelope, last-inbound-chat map, the
 * void-agent reply-on-offline policy).
 *
 * Real Database (tmp file), real WebSocketServer + MessageDispatcher, real
 * TelegramDispatcher. The dispatcher talks to Telegram only through the global
 * `fetch`, which is faked here (mirroring telegram.test.ts) so poll loops never
 * hit the network and the void-reply send is observable.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
  reconcileTelegramBots,
  onMessageFor,
  getLastInboundChat,
  getTelegramToken,
  _resetTelegramReconcileState,
  type RouteContext,
} from './routes.ts';
import type { AgentTelegramConfig, ProxyCommand, ProxyResponse } from '../shared/types.ts';

type FetchCall = { url: string; body: unknown };

describe('reconcileTelegramBots + inbound (RFC-008 PR-C)', () => {
  const realFetch = globalThis.fetch;
  let tmpDir: string;
  let db: Database;
  let wss: WebSocketServer;
  let dispatcher: TelegramDispatcher;
  let ctx: RouteContext;
  let sendCalls: FetchCall[];

  /** Fake fetch: getUpdates blocks until aborted (idle long-poll); sendMessage records + returns ok. */
  function installFetch(): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/sendMessage')) {
        sendCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        return jsonResponse({ ok: true });
      }
      // getUpdates: block until aborted so the loop doesn't busy-spin or OOM.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }

  const ORIG_SECRET = process.env['ORCHESTRATOR_SECRET'];

  before(() => {
    process.env['ORCHESTRATOR_SECRET'] = 'telegram-reconcile-test-secret';
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-test-'));
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
      orchestratorSecret: null,
      messageDispatcher: new MessageDispatcher({ db, locks, proxyDispatch, orchestratorHost: 'http://localhost:3000' }),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as never,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'homes'), skipAutoRegister: true }),
      telegramDispatcher: dispatcher,
    };
  });

  after(() => {
    dispatcher.stopAll();
    // Cancel scheduled drain timers so no enqueueAndDeliver→tryDeliver drain fires
    // after the DB closes ("database is not open" noise).
    ctx.messageDispatcher.stop();
    globalThis.fetch = realFetch;
    if (ORIG_SECRET === undefined) delete process.env['ORCHESTRATOR_SECRET'];
    else process.env['ORCHESTRATOR_SECRET'] = ORIG_SECRET;
    wss.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fresh state per test: stop loops, clear reconcile memory, drop all rows, reset fetch. */
  beforeEach(() => {
    dispatcher.stopAll();
    // Cancel any drain timers left scheduled by the previous test so they don't
    // fire mid-next-test against just-deleted rows.
    ctx.messageDispatcher.stop();
    _resetTelegramReconcileState();
    db.rawDb.exec('DELETE FROM agents; DELETE FROM destinations; DELETE FROM agent_telegram_tokens; DELETE FROM dashboard_messages; DELETE FROM pending_messages;');
    sendCalls = [];
    installFetch();
  });

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

  /** All dashboard messages for an agent thread (uncapped), oldest-first. */
  function messagesFor(agent: string) {
    return db.getDashboardThreads(agent, 0)[agent] ?? [];
  }

  describe('reconcile', () => {
    it('starts a poll keyed by agent name when telegram config + token are present', () => {
      makeAgent('almanac', { chatId: '-100', routing: 'self' });
      setToken('almanac', 'TOK-ALMANAC');

      reconcileTelegramBots(ctx);

      assert.deepEqual(dispatcher.runningKeys(), ['almanac']);
      assert.equal(dispatcher.getPollToken('almanac'), 'TOK-ALMANAC');
    });

    it('does NOT start when telegram config is present but no token resolves', () => {
      makeAgent('notoken', { chatId: '-100' });
      reconcileTelegramBots(ctx);
      assert.deepEqual(dispatcher.runningKeys(), []);
    });

    it('does NOT start an inbound:false (outbound-only) agent', () => {
      makeAgent('outonly', { chatId: '-100', inbound: false });
      setToken('outonly', 'TOK-OUT');
      reconcileTelegramBots(ctx);
      assert.deepEqual(dispatcher.runningKeys(), []);
    });

    it('stops a poll when the agent loses its telegram config', () => {
      makeAgent('temp', { chatId: '-100' });
      setToken('temp', 'TOK-TEMP');
      reconcileTelegramBots(ctx);
      assert.ok(dispatcher.isPolling('temp'));

      // Drop the config (simulate persona removal) and re-reconcile.
      db.rawDb.prepare('UPDATE agents SET agent_telegram = NULL WHERE name = ?').run('temp');
      reconcileTelegramBots(ctx);
      assert.equal(dispatcher.isPolling('temp'), false);
    });

    it('stops a poll when the token is deleted', () => {
      makeAgent('rot', { chatId: '-100' });
      setToken('rot', 'TOK-ROT');
      reconcileTelegramBots(ctx);
      assert.ok(dispatcher.isPolling('rot'));

      db.deleteTelegramToken('rot');
      reconcileTelegramBots(ctx);
      assert.equal(dispatcher.isPolling('rot'), false);
    });

    it('two agents sharing one resolved token → exactly one poll + a warn', () => {
      makeAgent('first', { chatId: '-1' });
      makeAgent('second', { chatId: '-2' });
      // Both resolve to the SAME token value.
      setToken('first', 'SHARED-TOKEN');
      setToken('second', 'SHARED-TOKEN');

      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
      try {
        reconcileTelegramBots(ctx);
      } finally {
        console.warn = origWarn;
      }

      // listAgents orders by sort_order then name → 'first' wins, 'second' skipped.
      assert.deepEqual(dispatcher.runningKeys(), ['first']);
      assert.ok(warns.some((w) => w.includes('second') && w.includes('409')), `expected dedup warn, got: ${warns.join('|')}`);
    });

    it('restarts the loop when the token rotates', () => {
      makeAgent('rotate', { chatId: '-100' });
      setToken('rotate', 'OLD-TOK');
      reconcileTelegramBots(ctx);
      assert.equal(dispatcher.getPollToken('rotate'), 'OLD-TOK');

      setToken('rotate', 'NEW-TOK');
      reconcileTelegramBots(ctx);
      assert.equal(dispatcher.getPollToken('rotate'), 'NEW-TOK');
      assert.deepEqual(dispatcher.runningKeys(), ['rotate']);
    });

    it('restarts the loop when chatId or routing changes (config delta)', () => {
      makeAgent('cfg', { chatId: '-100', routing: 'self' });
      setToken('cfg', 'TOK-CFG');
      reconcileTelegramBots(ctx);
      assert.ok(dispatcher.isPolling('cfg'));

      // Flip routing → reconcile should stop+start (restart). Observe via a fresh
      // start: stop the loop manually, change config, reconcile re-converges.
      let restarted = false;
      const origStop = dispatcher.stopPolling.bind(dispatcher);
      dispatcher.stopPolling = (key: string) => { if (key === 'cfg') restarted = true; origStop(key); };
      try {
        db.rawDb.prepare('UPDATE agents SET agent_telegram = ? WHERE name = ?')
          .run(JSON.stringify({ chatId: '-200', routing: 'passthrough' }), 'cfg');
        reconcileTelegramBots(ctx);
      } finally {
        dispatcher.stopPolling = origStop;
      }
      assert.ok(restarted, 'config change should restart the loop');
      assert.ok(dispatcher.isPolling('cfg'));
    });

    it('is idempotent: a second reconcile with no change does not restart', () => {
      makeAgent('stable', { chatId: '-100' });
      setToken('stable', 'TOK-STABLE');
      reconcileTelegramBots(ctx);

      let stopped = false;
      const origStop = dispatcher.stopPolling.bind(dispatcher);
      dispatcher.stopPolling = (key: string) => { stopped = true; origStop(key); };
      try {
        reconcileTelegramBots(ctx);
      } finally {
        dispatcher.stopPolling = origStop;
      }
      assert.equal(stopped, false, 'unchanged agent should not be stopped/restarted');
      assert.ok(dispatcher.isPolling('stable'));
    });
  });

  describe('legacy destination coexistence', () => {
    it('skips a per-agent bot whose token a destination already polls (warn + skip)', () => {
      // A telegram destination already owns DEST-TOKEN.
      db.createDestination({ name: 'global', type: 'telegram', config: { botToken: 'DEST-TOKEN', chatId: '-9' } });
      makeAgent('collide', { chatId: '-100' });
      setToken('collide', 'DEST-TOKEN');

      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
      try {
        reconcileTelegramBots(ctx);
      } finally {
        console.warn = origWarn;
      }

      assert.deepEqual(dispatcher.runningKeys(), [], 'agent must not double-start a destination token');
      assert.ok(warns.some((w) => w.includes('collide') && w.includes('destination:global')), `expected coexistence warn, got: ${warns.join('|')}`);
    });

    it('a disabled destination does NOT claim the token (agent starts)', () => {
      db.createDestination({ name: 'off', type: 'telegram', config: { botToken: 'OFF-TOKEN' } });
      db.updateDestination('off', { enabled: false });
      makeAgent('uses-off-token', { chatId: '-100' });
      setToken('uses-off-token', 'OFF-TOKEN');

      reconcileTelegramBots(ctx);
      assert.deepEqual(dispatcher.runningKeys(), ['uses-off-token']);
    });
  });

  describe('inbound routing (onMessageFor)', () => {
    it('self → enqueueAndDeliver to the agent with a telegram-aware envelope + records chatId', () => {
      makeAgent('selfbot', { chatId: '-100', routing: 'self' });
      const handler = onMessageFor(ctx, 'selfbot', 'TOK');
      handler('555', 'hello there');

      const msgs = messagesFor('selfbot');
      const last = msgs[msgs.length - 1]!;
      assert.equal(last.message, 'hello there');
      assert.equal(last.sourceAgent, 'telegram:selfbot');
      assert.equal(last.topic, 'telegram');

      // The QUEUED envelope must be telegram-aware (from-address + reply hint), not raw text.
      const pending = db.listPendingMessages().filter((p) => p.targetAgent === 'selfbot');
      assert.ok(pending.length >= 1);
      const env = pending[pending.length - 1]!.envelope;
      assert.ok(env.includes('telegram:selfbot'), `envelope should name the telegram reply address: ${env}`);
      assert.ok(env.includes('collab send'), `envelope should carry a reply hint: ${env}`);
      assert.ok(env.includes('hello there'));

      // last-inbound-chat map primed for PR-D's outbound reply target.
      assert.equal(getLastInboundChat('selfbot'), '555');
    });

    it('prefix → routes to @other, falls back to self when no prefix', () => {
      makeAgent('hub', { chatId: '-100', routing: 'prefix' });
      makeAgent('other', { chatId: '-200', routing: 'self' });
      const handler = onMessageFor(ctx, 'hub', 'TOK');

      handler('1', '@other do the thing');
      const otherMsgs = messagesFor('other');
      assert.equal(otherMsgs[otherMsgs.length - 1]!.message, 'do the thing');

      handler('1', 'no prefix here');
      const hubMsgs = messagesFor('hub');
      assert.equal(hubMsgs[hubMsgs.length - 1]!.message, 'no prefix here');
    });

    it('passthrough → lands in the telegram:<agent> dashboard thread, no enqueue', () => {
      makeAgent('ptagent', { chatId: '-100', routing: 'passthrough' });
      const handler = onMessageFor(ctx, 'ptagent', 'TOK');
      handler('77', 'dashboard only');

      const threadMsgs = messagesFor('telegram:ptagent');
      assert.equal(threadMsgs[threadMsgs.length - 1]!.message, 'dashboard only');
      // No pending queue entry for the agent (passthrough does not deliver).
      const pending = db.listPendingMessages().filter((p) => p.targetAgent === 'ptagent');
      assert.equal(pending.length, 0);
    });

    it('void/missing agent → dispatcher.send offline reply on the bot, no enqueue', async () => {
      makeAgent('sleeper', { chatId: '-100', routing: 'self' }, 'void');
      const handler = onMessageFor(ctx, 'sleeper', 'OFFLINE-TOK');
      handler('999', 'are you there');

      // send is async (rate-limited); wait briefly for the fetch to land.
      await waitFor(() => sendCalls.length >= 1);
      const call = sendCalls[0]!;
      assert.ok(call.url.includes('/botOFFLINE-TOK/sendMessage'));
      assert.deepEqual(call.body, { chat_id: '999', text: 'sleeper is offline' });

      // No pending message was queued for the void agent.
      const pending = db.listPendingMessages().filter((p) => p.targetAgent === 'sleeper');
      assert.equal(pending.length, 0);
    });

    it('suspended agent → still enqueues (messages queue until resume)', () => {
      makeAgent('paused', { chatId: '-100', routing: 'self' });
      const a = db.getAgent('paused')!;
      db.updateAgentState('paused', 'suspended', a.version);

      const handler = onMessageFor(ctx, 'paused', 'TOK');
      handler('1', 'queued message');

      const pending = db.listPendingMessages().filter((p) => p.targetAgent === 'paused');
      assert.equal(pending.length, 1);
    });
  });

  describe('token hardening', () => {
    it('getTelegramToken warns + returns null when a present token row will not decrypt', () => {
      // Encrypt under a DIFFERENT name → AAD mismatch → decrypt fails under 'mismatch'.
      const ct = encryptSecret('TOK', 'someone-else');
      assert.ok(ct, 'encryptSecret should produce ciphertext');
      db.setTelegramToken('mismatch', ct!);

      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
      let token: string | null;
      try {
        token = getTelegramToken(db, 'mismatch');
      } finally {
        console.warn = origWarn;
      }

      assert.equal(token, null, 'AAD mismatch must not decrypt');
      assert.ok(
        warns.some((w) => w.includes('mismatch') && w.includes('failed to decrypt')),
        `expected an undecryptable-token warn, got: ${warns.join('|')}`,
      );
    });

    it('deleteAgent cascades the per-agent telegram token row', () => {
      makeAgent('doomed', { chatId: '-1' });
      setToken('doomed', 'TOK-DOOMED');
      assert.notEqual(db.getTelegramTokenCiphertext('doomed'), null, 'token should exist pre-delete');

      db.deleteAgent('doomed');
      assert.equal(db.getTelegramTokenCiphertext('doomed'), null, 'token row must be cascaded on agent delete');
    });
  });
});

/** Resolve once `predicate()` is true, polling the timer queue. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}
