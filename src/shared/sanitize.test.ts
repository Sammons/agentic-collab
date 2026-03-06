import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMessage, generateMessageId, generateToken } from './sanitize.ts';

describe('sanitizeMessage', () => {
  it('passes through clean text', () => {
    assert.equal(sanitizeMessage('Hello world'), 'Hello world');
  });

  it('preserves newlines and tabs', () => {
    assert.equal(sanitizeMessage('line1\nline2\ttab'), 'line1\nline2\ttab');
  });

  it('strips null bytes', () => {
    assert.equal(sanitizeMessage('hello\x00world'), 'helloworld');
  });

  it('strips C0 control characters except newline and tab', () => {
    assert.equal(sanitizeMessage('a\x01b\x02c\x03d'), 'abcd');
    assert.equal(sanitizeMessage('a\x0Ab'), 'a\nb'); // newline preserved
    assert.equal(sanitizeMessage('a\x09b'), 'a\tb'); // tab preserved
  });

  it('strips C1 control characters (0x7F-0x9F)', () => {
    assert.equal(sanitizeMessage('a\x7Fb'), 'ab');
    assert.equal(sanitizeMessage('a\x80b\x9Fc'), 'abc');
  });

  it('strips ANSI CSI sequences', () => {
    assert.equal(sanitizeMessage('\x1B[31mred\x1B[0m'), 'red');
    assert.equal(sanitizeMessage('\x1B[1;32;40mgreen\x1B[0m'), 'green');
  });

  it('strips OSC sequences', () => {
    assert.equal(sanitizeMessage('\x1B]0;title\x07text'), 'text');
  });

  it('strips other ESC sequences', () => {
    assert.equal(sanitizeMessage('\x1BM\x1BDtext'), 'text');
  });

  it('truncates to 16KB', () => {
    const long = 'x'.repeat(20_000);
    const result = sanitizeMessage(long);
    assert.equal(result.length, 16 * 1024);
  });

  it('handles empty string', () => {
    assert.equal(sanitizeMessage(''), '');
  });

  it('handles mixed dangerous content', () => {
    const input = '\x1B[31m\x00alert\x7F\x1B]0;pwned\x07 safe text\x01\x02';
    const result = sanitizeMessage(input);
    assert.equal(result, 'alert safe text');
  });
});

describe('generateMessageId', () => {
  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMessageId());
    }
    assert.equal(ids.size, 100);
  });

  it('starts with msg- prefix', () => {
    const id = generateMessageId();
    assert.ok(id.startsWith('msg-'));
  });

  it('has reasonable length', () => {
    const id = generateMessageId();
    assert.ok(id.length >= 12);
    assert.ok(id.length <= 20);
  });
});

describe('generateToken', () => {
  it('generates 64-char hex tokens', () => {
    const token = generateToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it('generates unique tokens', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
  });
});
