/**
 * Whisper STT batch proxy: forwards browser-captured audio clips to an
 * OpenAI-compatible Whisper transcription endpoint and returns the text.
 *
 * Sibling to voice-proxy.ts (ElevenLabs realtime WebSocket). Where
 * ElevenLabs streams partial transcripts back as the user speaks, Whisper
 * is batch — a PTT clip is recorded in the browser, posted as a single
 * multipart upload, and the JSON transcript is returned in one shot.
 *
 * Zero dependencies — uses Node 18+ native fetch / FormData / Blob.
 */

export type WhisperOptions = {
  /**
   * Full transcription endpoint URL.
   * Examples:
   *  - OpenAI:                   https://api.openai.com/v1/audio/transcriptions
   *  - faster-whisper-server:    http://localhost:8000/v1/audio/transcriptions
   *  - vLLM whisper:             http://host:8000/v1/audio/transcriptions
   */
  url: string;
  /** Bearer token. Required for OpenAI; optional for most self-hosted servers. */
  apiKey?: string | undefined;
  /** Model name. Default `whisper-1` (OpenAI naming). */
  model?: string | undefined;
  /** ISO-639-1 language hint (e.g. `en`). Optional. */
  language?: string | undefined;
  /** Request timeout in ms. Default 60_000. */
  timeoutMs?: number | undefined;
};

export type TranscribeResult = {
  text: string;
};

export async function transcribe(
  audio: Buffer | Uint8Array,
  contentType: string,
  filename: string,
  opts: WhisperOptions,
): Promise<TranscribeResult> {
  const form = new FormData();
  // Blob accepts ArrayBuffer/TypedArray/Buffer at runtime (Buffer extends Uint8Array).
  // cast: node:buffer's BlobPart excludes ArrayBufferLike-backed views (it forbids the
  // SharedArrayBuffer case), but `audio` is always a regular Buffer/Uint8Array here,
  // so the runtime is unaffected — the cast only bridges the lib-type gap.
  const blob = new Blob([audio as NodeJS.BufferSource], { type: contentType });
  form.append('file', blob, filename);
  form.append('model', opts.model ?? 'whisper-1');
  if (opts.language) form.append('language', opts.language);
  form.append('response_format', 'json');

  const headers: Record<string, string> = {};
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(opts.url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const e = err as Error;
    const msg = e.name === 'AbortError'
      ? `Whisper request timed out after ${timeoutMs}ms`
      : `Whisper request failed: ${e.message}`;
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Whisper returned ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = await resp.json() as { text?: unknown };
  if (typeof json.text !== 'string') {
    throw new Error('Whisper response missing text field');
  }
  return { text: json.text };
}
