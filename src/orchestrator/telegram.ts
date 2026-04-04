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

export class TelegramDispatcher {
  private pollingAbort: AbortController | null = null;
  private pollingPromise: Promise<void> | null = null;
  private lastUpdateId = 0;

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
   * Start long polling for inbound messages.
   * Calls onMessage for each text message received.
   * Retries on error after 5s delay.
   */
  startPolling(botToken: string, onMessage: (chatId: string, text: string) => void): void {
    if (this.pollingAbort) {
      this.stopPolling();
    }
    this.pollingAbort = new AbortController();
    this.lastUpdateId = 0;

    const poll = async (): Promise<void> => {
      const signal = this.pollingAbort!.signal;
      while (!signal.aborted) {
        try {
          const url = `${TELEGRAM_API}/bot${botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`;
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
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
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

    this.pollingPromise = poll();
    console.log('[telegram] Long polling started');
  }

  /** Stop polling gracefully. */
  stopPolling(): void {
    if (this.pollingAbort) {
      this.pollingAbort.abort();
      this.pollingAbort = null;
      this.pollingPromise = null;
      console.log('[telegram] Long polling stopped');
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
