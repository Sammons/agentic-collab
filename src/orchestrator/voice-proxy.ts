/**
 * Voice dictation proxy: bridges browser audio to ElevenLabs realtime STT.
 *
 * Each voice session gets a unique ID from the browser. The orchestrator opens
 * an upstream WebSocket to ElevenLabs, relays audio chunks (browser → EL) and
 * transcripts (EL → browser). Session is torn down on disconnect.
 *
 * Zero dependencies — uses Node's built-in crypto for WebSocket handshake
 * and native fetch/WebSocket-like TCP for the upstream ElevenLabs connection.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect } from 'node:tls';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 512 * 1024; // 512 KB max frame

// Opcodes
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xA;

export type VoiceProxyOptions = {
  elevenLabsApiKey: string;
  sttModel?: string;
  language?: string;
};

type VoiceSession = {
  sid: string;
  browser: Duplex;
  upstream: Duplex | null;
  closed: boolean;
};

const sessions = new Map<string, VoiceSession>();

/**
 * Handle a WebSocket upgrade for /ws/voice.
 * Query params: sid (session ID), mode (vad|manual), silence (seconds).
 */
export function handleVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  _head: Buffer,
  opts: VoiceProxyOptions,
): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sid = url.searchParams.get('sid');
  if (!sid) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing sid parameter');
    socket.destroy();
    return;
  }

  // Complete WebSocket handshake with browser
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const mode = url.searchParams.get('mode') ?? 'vad';
  const silence = parseFloat(url.searchParams.get('silence') ?? '1.5');
  const sampleRate = parseInt(url.searchParams.get('sample_rate') ?? '16000', 10);

  const session: VoiceSession = { sid, browser: socket, upstream: null, closed: false };
  sessions.set(sid, session);

  console.log(`[voice] Session ${sid} started (mode=${mode}, silence=${silence}s, rate=${sampleRate})`);

  // Connect to ElevenLabs upstream
  connectUpstream(session, opts, mode, silence, sampleRate);

  // Handle browser frames
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES * 2) {
      closeSession(session, 'browser buffer overflow');
      return;
    }

    while (buffer.length >= 2) {
      const frame = parseClientFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.totalLength);
      handleBrowserFrame(session, frame.opcode, frame.payload);
    }
  });

  socket.on('close', () => closeSession(session, 'browser disconnected'));
  socket.on('error', () => closeSession(session, 'browser error'));
}

function handleBrowserFrame(session: VoiceSession, opcode: number, payload: Buffer): void {
  if (session.closed) return;

  switch (opcode) {
    case OP_TEXT: {
      // JSON control messages from browser
      try {
        const msg = JSON.parse(payload.toString('utf-8'));
        if (msg.type === 'audio_chunk' && msg.audio && session.upstream?.writable) {
          // Browser sends base64 audio in JSON — relay to ElevenLabs
          const elMsg = JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: msg.audio,
          });
          sendUpstreamText(session, elMsg);
        } else if (msg.type === 'commit' && session.upstream?.writable) {
          // Manual commit (push-to-talk release)
          const elMsg = JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: '',
            commit: true,
          });
          sendUpstreamText(session, elMsg);
        } else if (msg.type === 'ping') {
          sendBrowserText(session, JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore malformed
      }
      break;
    }
    case OP_BINARY:
      // Raw binary audio — convert to base64 and relay
      if (session.upstream?.writable) {
        const elMsg = JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: payload.toString('base64'),
        });
        sendUpstreamText(session, elMsg);
      }
      break;
    case OP_PING:
      sendBrowserFrame(session, OP_PONG, payload);
      break;
    case OP_CLOSE:
      closeSession(session, 'browser close frame');
      break;
  }
}

// ── ElevenLabs Upstream Connection (raw TLS + WebSocket) ──

function connectUpstream(
  session: VoiceSession,
  opts: VoiceProxyOptions,
  mode: string,
  silence: number,
  sampleRate: number,
): void {
  const host = 'api.elevenlabs.io';
  const model = opts.sttModel ?? 'scribe_v2';
  const lang = opts.language ?? 'eng';
  const commitStrategy = mode === 'vad' ? 'vad' : 'manual';
  const audioFormat = `pcm_${sampleRate}`;

  const params = new URLSearchParams({
    model_id: model,
    language_code: lang,
    commit_strategy: commitStrategy,
    audio_format: audioFormat,
    enable_logging: 'false',
  });
  if (commitStrategy === 'vad') {
    params.set('vad_silence_threshold_secs', String(silence));
  }

  const path = `/v1/speech-to-text/realtime?${params}`;

  // Generate WebSocket key
  const wsKey = createHash('sha1').update(String(Date.now() + Math.random())).digest('base64');

  const tlsSocket = connect({
    host,
    port: 443,
    servername: host,
  }, () => {
    // Send HTTP upgrade request
    const upgradeReq =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `xi-api-key: ${opts.elevenLabsApiKey}\r\n` +
      `\r\n`;
    tlsSocket.write(upgradeReq);
  });

  session.upstream = tlsSocket;

  let handshakeComplete = false;
  let upBuffer = Buffer.alloc(0);

  tlsSocket.on('data', (chunk: Buffer) => {
    if (session.closed) return;
    upBuffer = Buffer.concat([upBuffer, chunk]);

    if (!handshakeComplete) {
      // Look for end of HTTP headers
      const headerEnd = upBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headers = upBuffer.subarray(0, headerEnd).toString('utf-8');
      upBuffer = upBuffer.subarray(headerEnd + 4);

      if (!headers.startsWith('HTTP/1.1 101')) {
        console.error(`[voice] ElevenLabs upgrade failed for ${session.sid}: ${headers.split('\r\n')[0]}`);
        sendBrowserText(session, JSON.stringify({
          type: 'error',
          error: 'ElevenLabs connection failed: ' + headers.split('\r\n')[0],
        }));
        closeSession(session, 'upstream upgrade failed');
        return;
      }

      handshakeComplete = true;
      console.log(`[voice] ElevenLabs upstream connected for ${session.sid}`);
    }

    // Parse server frames (unmasked — server-to-client)
    while (upBuffer.length >= 2) {
      const frame = parseServerFrame(upBuffer);
      if (!frame) break;
      upBuffer = upBuffer.subarray(frame.totalLength);
      handleUpstreamFrame(session, frame.opcode, frame.payload);
    }
  });

  tlsSocket.on('close', () => {
    if (!session.closed) {
      closeSession(session, 'upstream disconnected');
    }
  });
  tlsSocket.on('error', (err) => {
    console.error(`[voice] Upstream error for ${session.sid}:`, err.message);
    if (!session.closed) {
      sendBrowserText(session, JSON.stringify({
        type: 'error',
        error: 'ElevenLabs connection error',
      }));
      closeSession(session, 'upstream error');
    }
  });
}

