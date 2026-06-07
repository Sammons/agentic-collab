import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFrontmatterProxy, proxyOnline } from './util.ts';

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
