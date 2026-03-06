import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, sleep } from './utils.ts';

describe('shellQuote', () => {
  it('wraps simple strings in single quotes', () => {
    assert.equal(shellQuote('hello'), "'hello'");
  });

  it('handles empty string', () => {
    assert.equal(shellQuote(''), "''");
  });

  it('escapes single quotes', () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  it('handles multiple single quotes', () => {
    assert.equal(shellQuote("a'b'c"), "'a'\\''b'\\''c'");
  });

  it('preserves spaces and special chars inside quotes', () => {
    assert.equal(shellQuote('hello world $HOME'), "'hello world $HOME'");
  });

  it('handles semicolons and pipes safely', () => {
    const quoted = shellQuote('foo; rm -rf /');
    assert.equal(quoted, "'foo; rm -rf /'");
  });
});

describe('sleep', () => {
  it('resolves after delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >=40ms, got ${elapsed}ms`);
  });
});
