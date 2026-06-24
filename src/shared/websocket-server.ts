/**
 * Zero-dependency WebSocket server implementing RFC 6455.
 * Supports text frames, ping/pong, close handshake, broadcast.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WsEvent } from './types.ts';
import { negotiate as negotiateDeflate, compressFrame, decompressFrame } from './ws-deflate.ts';

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1_048_576; // 1 MB — reject frames larger than this
// Don't compress messages smaller than this — the deflate overhead would
// usually grow the payload, and small chat events don't matter anyway.
const COMPRESS_THRESHOLD = 256;

// Opcodes
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;

export type SubscriptionMode = 'all' | 'include' | 'exclude';

export type Subscription = {
  mode: SubscriptionMode;
  agents: Set<string>;
};

export type WsClient = {
  id: string;
  socket: Duplex;
  alive: boolean;
  /** Negotiated permessage-deflate; outbound payloads ≥ threshold compress. */
  compress: boolean;
  /** Per-connection attributes the caller stashed at handshake time. */
  attrs: Record<string, unknown>;
  /** Subscription filter for message delivery. Default is 'all'. */
  subscription: Subscription;
};

export class WebSocketServer {
  private clients = new Map<string, WsClient>();
  private nextId = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private onMessageCb: ((client: WsClient, data: string) => void) | null = null;
  private onConnectCb: ((client: WsClient) => void) | null = null;
  private onDisconnectCb: ((client: WsClient) => void) | null = null;

  constructor() {
    // Ping interval deferred to first connection (avoid resource leak if unused)
  }

  onMessage(cb: (client: WsClient, data: string) => void): void {
    this.onMessageCb = cb;
  }

  onConnect(cb: (client: WsClient) => void): void {
    this.onConnectCb = cb;
  }

  onDisconnect(cb: (client: WsClient) => void): void {
    this.onDisconnectCb = cb;
  }

  /**
   * Handle an HTTP upgrade request. Call this from the server's 'upgrade' event.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer, attrs: Record<string, unknown> = {}): boolean {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return false;
    }

    const accept = createHash('sha1')
      .update(key + MAGIC_STRING)
      .digest('base64');

    // Negotiate permessage-deflate if the client offered it. Browsers all do.
    const offered = req.headers['sec-websocket-extensions'];
    const offeredStr = Array.isArray(offered) ? offered.join(', ') : offered;
    const deflate = negotiateDeflate(offeredStr);

    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (deflate) lines.push(`Sec-WebSocket-Extensions: ${deflate.responseHeader}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');

    const client: WsClient = {
      id: `ws-${this.nextId++}`,
      socket,
      alive: true,
      compress: !!deflate,
      attrs,
      subscription: { mode: 'all', agents: new Set() },
    };

    this.clients.set(client.id, client);

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Guard against unbounded buffer accumulation (C-2)
      if (buffer.length > MAX_FRAME_BYTES) {
        this.removeClient(client);
        return;
      }

      while (buffer.length >= 2) {
        const result = this.parseFrame(buffer);
        if (!result) break; // Need more data

        buffer = buffer.subarray(result.totalLength);
        this.handleFrame(client, result.opcode, result.payload, result.compressed);
      }
    });

    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));

    // Start ping interval on first connection
    if (!this.pingInterval) {
      this.pingInterval = setInterval(() => {
        for (const c of this.clients.values()) {
          try {
            if (!c.alive) {
              this.removeClient(c);
              continue;
            }
            c.alive = false;
            this.sendPing(c);
          } catch (err) {
            console.warn('[ws] Ping failed, removing client:', (err as Error).message);
            this.removeClient(c);
          }
        }
      }, 30_000);
    }

    this.onConnectCb?.(client);

    return true;
  }

  /**
   * Send a text message to a specific client.
   */
  send(client: WsClient, data: string): void {
    if (!client.socket.writable) return;
    client.socket.write(this.frameForClient(client, data));
  }

  /**
   * Broadcast a text message to all connected clients. Caches a single
   * uncompressed frame for legacy clients and lazily compresses per-message
   * for permessage-deflate clients (separate per-client deflate context).
   */
  broadcast(data: string): void {
    const raw = Buffer.from(data, 'utf-8');
    let uncompressedFrame: Buffer | null = null;
    let compressedFrame: Buffer | null = null;
    const wantsCompress = raw.length >= COMPRESS_THRESHOLD;
    for (const client of this.clients.values()) {
      if (!client.socket.writable) continue;
      if (client.compress && wantsCompress) {
        if (compressedFrame === null) {
          compressedFrame = this.encodeFrame(OPCODE_TEXT, compressFrame(raw), true);
        }
        client.socket.write(compressedFrame);
      } else {
        if (uncompressedFrame === null) {
          uncompressedFrame = this.encodeFrame(OPCODE_TEXT, raw, false);
        }
        client.socket.write(uncompressedFrame);
      }
    }
  }

  private frameForClient(client: WsClient, data: string): Buffer {
    const raw = Buffer.from(data, 'utf-8');
    if (client.compress && raw.length >= COMPRESS_THRESHOLD) {
      return this.encodeFrame(OPCODE_TEXT, compressFrame(raw), true);
    }
    return this.encodeFrame(OPCODE_TEXT, raw, false);
  }

  /**
   * Typed convenience wrapper around `broadcast`. Constrains the event payload
   * structure to the `WsEvent` union rather than constructed ad-hoc.
   */
  broadcastEvent(event: WsEvent): void {
    this.broadcast(JSON.stringify(event));
  }

