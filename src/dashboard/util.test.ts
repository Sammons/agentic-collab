import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFrontmatterProxy, proxyOnline, setFrontmatterTelegram, parseFrontmatterTelegram, isValidTelegramChatId } from './util.ts';

describe('setFrontmatterProxy', () => {
  it('replaces an existing top-level proxy: line', () => {
    const out = setFrontmatterProxy('engine: claude\nproxy: old-proxy\ncwd: /tmp', 'new-proxy');
    assert.match(out, /^proxy: new-proxy$/m);
    assert.doesNotMatch(out, /old-proxy/);
    assert.match(out, /^engine: claude$/m);
    assert.match(out, /^cwd: \/tmp$/m);
  });

  it('appends proxy: when none is present', () => {
    const out = setFrontmatterProxy('engine: claude\ncwd: /tmp', 'p1');
    assert.equal(out, 'engine: claude\ncwd: /tmp\nproxy: p1');
  });

  it('removes the proxy: line when value is empty', () => {
    const out = setFrontmatterProxy('engine: claude\nproxy: p1\ncwd: /tmp', '');
    assert.doesNotMatch(out, /^proxy:/m);
    assert.match(out, /^engine: claude$/m);
    assert.match(out, /^cwd: \/tmp$/m);
  });

  it('leaves indented/nested proxy keys untouched', () => {
    const out = setFrontmatterProxy('env:\n  proxy: inner\nengine: claude', 'top');
    assert.match(out, /^ {2}proxy: inner$/m); // nested one preserved
    assert.match(out, /^proxy: top$/m);       // new top-level one added
  });

  it('does not match lookalike keys like proxyId:', () => {
    const out = setFrontmatterProxy('proxyId: keep-me\nengine: claude', 'p');
    assert.match(out, /^proxyId: keep-me$/m);
    assert.match(out, /^proxy: p$/m);
  });

  it('handles empty input', () => {
    assert.equal(setFrontmatterProxy('', 'p'), 'proxy: p');
    assert.equal(setFrontmatterProxy('', ''), '');
  });

  it('does not leave a dangling blank line before an appended proxy', () => {
    const out = setFrontmatterProxy('engine: claude\n', 'p1');
    assert.equal(out, 'engine: claude\nproxy: p1');
  });
});

describe('proxyOnline', () => {
  const now = new Date('2026-06-07T12:00:00.000Z').getTime();

  it('is online when the heartbeat is within the stale window', () => {
    const hb = new Date(now - 10_000).toISOString(); // 10s ago
    assert.equal(proxyOnline(hb, now), true);
  });

  it('is offline once the heartbeat exceeds the default 45s window', () => {
    const hb = new Date(now - 46_000).toISOString(); // 46s ago
    assert.equal(proxyOnline(hb, now), false);
  });

  it('treats exactly the stale boundary as online', () => {
    const hb = new Date(now - 45_000).toISOString(); // 45s ago, inclusive
    assert.equal(proxyOnline(hb, now), true);
  });

  it('honors a custom stale window', () => {
    const hb = new Date(now - 20_000).toISOString(); // 20s ago
    assert.equal(proxyOnline(hb, now, 15), false);
    assert.equal(proxyOnline(hb, now, 30), true);
  });

  it('counts an unparseable timestamp as offline', () => {
    assert.equal(proxyOnline('not-a-date', now), false);
    assert.equal(proxyOnline('', now), false);
  });

  it('counts a future heartbeat as online (clock skew tolerance)', () => {
    const hb = new Date(now + 5_000).toISOString(); // 5s in the future
    assert.equal(proxyOnline(hb, now), true);
  });
});

