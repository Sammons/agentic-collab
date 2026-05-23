/**
 * permessage-deflate (RFC 7692) — minimal implementation.
 *
 * We use `server_no_context_takeover; client_no_context_takeover` exclusively
 * so each frame is compressed/decompressed with a fresh raw-deflate context.
 * This avoids the bookkeeping a sliding-window LZ77 would need across frames
 * at a small compression-ratio cost. JSON broadcasts still compress ~10x.
 *
 * RFC 7692 framing: the compressed payload of a permessage-deflate message
 * has the trailing bytes `0x00 0x00 0xff 0xff` (the empty deflate block)
 * stripped on send; the receiver appends them back before inflate.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

export type DeflateNegotiation = {
  /** Echo back to client in Sec-WebSocket-Extensions response header. */
  responseHeader: string;
};

/**
 * Inspect the client's `Sec-WebSocket-Extensions` header. Returns a
 * negotiation object if permessage-deflate was offered, else null. We accept
 * the offer with no_context_takeover on both sides.
 */
export function negotiate(extHeader: string | undefined): DeflateNegotiation | null {
  if (!extHeader) return null;
  // Header is a comma-separated list of offers, each `extension; param=val; …`.
  const offers = extHeader.split(',').map((s) => s.trim());
  for (const offer of offers) {
    const [name] = offer.split(';').map((s) => s.trim());
    if (name === 'permessage-deflate') {
      return {
        responseHeader: 'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      };
    }
  }
  return null;
}

/**
 * Compress an outgoing text/binary payload. Returns the compressed bytes
 * with the RFC 7692 tail stripped — the caller sets RSV1 in the frame
 * header to signal compression to the peer.
 *
 * If compression doesn't shrink the payload (already-compressed data,
 * tiny strings), the caller should fall back to uncompressed.
 */
export function compressFrame(payload: Buffer): Buffer {
  const compressed = deflateRawSync(payload, { level: 6 });
  // The trailing empty block 00 00 ff ff is always present with raw-deflate
  // flush; strip it per RFC 7692 §7.2.1.
  if (
    compressed.length >= 4 &&
    compressed[compressed.length - 4] === 0x00 &&
    compressed[compressed.length - 3] === 0x00 &&
    compressed[compressed.length - 2] === 0xff &&
    compressed[compressed.length - 1] === 0xff
  ) {
    return compressed.subarray(0, compressed.length - 4);
  }
  return compressed;
}

/**
 * Decompress a payload received with RSV1=1. The caller must have first
 * verified the frame's RSV1 bit was set; otherwise the bytes are raw.
 */
export function decompressFrame(payload: Buffer): Buffer {
  const withTail = Buffer.concat([payload, TAIL]);
  return inflateRawSync(withTail);
}
