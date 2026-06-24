/**
 * Address parsing for agentic-collab v3.
 *
 * Two address classes plus a malformed sentinel:
 *  - `agent:<name>` — persistent agent inbox. Bare names (no prefix) are
 *    treated as `agent:<name>` for 2.x compatibility.
 *  - `telegram:<agent>` — an agent's per-agent Telegram bot outbound channel
 *    (RFC-008 PR-D). `collab send telegram:<agent>` routes a reply back out
 *    through that agent's bot to the originating chat.
 *
 * Parsing is total: every input yields a discriminated union value. Malformed
 * inputs carry a `reason` string so the entry layer can return a clear 400.
 *
 * Storage continues to use bare agent names; this module is purely a parser
 * and round-trip helper.
 */

/** Validates agent/channel segments: 1-63 chars, alnum start, [a-zA-Z0-9_-]. */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/** Known address class prefixes. */
const KNOWN_PREFIXES = new Set(['agent', 'telegram']);

export type Address =
  | { class: 'agent'; name: string }
  | { class: 'telegram'; agentName: string }
  | { class: 'malformed'; raw: string; reason: string };

/**
 * Parse a raw address string into a discriminated union.
 *
 * Total over all inputs — never throws. Non-string and empty inputs return a
 * `malformed` value with an explanatory `reason`.
 */
export function parseAddress(raw: unknown): Address {
  if (typeof raw !== 'string') {
    return { class: 'malformed', raw: String(raw), reason: 'address must be a string' };
  }
  if (raw.length === 0) {
    return { class: 'malformed', raw, reason: 'empty address' };
  }

  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) {
    // Bare name → treat as agent: for 2.x compatibility.
    if (!NAME_RE.test(raw)) {
      return { class: 'malformed', raw, reason: `bare name "${raw}" does not match ${NAME_RE.source}` };
    }
    return { class: 'agent', name: raw };
  }

  const prefix = raw.slice(0, colonIdx);
  const rest = raw.slice(colonIdx + 1);

  if (!KNOWN_PREFIXES.has(prefix)) {
    return { class: 'malformed', raw, reason: `unknown address prefix "${prefix}" (expected agent: or telegram:)` };
  }

  if (prefix === 'agent') {
    if (rest.length === 0) {
      return { class: 'malformed', raw, reason: 'agent: prefix with empty name' };
    }
    if (!NAME_RE.test(rest)) {
      return { class: 'malformed', raw, reason: `agent name "${rest}" does not match ${NAME_RE.source}` };
    }
    return { class: 'agent', name: rest };
  }

  // prefix === 'telegram'
  // telegram:<agent> — the agent's per-agent bot outbound channel. Bare
  // `telegram` (empty name) is malformed: the CLI keeps bare `telegram`
  // (no colon) as a destination shorthand, so a `telegram:` with nothing
  // after the colon is a real error, not a destination fallback.
  if (rest.length === 0) {
    return { class: 'malformed', raw, reason: 'telegram: prefix with empty agent name' };
  }
  if (!NAME_RE.test(rest)) {
    return { class: 'malformed', raw, reason: `telegram agent name "${rest}" does not match ${NAME_RE.source}` };
  }
  return { class: 'telegram', agentName: rest };
}

/**
 * Render an `Address` back to its canonical string form.
 *
 * Round-trips through `parseAddress` for every valid class. For `malformed`
 * the original raw input is returned (it is the only honest representation).
 */
export function addressToString(addr: Address): string {
  switch (addr.class) {
    case 'agent':
      return `agent:${addr.name}`;
    case 'telegram':
      return `telegram:${addr.agentName}`;
    case 'malformed':
      return addr.raw;
  }
}
