/**
 * Tests for the RFC-008 secret-crypto helper (AES-256-GCM via node:crypto).
 *
 * The helper derives its key from the orchestrator shared secret resolved by
 * `resolveSecret()` (src/shared/config.ts), which honors ORCHESTRATOR_SECRET.
 * These tests set/restore that env var to control key material — including the
 * "missing secret" case (resolveSecret returns null).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encryptSecret, decryptSecret } from './secret-crypto.ts';

describe('secret-crypto (AES-256-GCM)', () => {
  // Capture/restore the env vars resolveSecret() reads so neither a real
  // ~/.config secret nor a leftover env var leaks into these tests.
  //
  // NOTE: resolveSecret() captures the default config dir at MODULE LOAD time,
  // so AGENTIC_COLLAB_CONFIG_DIR set in a hook can't redirect the default-file
  // lookup. Instead we point ORCHESTRATOR_SECRET_FILE at a non-existent path —
  // that env takes priority over the default file and yields null when absent,
  // guaranteeing the "missing secret" cases don't bleed through to a host secret.
  const savedEnvSecret = process.env['ORCHESTRATOR_SECRET'];
  const savedEnvSecretFile = process.env['ORCHESTRATOR_SECRET_FILE'];
  const MISSING_SECRET_FILE = join(tmpdir(), 'secret-crypto-nonexistent-' + process.pid);

  before(() => {
    process.env['ORCHESTRATOR_SECRET_FILE'] = MISSING_SECRET_FILE;
  });

  after(() => {
    if (savedEnvSecret === undefined) delete process.env['ORCHESTRATOR_SECRET'];
    else process.env['ORCHESTRATOR_SECRET'] = savedEnvSecret;
    if (savedEnvSecretFile === undefined) delete process.env['ORCHESTRATOR_SECRET_FILE'];
    else process.env['ORCHESTRATOR_SECRET_FILE'] = savedEnvSecretFile;
  });

  describe('with a shared secret present', () => {
    beforeEach(() => {
      process.env['ORCHESTRATOR_SECRET'] = 'test-shared-secret-aaaaaaaaaaaa';
    });
    afterEach(() => {
      delete process.env['ORCHESTRATOR_SECRET'];
    });

    it('round-trips: encrypt → decrypt returns the original plaintext', () => {
      const token = '123456789:AAExampleBotTokenABCDEFghijkLMNop';
      const blob = encryptSecret(token);
      assert.ok(blob, 'encryptSecret returned a blob');
      assert.notEqual(blob, token, 'blob is not the plaintext');
      assert.equal(decryptSecret(blob!), token);
    });

    it('round-trips empty and unicode plaintext', () => {
      for (const pt of ['', 'токен-🤖-bot', 'a'.repeat(4096)]) {
        const blob = encryptSecret(pt);
        assert.ok(blob);
        assert.equal(decryptSecret(blob!), pt);
      }
    });

    it('two encryptions of the same plaintext differ (random IV/salt)', () => {
      const token = 'same-token-value';
      const a = encryptSecret(token);
      const b = encryptSecret(token);
      assert.ok(a && b);
      assert.notEqual(a, b, 'ciphertexts must differ (random salt+IV)');
      // ...but both still decrypt to the same plaintext.
      assert.equal(decryptSecret(a!), token);
      assert.equal(decryptSecret(b!), token);
    });

    it('tampered blob (flipped byte) → decryptSecret returns null (GCM auth)', () => {
      const blob = encryptSecret('secret-token')!;
      const buf = Buffer.from(blob, 'base64');
      // Flip a byte deep in the ciphertext region (past salt+iv+tag = 44 bytes).
      const idx = buf.length - 1;
      buf[idx] = buf[idx]! ^ 0xff;
      const tampered = buf.toString('base64');
      assert.equal(decryptSecret(tampered), null);
    });

    it('tampered auth tag → decryptSecret returns null', () => {
      const blob = encryptSecret('secret-token')!;
      const buf = Buffer.from(blob, 'base64');
      // Auth tag lives at bytes 28..44 (salt 16 + iv 12).
      buf[30] = buf[30]! ^ 0xff;
      assert.equal(decryptSecret(buf.toString('base64')), null);
    });

    it('malformed / empty / too-short blob → null', () => {
      assert.equal(decryptSecret(''), null);
      assert.equal(decryptSecret('not-base64-!!!@@@'), null);
      assert.equal(decryptSecret('aGVsbG8='), null); // valid base64 but too short
      assert.equal(decryptSecret('x'), null);
      // @ts-expect-error — defends against non-string callers
      assert.equal(decryptSecret(null), null);
    });

    it('wrong/rotated secret → decryptSecret returns null', () => {
      const blob = encryptSecret('rotate-me')!;
      assert.equal(decryptSecret(blob), 'rotate-me');
      // Rotate the shared secret; the old blob must no longer decrypt.
      process.env['ORCHESTRATOR_SECRET'] = 'a-completely-different-secret';
      assert.equal(decryptSecret(blob), null);
    });

    // RFC-008 PR-C: AAD binds a token to its agent name. A row encrypted under
    // agent A must NOT decrypt under agent B's name, even though both share the
    // same shared secret. This is what makes a copied token-row useless.
    describe('AAD binding (agent name)', () => {
      it('encrypt(aad=A) then decrypt(aad=A) → original token', () => {
        const token = '987654321:AAtokenForAgentA';
        const blob = encryptSecret(token, 'agent-a');
        assert.ok(blob);
        assert.equal(decryptSecret(blob!, 'agent-a'), token);
      });

      it('encrypt(aad=A) then decrypt(aad=B) → null (copied row is useless)', () => {
        const blob = encryptSecret('shared-secret-token', 'agent-a');
        assert.ok(blob);
        assert.equal(decryptSecret(blob!, 'agent-b'), null);
      });

      it('encrypt(aad=A) then decrypt with NO aad → null', () => {
        const blob = encryptSecret('aad-only-token', 'agent-a');
        assert.ok(blob);
        assert.equal(decryptSecret(blob!), null);
      });

      it('encrypt with NO aad then decrypt(aad=A) → null', () => {
        const blob = encryptSecret('no-aad-token');
        assert.ok(blob);
        assert.equal(decryptSecret(blob!, 'agent-a'), null);
      });
    });
  });

  describe('with NO shared secret', () => {
    beforeEach(() => {
      delete process.env['ORCHESTRATOR_SECRET'];
    });

    it('encryptSecret returns null gracefully', () => {
      assert.equal(encryptSecret('anything'), null);
    });

    it('decryptSecret returns null gracefully (does not throw)', () => {
      assert.equal(decryptSecret('some-blob'), null);
    });

    it('a blob made WITH a secret cannot decrypt once the secret is gone', () => {
      process.env['ORCHESTRATOR_SECRET'] = 'temp-secret-value';
      const blob = encryptSecret('vanishing')!;
      delete process.env['ORCHESTRATOR_SECRET'];
      assert.equal(decryptSecret(blob), null);
    });
  });
});
