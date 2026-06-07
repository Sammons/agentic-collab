/**
 * Telegram Bot API dispatcher.
 * Handles outbound message sending and inbound long polling.
 * Uses native fetch() — no npm dependencies.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Rate limiter: max 1 message per second per chatId. */
const lastSendTimestamps = new Map<string, number>();

export type InboundTelegramMessage = {
  chatId: string;
  text: string;
};

/**
 * Per-key polling state. Each entry owns its OWN abort controller and offset
 * (`lastUpdateId`) so multiple bots can long-poll concurrently without sharing
 * an offset. `token` is recorded so a loop can be inspected/restarted by key.
 */
type PollingState = {
  abort: AbortController;
  promise: Promise<void>;
  lastUpdateId: number;
  token: string;
};

export class TelegramDispatcher {
  /** key (agent name in the eventual feature; an opaque string here) → loop. */
  private polls = new Map<string, PollingState>();

  /**
   * Send a message to a Telegram chat via Bot API.
   * Respects rate limit of 1 message/second per chatId.
   */
  async send(botToken: string, chatId: string, text: string): Promise<boolean> {
    // Rate limit: 1 msg/sec per chatId
    const now = Date.now();
    const lastSent = lastSendTimestamps.get(chatId) ?? 0;
    const elapsed = now - lastSent;
    if (elapsed < 1000) {
      await new Promise<void>((r) => setTimeout(r, 1000 - elapsed));
    }
    lastSendTimestamps.set(chatId, Date.now());

    try {
      const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[telegram] sendMessage failed (${resp.status}): ${body}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[telegram] sendMessage error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Start long polling for inbound messages under `key`.
   * Stops any existing loop for `key` first, then starts a fresh per-key loop
   * with its own offset. Multiple keys poll concurrently (one bot per key).
   * Calls onMessage for each text message received. Retries on error after 5s.
   */
  startPolling(key: string, botToken: string, onMessage: (chatId: string, text: string) => void): void {
    // Replace any prior loop for this key with a fresh one (resets the offset).
    this.stopPolling(key);

    const abort = new AbortController();
    const state: PollingState = { abort, promise: Promise.resolve(), lastUpdateId: 0, token: botToken };

    const poll = async (): Promise<void> => {
      const signal = abort.signal;
      while (!signal.aborted) {
        try {
          const url = `${TELEGRAM_API}/bot${botToken}/getUpdates?offset=${state.lastUpdateId + 1}&timeout=30`;
          const resp = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[telegram] getUpdates failed (${resp.status}): ${body}`);
            if (!signal.aborted) await delay(5000, signal);
            continue;
          }
          const data = await resp.json() as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
          if (!data.ok || !data.result) {
            if (!signal.aborted) await delay(5000, signal);
            continue;
          }
          for (const update of data.result) {
            state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);
            if (update.message?.text) {
              const chatId = String(update.message.chat.id);
              onMessage(chatId, update.message.text);
            }
          }
        } catch (err) {
          if (signal.aborted) return;
          console.error(`[telegram] Poll error: ${(err as Error).message}`);
          await delay(5000, signal).catch(() => {});
        }
      }
    };

    state.promise = poll();
    this.polls.set(key, state);
    console.log(`[telegram] Long polling started for "${key}"`);
  }

  /** Keys with a currently-running poll loop (for reconcile diffing). */
  runningKeys(): string[] {
    return [...this.polls.keys()];
  }

  /** True if a poll loop is running for `key`. */
  isPolling(key: string): boolean {
    return this.polls.has(key);
  }

  /** The token a running loop is polling under `key`, or null if none. */
  getPollToken(key: string): string | null {
    return this.polls.get(key)?.token ?? null;
  }

  /** Stop the polling loop for `key` gracefully (no-op if none). */
  stopPolling(key: string): void {
    const state = this.polls.get(key);
    if (state) {
      state.abort.abort();
      this.polls.delete(key);
      console.log(`[telegram] Long polling stopped for "${key}"`);
    }
  }

  /** Stop every running polling loop. */
  stopAll(): void {
    for (const key of [...this.polls.keys()]) {
      this.stopPolling(key);
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
