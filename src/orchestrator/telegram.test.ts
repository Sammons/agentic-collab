/**
 * Behavior baseline + multi-bot tests for the Telegram dispatcher.
 *
 * The dispatcher talks to the Telegram HTTP API exclusively through the global
 * `fetch`. These tests replace `globalThis.fetch` with a controllable fake
 * (saved/restored in before/after) so we can assert on the exact URLs/bodies it
 * emits and feed it scripted getUpdates responses without any network.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramDispatcher } from './telegram.ts';

type FetchCall = { url: string; init: RequestInit | undefined };

/** Resolve once `predicate()` is true, polling the microtask/timer queue. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

describe('TelegramDispatcher', () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];

  /**
   * Installs a fetch fake. `handler` receives the requested URL and returns a
   * Response-like object. By default getUpdates returns an empty result set and
   * sendMessage returns { ok: true }.
   */
  function installFetch(handler?: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      // Honor the abort signal so a long-poll can be cancelled by stopPolling.
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      if (handler) return await handler(url, init);
      if (url.includes('/getUpdates')) {
        // Default: behave like a real long-poll with no traffic — block until
        // aborted rather than returning instantly (which would busy-loop).
        return pendingUntilAborted(init);
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }

  /**
   * Models a Telegram long-poll with no pending updates: the promise stays
   * unresolved until the request's abort signal fires, mirroring the real API
   * blocking up to `timeout` seconds. Returning `{ result: [] }` instantly would
   * make the dispatcher's `while` loop busy-spin and OOM the test.
   */
  function pendingUntilAborted(init?: RequestInit): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  }

  before(() => {
    // Ensure the shared rate limiter never blocks the suite by starting clean.
  });

  beforeEach(() => {
    calls = [];
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  describe('send', () => {
    it('POSTs to /bot<token>/sendMessage with the right body and returns true on ok', async () => {
      installFetch();
      const d = new TelegramDispatcher();
      // Use a unique chatId so the shared rate limiter does not throttle this send.
      const chatId = `send-ok-${Date.now()}`;
      const ok = await d.send('TOKEN123', chatId, 'hello world');

      assert.equal(ok, true);
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.url, 'https://api.telegram.org/botTOKEN123/sendMessage');
      assert.equal(call.init?.method, 'POST');
      assert.deepEqual(JSON.parse(call.init!.body as string), { chat_id: chatId, text: 'hello world' });
      const headers = call.init?.headers as Record<string, string>;
      assert.equal(headers['Content-Type'], 'application/json');
    });

    it('returns false when the API responds non-ok', async () => {
      installFetch(() => jsonResponse({ ok: false, description: 'boom' }, 400));
      const d = new TelegramDispatcher();
      const ok = await d.send('TOKEN123', `send-fail-${Date.now()}`, 'nope');
      assert.equal(ok, false);
    });

    it('throttles repeat sends to the same chatId (per-chatId rate limiter)', async () => {
      installFetch();
      const d = new TelegramDispatcher();
      const chatId = `rate-${Date.now()}`;

      const t0 = Date.now();
      await d.send('TOKEN', chatId, 'first');
      await d.send('TOKEN', chatId, 'second');
      const elapsed = Date.now() - t0;

      // The limiter is 1 msg/sec per chatId, so the second send waits ~1s.
      assert.ok(elapsed >= 950, `expected >=~1000ms throttle, got ${elapsed}ms`);
      assert.equal(calls.length, 2);
    });

    it('shares the rate limiter across dispatcher instances (module-global)', async () => {
      installFetch();
      const a = new TelegramDispatcher();
      const b = new TelegramDispatcher();
      const chatId = `shared-${Date.now()}`;

      const t0 = Date.now();
      await a.send('TOK-A', chatId, 'from a');
      await b.send('TOK-B', chatId, 'from b'); // different bot, same chatId
      const elapsed = Date.now() - t0;

      assert.ok(elapsed >= 950, `expected cross-instance throttle, got ${elapsed}ms`);
    });
  });

  describe('polling', () => {
    it('getUpdates uses offset=1 initially, advances offset past returned updates, and delivers text messages', async () => {
      let served = false;
      const received: Array<{ chatId: string; text: string }> = [];
      installFetch((url, init) => {
        if (url.includes('/getUpdates')) {
          if (!served) {
            served = true;
            return jsonResponse({
              ok: true,
              result: [
                { update_id: 41, message: { chat: { id: 555 }, text: 'one' } },
                { update_id: 42, message: { chat: { id: 555 }, text: 'two' } },
              ],
            });
          }
          // Subsequent polls block like a real idle long-poll (until aborted).
          return pendingUntilAborted(init);
        }
        return jsonResponse({ ok: true });
      });

      const d = new TelegramDispatcher();
      d.startPolling('agentA', 'BOTTOK', (chatId, text) => received.push({ chatId, text }));

      await waitFor(() => received.length >= 2);

      // First getUpdates uses offset = lastUpdateId(0) + 1 = 1.
      const first = calls.find((c) => c.url.includes('/getUpdates'))!;
      assert.ok(first.url.startsWith('https://api.telegram.org/botBOTTOK/getUpdates'));
      assert.ok(first.url.includes('offset=1'), `first poll URL: ${first.url}`);
      assert.ok(first.url.includes('timeout=30'));

      // Both text messages delivered with stringified chatId.
      assert.deepEqual(received, [
        { chatId: '555', text: 'one' },
        { chatId: '555', text: 'two' },
      ]);

      // A later getUpdates advanced the offset past update_id 42 → offset=43.
      await waitFor(() => calls.filter((c) => c.url.includes('/getUpdates')).length >= 2);
      const second = calls.filter((c) => c.url.includes('/getUpdates'))[1]!;
      assert.ok(second.url.includes('offset=43'), `second poll URL: ${second.url}`);

      d.stopPolling('agentA');
    });

    it('skips updates without text but still advances the offset', async () => {
      let served = false;
      const received: string[] = [];
      installFetch((url, init) => {
        if (url.includes('/getUpdates')) {
          if (!served) {
            served = true;
            return jsonResponse({
              ok: true,
              result: [
                { update_id: 7, message: { chat: { id: 1 } } }, // no text
                { update_id: 8, message: { chat: { id: 1 }, text: 'hi' } },
              ],
            });
          }
          return pendingUntilAborted(init);
        }
        return jsonResponse({ ok: true });
      });

      const d = new TelegramDispatcher();
      d.startPolling('agentB', 'TOK', (_chatId, text) => received.push(text));
      await waitFor(() => received.length >= 1);

      assert.deepEqual(received, ['hi']);
      await waitFor(() => calls.filter((c) => c.url.includes('/getUpdates')).length >= 2);
      const second = calls.filter((c) => c.url.includes('/getUpdates'))[1]!;
      assert.ok(second.url.includes('offset=9'), `expected offset past 8, got ${second.url}`);
      d.stopPolling('agentB');
    });

    it('stopPolling aborts the in-flight long-poll (fetch wired to the abort signal)', async () => {
      let sawAbort = false;
      installFetch((url, init) => {
        if (url.includes('/getUpdates')) {
          // Emulate a long poll: resolve only when aborted (mirrors a 30s wait).
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error('no signal wired to getUpdates fetch'));
              return;
            }
            signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
        }
        return jsonResponse({ ok: true });
      });

      const d = new TelegramDispatcher();
      d.startPolling('agentC', 'TOK', () => {});
      // Wait until the long-poll fetch is in flight.
      await waitFor(() => calls.some((c) => c.url.includes('/getUpdates')));

      d.stopPolling('agentC');
      await waitFor(() => sawAbort);
      assert.equal(sawAbort, true);
    });

    it('startPolling for an existing key stops the prior loop before starting fresh (offset resets)', async () => {
      const offsets: string[] = [];
      installFetch((url, init) => {
        if (url.includes('/getUpdates')) {
          const m = url.match(/offset=(\d+)/);
          if (m) offsets.push(m[1]!);
          // Serve one update the first time we see offset=1 so lastUpdateId advances.
          if (m?.[1] === '1' && offsets.filter((o) => o === '1').length === 1) {
            return jsonResponse({ ok: true, result: [{ update_id: 100, message: { chat: { id: 9 }, text: 'x' } }] });
          }
          return pendingUntilAborted(init);
        }
        return jsonResponse({ ok: true });
      });

      const d = new TelegramDispatcher();
      d.startPolling('dup', 'TOK', () => {});
      // Let it advance past offset=1 to offset=101.
      await waitFor(() => offsets.includes('101'));

      // Restart the SAME key — must stop the old loop and reset its own offset to 1.
      d.startPolling('dup', 'TOK', () => {});
      await waitFor(() => offsets.filter((o) => o === '1').length >= 2);
      assert.ok(offsets.filter((o) => o === '1').length >= 2, 'restart should reset offset to 1');
      d.stopPolling('dup');
    });

    it('runs multiple bot loops concurrently, each with its own offset (the latent single-loop bug fix)', async () => {
      const byToken = new Map<string, string[]>(); // token -> offsets seen
      const served = new Set<string>();
      installFetch((url, init) => {
        const tokMatch = url.match(/\/bot([^/]+)\//);
        const token = tokMatch?.[1] ?? '';
        if (url.includes('/getUpdates')) {
          const offMatch = url.match(/offset=(\d+)/);
          const arr = byToken.get(token) ?? [];
          if (offMatch) arr.push(offMatch[1]!);
          byToken.set(token, arr);
          // Each bot serves one distinct update on its first poll.
          if (!served.has(token)) {
            served.add(token);
            const updId = token === 'TOK-A' ? 10 : 20;
            const chat = token === 'TOK-A' ? 1 : 2;
            return jsonResponse({ ok: true, result: [{ update_id: updId, message: { chat: { id: chat }, text: token } }] });
          }
          return pendingUntilAborted(init);
        }
        return jsonResponse({ ok: true });
      });

      const received: string[] = [];
      const d = new TelegramDispatcher();
      d.startPolling('agentA', 'TOK-A', (_c, t) => received.push(t));
      d.startPolling('agentB', 'TOK-B', (_c, t) => received.push(t));

      // BOTH bots must deliver — proving the old "last loop wins" bug is gone.
      await waitFor(() => received.includes('TOK-A') && received.includes('TOK-B'));
      assert.ok(received.includes('TOK-A'));
      assert.ok(received.includes('TOK-B'));

      // Each loop keeps its own offset: A advances to 11, B to 21.
      await waitFor(() => (byToken.get('TOK-A') ?? []).includes('11') && (byToken.get('TOK-B') ?? []).includes('21'));
      assert.ok((byToken.get('TOK-A') ?? []).includes('11'), 'bot A advanced its own offset');
      assert.ok((byToken.get('TOK-B') ?? []).includes('21'), 'bot B advanced its own offset');

      d.stopAll();
    });

    it('stopAll aborts every running loop', async () => {
      const aborts = new Set<string>();
      installFetch((url, init) => {
        if (url.includes('/getUpdates')) {
          const token = url.match(/\/bot([^/]+)\//)?.[1] ?? '';
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborts.add(token);
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
        }
        return jsonResponse({ ok: true });
      });

      const d = new TelegramDispatcher();
      d.startPolling('a', 'TOK-A', () => {});
      d.startPolling('b', 'TOK-B', () => {});
      await waitFor(() => calls.filter((c) => c.url.includes('/getUpdates')).length >= 2);

      d.stopAll();
      await waitFor(() => aborts.has('TOK-A') && aborts.has('TOK-B'));
      assert.ok(aborts.has('TOK-A'));
      assert.ok(aborts.has('TOK-B'));
    });
  });
});
