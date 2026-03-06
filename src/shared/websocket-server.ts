/**
 * Zero-dependency WebSocket server implementing RFC 6455.
 * Supports text frames, ping/pong, close handshake, broadcast.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1_048_576; // 1 MB — reject frames larger than this

// Opcodes
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;

export type WsClient = {
  id: string;
  socket: Duplex;
  alive: boolean;
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
  handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): boolean {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return false;
    }

    const accept = createHash('sha1')
      .update(key + MAGIC_STRING)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );

    const client: WsClient = {
      id: `ws-${this.nextId++}`,
      socket,
      alive: true,
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
        this.handleFrame(client, result.opcode, result.payload);
      }
    });

    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));

    // Start ping interval on first connection
    if (!this.pingInterval) {
      this.pingInterval = setInterval(() => {
        for (const c of this.clients.values()) {
          if (!c.alive) {
            this.removeClient(c);
            continue;
          }
          c.alive = false;
          this.sendPing(c);
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
    if (client.socket.writable) {
      const frame = this.encodeFrame(OPCODE_TEXT, Buffer.from(data, 'utf-8'));
      client.socket.write(frame);
    }
  }

  /**
   * Broadcast a text message to all connected clients.
   */
  broadcast(data: string): void {
    const frame = this.encodeFrame(OPCODE_TEXT, Buffer.from(data, 'utf-8'));
    for (const client of this.clients.values()) {
      if (client.socket.writable) {
        client.socket.write(frame);
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

  private parseFrame(buffer: Buffer): { opcode: number; payload: Buffer; totalLength: number } | null {
    if (buffer.length < 2) return null;

    const firstByte = buffer[0]!;
    const secondByte = buffer[1]!;

    const opcode = firstByte & 0x0F;
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

    return { opcode, payload, totalLength };
  }

  private handleFrame(client: WsClient, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OPCODE_TEXT:
        client.alive = true;
        this.onMessageCb?.(client, payload.toString('utf-8'));
        break;

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

  private encodeFrame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    let headerLength: number;
    let header: Buffer;

    if (length < 126) {
      headerLength = 2;
      header = Buffer.alloc(headerLength);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = length;
    } else if (length < 65536) {
      headerLength = 4;
      header = Buffer.alloc(headerLength);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      headerLength = 10;
      header = Buffer.alloc(headerLength);
      header[0] = 0x80 | opcode;
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