describe('setFrontmatterTelegram / parseFrontmatterTelegram', () => {
  const cfg = { chatId: '-100123', inbound: true, routing: 'self' as const };

  it('appends a telegram block when none is present', () => {
    const out = setFrontmatterTelegram('engine: claude', cfg);
    assert.equal(out, 'engine: claude\ntelegram:\n  chatId: "-100123"\n  inbound: true\n  routing: self');
  });

  it('round-trips through parse', () => {
    const out = setFrontmatterTelegram('engine: claude', { chatId: '-100', inbound: false, routing: 'prefix' });
    assert.deepEqual(parseFrontmatterTelegram(out), { chatId: '-100', inbound: false, routing: 'prefix' });
  });

  it('replaces an existing telegram block (header + children) in place', () => {
    const raw = 'engine: claude\ntelegram:\n  chatId: "-1"\n  inbound: false\n  routing: prefix\ncwd: /tmp';
    const out = setFrontmatterTelegram(raw, { chatId: '-2', inbound: true, routing: 'passthrough' });
    // The old block is gone; cwd (a sibling top-level key) survives.
    assert.match(out, /^cwd: \/tmp$/m);
    assert.doesNotMatch(out, /routing: prefix/);
    assert.deepEqual(parseFrontmatterTelegram(out), { chatId: '-2', inbound: true, routing: 'passthrough' });
  });

  it('removes the telegram block when cfg is null', () => {
    const raw = 'engine: claude\ntelegram:\n  chatId: "-1"\n  inbound: true\n  routing: self\ncwd: /tmp';
    const out = setFrontmatterTelegram(raw, null);
    assert.doesNotMatch(out, /telegram:/);
    assert.doesNotMatch(out, /chatId/);
    assert.match(out, /^engine: claude$/m);
    assert.match(out, /^cwd: \/tmp$/m);
  });

  it('removes the telegram block when chatId is empty', () => {
    const raw = 'telegram:\n  chatId: "-1"\n  inbound: true\n  routing: self';
    const out = setFrontmatterTelegram(raw, { chatId: '   ', inbound: true, routing: 'self' });
    assert.equal(out, '');
  });

  it('leaves other nested blocks (env) untouched', () => {
    const raw = 'env:\n  FOO: bar\ntelegram:\n  chatId: "-1"\n  inbound: true\n  routing: self';
    const out = setFrontmatterTelegram(raw, { chatId: '-9', inbound: true, routing: 'self' });
    assert.match(out, /^env:$/m);
    assert.match(out, /^ {2}FOO: bar$/m);
    assert.deepEqual(parseFrontmatterTelegram(out), { chatId: '-9', inbound: true, routing: 'self' });
  });

  it('parseFrontmatterTelegram returns null when there is no block', () => {
    assert.equal(parseFrontmatterTelegram('engine: claude\ncwd: /tmp'), null);
  });

  it('parse defaults inbound to true and routing to self for partial/invalid blocks', () => {
    const raw = 'telegram:\n  chatId: -5\n  routing: bogus';
    assert.deepEqual(parseFrontmatterTelegram(raw), { chatId: '-5', inbound: true, routing: 'self' });
  });

  it('parse strips single and double quotes from values', () => {
    const raw = "telegram:\n  chatId: '-77'\n  inbound: true\n  routing: prefix";
    assert.deepEqual(parseFrontmatterTelegram(raw), { chatId: '-77', inbound: true, routing: 'prefix' });
  });

  it('does not match a telegram-prefixed lookalike key', () => {
    const raw = 'telegramFoo: bar\nengine: claude';
    assert.equal(parseFrontmatterTelegram(raw), null);
    // setFrontmatterTelegram(null) must leave the lookalike alone.
    assert.match(setFrontmatterTelegram(raw, null), /^telegramFoo: bar$/m);
  });

  // ── chatId frontmatter-injection backstop (RFC-008 PR-E review fix) ──────────
  it('refuses to emit a block for a chatId carrying an embedded double-quote', () => {
    // A chatId that closes the quoted scalar and opens a new top-level key would,
    // without the backstop, write an injectable line. The block must be dropped.
    const inject = { chatId: '-1"\nisAdmin: true\nx: "', inbound: true, routing: 'self' as const };
    const out = setFrontmatterTelegram('engine: claude', inject);
    assert.equal(out, 'engine: claude');           // no block emitted at all
    assert.doesNotMatch(out, /telegram:/);
    assert.doesNotMatch(out, /isAdmin/);            // the injected key never lands
    assert.equal(parseFrontmatterTelegram(out), null);
  });

  it('refuses to emit a block for a chatId carrying an embedded newline', () => {
    const inject = { chatId: '-1\nrootKey: pwned', inbound: true, routing: 'prefix' as const };
    const out = setFrontmatterTelegram('engine: claude', inject);
    assert.equal(out, 'engine: claude');
    assert.doesNotMatch(out, /rootKey/);
  });

  it('round-trips a valid numeric chatId cleanly', () => {
    const out = setFrontmatterTelegram('engine: claude', { chatId: '-1001234567890', inbound: true, routing: 'self' });
    assert.deepEqual(parseFrontmatterTelegram(out), { chatId: '-1001234567890', inbound: true, routing: 'self' });
  });

  it('round-trips a valid @channelusername chatId cleanly', () => {
    const out = setFrontmatterTelegram('engine: claude', { chatId: '@my_channel_01', inbound: false, routing: 'passthrough' });
    assert.match(out, /^ {2}chatId: "@my_channel_01"$/m);
    assert.deepEqual(parseFrontmatterTelegram(out), { chatId: '@my_channel_01', inbound: false, routing: 'passthrough' });
  });
});

describe('isValidTelegramChatId', () => {
  it('accepts a numeric id (positive and negative)', () => {
    assert.equal(isValidTelegramChatId('12345'), true);
    assert.equal(isValidTelegramChatId('-1001234567890'), true);
  });

  it('accepts an @channelusername (alphanumeric + underscore)', () => {
    assert.equal(isValidTelegramChatId('@my_channel'), true);
    assert.equal(isValidTelegramChatId('@Channel_01'), true);
  });

  it('trims surrounding whitespace before validating', () => {
    assert.equal(isValidTelegramChatId('  -100  '), true);
  });

  it('rejects YAML-breaking and otherwise-malformed chatIds', () => {
    assert.equal(isValidTelegramChatId(''), false);
    assert.equal(isValidTelegramChatId('-1"\nisAdmin: true'), false); // embedded quote + newline
    assert.equal(isValidTelegramChatId('-1\nrootKey: x'), false);     // embedded newline
    assert.equal(isValidTelegramChatId('@bad name'), false);          // space in username
    assert.equal(isValidTelegramChatId('@bad-name'), false);          // dash not allowed
    assert.equal(isValidTelegramChatId('foo'), false);                // bare word, no @
    assert.equal(isValidTelegramChatId('12.5'), false);               // not an integer
  });
});
