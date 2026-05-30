import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setFrontmatterProxy } from './util.ts';

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
