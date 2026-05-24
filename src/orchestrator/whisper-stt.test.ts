import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe } from './whisper-stt.ts';

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FormData;
};

const realFetch = globalThis.fetch;

let nextResponse: { status: number; body: string; headers?: Record<string, string> } | null = null;
let captured: FetchCall | null = null;
let throwOnFetch: Error | null = null;
let delayMs = 0;

function mockFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (throwOnFetch) throw throwOnFetch;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
      });
    }
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }
    captured = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as FormData,
    };
    const r = nextResponse ?? { status: 200, body: JSON.stringify({ text: 'hello' }) };
    return new Response(r.body, {
      status: r.status,
      headers: r.headers ?? { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('whisper-stt.transcribe', () => {
  before(() => {
    globalThis.fetch = mockFetch();
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    nextResponse = null;
    captured = null;
    throwOnFetch = null;
    delayMs = 0;
  });

  it('returns text from a 200 JSON response', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'hello world' }) };
    const result = await transcribe(
      Buffer.from([1, 2, 3, 4]),
      'audio/webm',
      'audio.webm',
      { url: 'https://example.test/v1/audio/transcriptions' },
    );
    assert.equal(result.text, 'hello world');
  });

  it('attaches Bearer auth when apiKey provided', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'x' }) };
    await transcribe(
      Buffer.from([1]),
      'audio/webm',
      'audio.webm',
      { url: 'https://example.test/v1/audio/transcriptions', apiKey: 'sk-test' },
    );
    assert.ok(captured);
    assert.equal(captured!.headers['authorization'], 'Bearer sk-test');
  });

  it('omits Authorization header when no apiKey', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'x' }) };
    await transcribe(
      Buffer.from([1]),
      'audio/webm',
      'audio.webm',
      { url: 'https://example.test/v1/audio/transcriptions' },
    );
    assert.ok(captured);
    assert.equal(captured!.headers['authorization'], undefined);
  });

  it('sets model + language in the FormData', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'x' }) };
    await transcribe(
      Buffer.from([1]),
      'audio/webm',
      'audio.webm',
      { url: 'https://example.test/v1/audio/transcriptions', model: 'whisper-large-v3', language: 'en' },
    );
    assert.ok(captured);
    assert.equal(captured!.body.get('model'), 'whisper-large-v3');
    assert.equal(captured!.body.get('language'), 'en');
    assert.equal(captured!.body.get('response_format'), 'json');
  });

  it('defaults model to whisper-1', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'x' }) };
    await transcribe(
      Buffer.from([1]),
      'audio/webm',
      'audio.webm',
      { url: 'https://example.test/v1/audio/transcriptions' },
    );
    assert.equal(captured!.body.get('model'), 'whisper-1');
    assert.equal(captured!.body.get('language'), null);
  });

  it('attaches the audio as a Blob file with given filename', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'x' }) };
    await transcribe(
      Buffer.from([10, 20, 30]),
      'audio/wav',
      'clip-123.wav',
      { url: 'https://example.test/v1/audio/transcriptions' },
    );
    const file = captured!.body.get('file');
    assert.ok(file instanceof Blob, 'file field should be a Blob');
    assert.equal((file as Blob).type, 'audio/wav');
    assert.equal((file as Blob).size, 3);
    // Filename comes through on File subtype; jsdom-free env exposes name on the appended Blob
    if (file && 'name' in (file as object)) {
      assert.equal((file as { name?: string }).name, 'clip-123.wav');
    }
  });

  it('throws with status + body on non-2xx', async () => {
    nextResponse = { status: 401, body: JSON.stringify({ error: 'invalid api key' }) };
    await assert.rejects(
      () => transcribe(
        Buffer.from([1]),
        'audio/webm',
        'audio.webm',
        { url: 'https://example.test/v1/audio/transcriptions' },
      ),
      /Whisper returned 401/,
    );
  });

  it('throws when response is missing text field', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ language: 'en' }) };
    await assert.rejects(
      () => transcribe(
        Buffer.from([1]),
        'audio/webm',
        'audio.webm',
        { url: 'https://example.test/v1/audio/transcriptions' },
      ),
      /missing text field/,
    );
  });

  it('throws a clear error on network failure', async () => {
    throwOnFetch = new Error('ECONNREFUSED');
    await assert.rejects(
      () => transcribe(
        Buffer.from([1]),
        'audio/webm',
        'audio.webm',
        { url: 'https://example.test/v1/audio/transcriptions' },
      ),
      /Whisper request failed: ECONNREFUSED/,
    );
  });

  it('aborts on timeout', async () => {
    delayMs = 100;
    await assert.rejects(
      () => transcribe(
        Buffer.from([1]),
        'audio/webm',
        'audio.webm',
        { url: 'https://example.test/v1/audio/transcriptions', timeoutMs: 10 },
      ),
      /timed out after 10ms/,
    );
  });

  it('POSTs to the configured URL', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ text: 'x' }) };
    await transcribe(
      Buffer.from([1]),
      'audio/webm',
      'audio.webm',
      { url: 'http://localhost:8000/v1/audio/transcriptions' },
    );
    assert.equal(captured!.url, 'http://localhost:8000/v1/audio/transcriptions');
    assert.equal(captured!.method, 'POST');
  });
});