function handleUpstreamFrame(session: VoiceSession, opcode: number, payload: Buffer): void {
  if (session.closed) return;

  switch (opcode) {
    case OP_TEXT: {
      // ElevenLabs sends JSON transcript messages — relay to browser
      const text = payload.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        const msgType = msg.message_type;

        if (msgType === 'partial_transcript') {
          sendBrowserText(session, JSON.stringify({
            type: 'partial',
            text: msg.text ?? '',
          }));
        } else if (msgType === 'committed_transcript' || msgType === 'committed_transcript_with_timestamps') {
          sendBrowserText(session, JSON.stringify({
            type: 'committed',
            text: msg.text ?? '',
          }));
        } else if (msgType === 'session_started') {
          sendBrowserText(session, JSON.stringify({ type: 'ready' }));
        } else if (msgType?.endsWith('_error') || msgType === 'error') {
          sendBrowserText(session, JSON.stringify({
            type: 'error',
            error: msg.error ?? msgType,
          }));
        }
      } catch {
        // Ignore malformed upstream messages
      }
      break;
    }
    case OP_PING:
      // Respond with pong to keep upstream alive
      sendUpstreamFrame(session, OP_PONG, payload);
      break;
    case OP_CLOSE:
      closeSession(session, 'upstream close frame');
      break;
  }
}

// ── Frame Encoding/Decoding ──

/** Parse a masked frame from browser (client-to-server per RFC 6455). */
function parseClientFrame(buf: Buffer): { opcode: number; payload: Buffer; totalLength: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0F;
  const masked = (buf[1]! & 0x80) !== 0;
  let payloadLen = buf[1]! & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (!masked) return null; // Client frames must be masked
  const totalLength = offset + 4 + payloadLen;
  if (buf.length < totalLength) return null;

  const mask = buf.subarray(offset, offset + 4);
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    payload[i] = buf[offset + 4 + i]! ^ mask[i % 4]!;
  }
  return { opcode, payload, totalLength };
}

/** Parse an unmasked frame from server (server-to-client). */
function parseServerFrame(buf: Buffer): { opcode: number; payload: Buffer; totalLength: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0F;
  let payloadLen = buf[1]! & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const totalLength = offset + payloadLen;
  if (buf.length < totalLength) return null;

  const payload = buf.subarray(offset, offset + payloadLen);
  return { opcode, payload: Buffer.from(payload), totalLength };
}

/** Encode a frame to send to the browser (unmasked, server-to-client). */
function encodeSendFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Encode a masked frame to send upstream (client-to-server). */
function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len; // Set mask bit
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  // Generate random mask key
  const mask = Buffer.alloc(4);
  mask[0] = Math.floor(Math.random() * 256);
  mask[1] = Math.floor(Math.random() * 256);
  mask[2] = Math.floor(Math.random() * 256);
  mask[3] = Math.floor(Math.random() * 256);

  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i]! ^ mask[i % 4]!;
  }

  return Buffer.concat([header, mask, masked]);
}

function sendBrowserText(session: VoiceSession, text: string): void {
  sendBrowserFrame(session, OP_TEXT, Buffer.from(text, 'utf-8'));
}

function sendBrowserFrame(session: VoiceSession, opcode: number, payload: Buffer): void {
  if (session.browser.writable && !session.closed) {
    session.browser.write(encodeSendFrame(opcode, payload));
  }
}

function sendUpstreamText(session: VoiceSession, text: string): void {
  sendUpstreamFrame(session, OP_TEXT, Buffer.from(text, 'utf-8'));
}

function sendUpstreamFrame(session: VoiceSession, opcode: number, payload: Buffer): void {
  if (session.upstream?.writable && !session.closed) {
    session.upstream.write(encodeMaskedFrame(opcode, payload));
  }
}

function closeSession(session: VoiceSession, reason: string): void {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session.sid);
  console.log(`[voice] Session ${session.sid} closed: ${reason}`);

  try { session.upstream?.destroy(); } catch { /* best effort */ }
  try {
    session.browser.write(encodeSendFrame(OP_CLOSE, Buffer.alloc(0)));
    session.browser.destroy();
  } catch { /* best effort */ }
}

/** Get active session count (for diagnostics). */
export function voiceSessionCount(): number {
  return sessions.size;
}
