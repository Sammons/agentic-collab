import { test } from 'node:test';
import assert from 'node:assert/strict';
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