  /**
   * Update a client's subscription filter.
   */
  setSubscription(client: WsClient, mode: SubscriptionMode, agents: string[]): void {
    client.subscription = { mode, agents: new Set(agents) };
    // Send confirmation
    this.send(client, JSON.stringify({
      type: 'subscribed',
      mode,
      agents,
    }));
  }

  /**
   * Check if a message should be delivered to a client based on subscription.
   */
  shouldDeliver(client: WsClient, agent: string | null): boolean {
    const sub = client.subscription;
    if (sub.mode === 'all') return true;
    if (!agent) return true; // System messages always delivered
    if (sub.mode === 'include') return sub.agents.has(agent);
    if (sub.mode === 'exclude') return !sub.agents.has(agent);
    return true;
  }

  /**
   * Broadcast a message only to clients subscribed to the given agent.
   * Used for dashboard messages that should respect focus mode.
   */
  broadcastFiltered(data: string, agent: string | null): void {
    const raw = Buffer.from(data, 'utf-8');
    let uncompressedFrame: Buffer | null = null;
    let compressedFrame: Buffer | null = null;
    const wantsCompress = raw.length >= COMPRESS_THRESHOLD;
    for (const client of this.clients.values()) {
      if (!client.socket.writable) continue;
      if (!this.shouldDeliver(client, agent)) continue;
      if (client.compress && wantsCompress) {
        if (compressedFrame === null) {
          compressedFrame = this.encodeFrame(OPCODE_TEXT, compressFrame(raw), true);
        }
        client.socket.write(compressedFrame);
      } else {
        if (uncompressedFrame === null) {
          uncompressedFrame = this.encodeFrame(OPCODE_TEXT, raw, false);
        }
        client.socket.write(uncompressedFrame);
      }
    }
  }

  /**
   * Get count of connected clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all connections and stop ping interval.
   */
  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const client of this.clients.values()) {
      this.sendClose(client);
      client.socket.destroy();
    }
    this.clients.clear();
  }

  // ── Private ──

  private parseFrame(buffer: Buffer): { opcode: number; payload: Buffer; totalLength: number; compressed: boolean } | null {
    if (buffer.length < 2) return null;

    const firstByte = buffer[0]!;
    const secondByte = buffer[1]!;

    const opcode = firstByte & 0x0F;
    const compressed = (firstByte & 0x40) !== 0; // RSV1 bit = permessage-deflate
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < 4) return null;
      payloadLength = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buffer.length < 10) return null;
      // For simplicity, use Number (supports up to ~9PB which is fine)
      payloadLength = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    // RFC 6455 §5.1: client frames MUST be masked
    if (!masked) return null;

    const maskLength = 4;
    const totalLength = offset + maskLength + payloadLength;

    if (buffer.length < totalLength) return null;

    const maskKey = buffer.subarray(offset, offset + 4);
    const payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = buffer[offset + 4 + i]! ^ maskKey[i % 4]!;
    }

    return { opcode, payload, totalLength, compressed };
  }

  private handleFrame(client: WsClient, opcode: number, payload: Buffer, compressed: boolean): void {
    switch (opcode) {
      case OPCODE_TEXT: {
        client.alive = true;
        let text: string;
        if (compressed) {
          try {
            text = decompressFrame(payload).toString('utf-8');
          } catch (err) {
            console.warn('[ws] inflate failed, dropping frame:', (err as Error).message);
            return;
          }
        } else {
          text = payload.toString('utf-8');
        }
        this.onMessageCb?.(client, text);
        break;
      }

      case OPCODE_PING:
        client.alive = true;
        this.sendPong(client, payload);
        break;

      case OPCODE_PONG:
        client.alive = true;
        break;

      case OPCODE_CLOSE:
        this.sendClose(client);
        this.removeClient(client);
        break;

      case OPCODE_BINARY:
      case OPCODE_CONTINUATION:
        // Not supported for this use case
        break;
    }
  }

  private encodeFrame(opcode: number, payload: Buffer, rsv1: boolean = false): Buffer {
    const length = payload.length;
    let headerLength: number;
    let header: Buffer;
    // FIN (0x80) + RSV1 (0x40 if permessage-deflate) + opcode (low nibble).
    const firstByte = 0x80 | (rsv1 ? 0x40 : 0x00) | opcode;

    if (length < 126) {
      headerLength = 2;
      header = Buffer.alloc(headerLength);
      header[0] = firstByte;
      header[1] = length;
    } else if (length < 65536) {
      headerLength = 4;
      header = Buffer.alloc(headerLength);
      header[0] = firstByte;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      headerLength = 10;
      header = Buffer.alloc(headerLength);
      header[0] = firstByte;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, payload]);
  }

  private sendPing(client: WsClient): void {
    if (client.socket.writable) {
      const frame = this.encodeFrame(OPCODE_PING, Buffer.alloc(0));
      client.socket.write(frame);
    }
  }

  private sendPong(client: WsClient, payload: Buffer): void {
    if (client.socket.writable) {
      const frame = this.encodeFrame(OPCODE_PONG, payload);
      client.socket.write(frame);
    }
  }

  private sendClose(client: WsClient): void {
    if (client.socket.writable) {
      const frame = this.encodeFrame(OPCODE_CLOSE, Buffer.alloc(0));
      client.socket.write(frame);
    }
  }

  private removeClient(client: WsClient): void {
    if (this.clients.has(client.id)) {
      this.clients.delete(client.id);
      this.onDisconnectCb?.(client);
      client.socket.destroy();
    }
  }
}
