/**
 * Message sanitization: strip control characters, tmux escape sequences, enforce length cap.
 */

const MAX_MESSAGE_LENGTH = 16 * 1024; // 16KB

/**
 * Strip C0/C1 control characters except newline and tab.
 * Strip tmux escape sequences.
 * Truncate to MAX_MESSAGE_LENGTH.
 */
export function sanitizeMessage(text: string): string {
  // Strip C0 control chars (0x00-0x1F) except \n (0x0A) and \t (0x09)
  // Strip C1 control chars (0x7F-0x9F)
  // Strip ANSI/tmux escape sequences (\x1B[...)
  let cleaned = text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')     // ANSI CSI sequences
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/gs, '') // OSC sequences (BEL or ST terminator)
    .replace(/\x1B\][^\x07]*$/g, '')            // Truncated OSC (no terminator before end)
    .replace(/\x1B[^[\]]/g, '')                 // Other ESC sequences
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

  if (cleaned.length > MAX_MESSAGE_LENGTH) {
    cleaned = cleaned.slice(0, MAX_MESSAGE_LENGTH);
  }

  return cleaned;
}

/**
 * Generate a simple message ID (nano-id style, no deps).
 */
export function generateMessageId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // Rejection sampling: largest multiple of 62 that fits in a byte
  const limit = 256 - (256 % chars.length); // 248
  let id = 'msg-';
  let filled = 0;
  while (filled < 12) {
    const bytes = new Uint8Array(16); // over-allocate to reduce rounds
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit) {
        id += chars[b % chars.length];
        filled++;
        if (filled >= 12) break;
      }
    }
  }
  return id;
}

/**
 * Generate a random token for proxy auth.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
