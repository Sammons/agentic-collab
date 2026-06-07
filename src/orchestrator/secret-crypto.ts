/**
 * Secret encryption helper for RFC-008 (per-agent Telegram bot tokens).
 *
 * Zero runtime deps — uses ONLY node:crypto. Tokens are encrypted at rest with
 * AES-256-GCM. The 32-byte key is derived per-record via scrypt from the
 * orchestrator shared secret (the same secret the API already trusts for Bearer
 * auth), so there is no new key material to manage.
 *
 * Blob format (base64 of a packed buffer):
 *   salt(16) || iv(12) || authTag(16) || ciphertext(...)
 *
 * The salt is random per record, so the derived key is per-record and rotating
 * the shared secret simply makes all prior blobs undecryptable (decryptSecret
 * returns null) rather than silently producing garbage.
 *
 * Both functions are total: they NEVER throw to callers. encrypt/decrypt return
 * null when the shared secret is unavailable, and decrypt returns null on any
 * malformed input or GCM auth-tag mismatch (tampering / wrong key).
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { resolveSecret } from '../shared/config.ts';

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
const ALGO = 'aes-256-gcm';

/**
 * Derive a 32-byte AES key from the shared secret + a per-record salt.
 * Not cached: callers pass the freshly-resolved secret so a rotated secret is
 * honored on the next call.
 */
function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LEN);
}

/**
 * Encrypt `plaintext` (a bot token) with a fresh random salt + IV. Returns a
 * self-describing base64 blob, or null when the shared secret is unavailable
 * (no key material → cannot encrypt).
 *
 * `aad` (optional, RFC-008 PR-Bsec review NIT) binds the ciphertext to a context
 * string (the agent name) via GCM Additional Authenticated Data. The AAD is NOT
 * stored in the blob — the caller must supply the SAME `aad` to `decryptSecret`,
 * else the GCM auth-tag check fails and decrypt returns null. This makes a token
 * row copied to a different agent undecryptable under that agent's name.
 *
 * Never logs or returns the plaintext.
 */
export function encryptSecret(plaintext: string, aad?: string): string | null {
  const secret = resolveSecret();
  if (!secret) return null;
  try {
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = deriveKey(secret, salt);
    const cipher = createCipheriv(ALGO, key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, tag, ct]).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Decrypt a blob produced by `encryptSecret`. Returns the original plaintext, or
 * null on ANY failure: missing shared secret, malformed/empty blob, truncated
 * buffer, or GCM auth-tag mismatch (tampering or wrong/rotated key). Never throws.
 *
 * `aad` must match the value passed to `encryptSecret` (the agent name). A blob
 * encrypted with AAD=A but decrypted with AAD=B (or no AAD) fails the auth-tag
 * check → null. The AAD is not stored in the blob; it is reconstructed by the
 * caller from the context (the agent name the row belongs to).
 */
export function decryptSecret(blob: string, aad?: string): string | null {
  if (typeof blob !== 'string' || blob.length === 0) return null;
  const secret = resolveSecret();
  if (!secret) return null;
  try {
    const buf = Buffer.from(blob, 'base64');
    // Must hold at least salt + iv + tag + 1 byte of ciphertext... but GCM
    // permits empty ciphertext, so require only salt + iv + tag.
    if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) return null;
    let offset = 0;
    const salt = buf.subarray(offset, offset + SALT_LEN); offset += SALT_LEN;
    const iv = buf.subarray(offset, offset + IV_LEN); offset += IV_LEN;
    const tag = buf.subarray(offset, offset + TAG_LEN); offset += TAG_LEN;
    const ct = buf.subarray(offset);
    const key = deriveKey(secret, Buffer.from(salt));
    const decipher = createDecipheriv(ALGO, key, iv);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    // GCM auth failure (final() throws), malformed base64, etc.
    return null;
  }
}
