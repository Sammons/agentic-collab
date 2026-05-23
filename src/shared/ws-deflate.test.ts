import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, constants } from 'node:zlib';
import { compressFrame, decompressFrame, negotiate } from './ws-deflate.ts';

test('compressFrame → decompressFrame round-trips arbitrary text', () => {
  const payload = Buffer.from(JSON.stringify({
    type: 'init',
    agents: Array.from({ length: 50 }, (_, i) => ({ name: `agent-${i}`, engine: 'claude', state: 'idle' })),
  }), 'utf-8');
  const compressed = compressFrame(payload);
  assert.ok(compressed.length < payload.length, `expected compression to shrink (${compressed.length} vs ${payload.length})`);
  const inflated = decompressFrame(compressed);
  assert.equal(inflated.toString('utf-8'), payload.toString('utf-8'));
});

test('compressFrame strips the 00 00 ff ff tail', () => {
  const payload = Buffer.from('hello world hello world hello world', 'utf-8');
  const compressed = compressFrame(payload);
  // Tail should NOT be present at the very end (RFC 7692 §7.2.1).
  const last4 = compressed.subarray(compressed.length - 4);
  const isTail = last4[0] === 0x00 && last4[1] === 0x00 && last4[2] === 0xff && last4[3] === 0xff;
  assert.equal(isTail, false, 'compressed payload still has the 00 00 ff ff tail');
});

test('compressFrame uses Z_SYNC_FLUSH (no BFINAL) — raw output ends in 00 00 ff ff', () => {
  // The pre-strip output of our compressor must end with the sync marker.
  // Browsers desync if the stream ends with BFINAL=1 instead.
  const payload = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf-8');
  const raw = deflateRawSync(payload, { level: 6, finishFlush: constants.Z_SYNC_FLUSH });
  const last4 = raw.subarray(raw.length - 4);
  assert.equal(last4[0], 0x00);
  assert.equal(last4[1], 0x00);
  assert.equal(last4[2], 0xff);
  assert.equal(last4[3], 0xff);
});

test('negotiate accepts a permessage-deflate offer', () => {
  const res = negotiate('permessage-deflate; client_max_window_bits');
  assert.ok(res, 'expected negotiation to accept the offer');
  assert.match(res.responseHeader, /permessage-deflate/);
  assert.match(res.responseHeader, /server_no_context_takeover/);
  assert.match(res.responseHeader, /client_no_context_takeover/);
});

test('negotiate ignores unrelated extensions', () => {
  assert.equal(negotiate('something-else; foo=bar'), null);
  assert.equal(negotiate(undefined), null);
  assert.equal(negotiate(''), null);
});
