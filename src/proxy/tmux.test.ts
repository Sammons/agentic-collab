import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendKeys } from './tmux.ts';

describe('tmux sendKeys validation', () => {
  it('rejects keys with shell metacharacters', () => {
    assert.throws(() => sendKeys('test-session', '$(whoami)'), /Invalid keys/);
  });

  it('rejects keys with backticks', () => {
    assert.throws(() => sendKeys('test-session', '`id`'), /Invalid keys/);
  });

  it('rejects keys with semicolons', () => {
    assert.throws(() => sendKeys('test-session', 'Enter; rm -rf /'), /Invalid keys/);
  });

  it('rejects keys with pipes', () => {
    assert.throws(() => sendKeys('test-session', 'Enter | cat /etc/passwd'), /Invalid keys/);
  });

  it('rejects keys with newlines', () => {
    assert.throws(() => sendKeys('test-session', 'Enter\nrm -rf /'), /Invalid keys/);
  });

  it('rejects invalid session names', () => {
    assert.throws(() => sendKeys("bad'name", 'Escape'), /Invalid session name/);
  });

  it('rejects session names with shell injection', () => {
    assert.throws(() => sendKeys('$(whoami)', 'Escape'), /Invalid session name/);
  });

  // Valid keys would succeed validation but fail on tmux exec (no tmux in test).
  // We verify they pass validation by checking the error is from tmux, not from our validation.
  it('accepts valid key names (Escape, Enter, C-c pattern)', () => {
    // These pass validation but fail on tmux execution — that's expected
    try {
      sendKeys('test-session', 'Escape Escape Escape');
    } catch (err) {
      // Should fail with "tmux command failed" not "Invalid keys"
      assert.ok((err as Error).message.includes('tmux command failed'),
        `Expected tmux error, got: ${(err as Error).message}`);
    }
  });

  it('accepts C-c style keys', () => {
    try {
      sendKeys('test-session', 'C-c');
    } catch (err) {
      assert.ok((err as Error).message.includes('tmux command failed'),
        `Expected tmux error, got: ${(err as Error).message}`);
    }
  });
});
