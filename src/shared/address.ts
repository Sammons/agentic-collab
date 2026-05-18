/**
 * Address parsing for agentic-collab v3.
 *
 * Four address classes plus a malformed sentinel:
 *  - `agent:<name>` — persistent agent inbox. Bare names (no prefix) are
 *    treated as `agent:<name>` for 2.x compatibility.
 *  - `agent:<template>/<instance-id>` — live ephemeral agent instance.
 *  - `topic:<template>/<topic>` — ephemeral-agent topic queue (spawns work).
 *  - `approval:<channel>` — human-decision queue (categorisation only).
 *
 * Parsing is total: every input yields a discriminated union value. Malformed
 * inputs carry a `reason` string so the entry layer can return a clear 400.
 *
 * Storage continues to use bare agent names; this module is purely a parser
 * and round-trip helper.
 */

/** Validates agent/template/topic/channel segments: 1-63 chars, alnum start, [a-zA-Z0-9_-]. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/** Validates instance-id segments: 1-128 chars, alnum start, [a-zA-Z0-9_-]. */
const INSTANCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** Known address class prefixes. */
const KNOWN_PREFIXES = new Set(['agent', 'topic', 'approval']);

export type Address =
  | { class: 'agent'; name: string }
  | { class: 'agent-instance'; template: string; instanceId: string }
  | { class: 'topic'; template: string; topic: string }
  | { class: 'approval'; channel: string }
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
    return { class: 'malformed', raw, reason: `unknown address prefix "${prefix}" (expected agent:, topic:, or approval:)` };
  }

  if (prefix === 'agent') {
    if (rest.length === 0) {
      return { class: 'malformed', raw, reason: 'agent: prefix with empty name' };
    }
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      if (!NAME_RE.test(rest)) {
        return { class: 'malformed', raw, reason: `agent name "${rest}" does not match ${NAME_RE.source}` };
      }
      return { class: 'agent', name: rest };
    }
    const template = rest.slice(0, slashIdx);
    const instanceId = rest.slice(slashIdx + 1);
    if (!NAME_RE.test(template)) {
      return { class: 'malformed', raw, reason: `agent-instance template "${template}" does not match ${NAME_RE.source}` };
    }
    if (!INSTANCE_ID_RE.test(instanceId)) {
      return { class: 'malformed', raw, reason: `agent-instance id "${instanceId}" does not match ${INSTANCE_ID_RE.source}` };
    }
    return { class: 'agent-instance', template, instanceId };
  }

  if (prefix === 'topic') {
    if (rest.length === 0) {
      return { class: 'malformed', raw, reason: 'topic: prefix with empty body' };
    }
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return { class: 'malformed', raw, reason: 'topic: requires "<template>/<topic>" form' };
    }
    const template = rest.slice(0, slashIdx);
    const topic = rest.slice(slashIdx + 1);
    if (!NAME_RE.test(template)) {
      return { class: 'malformed', raw, reason: `topic template "${template}" does not match ${NAME_RE.source}` };
    }
    if (!NAME_RE.test(topic)) {
      return { class: 'malformed', raw, reason: `topic name "${topic}" does not match ${NAME_RE.source}` };
    }
    return { class: 'topic', template, topic };
  }

  // prefix === 'approval'
  if (rest.length === 0) {
    return { class: 'malformed', raw, reason: 'approval: prefix with empty channel' };
  }
  if (!NAME_RE.test(rest)) {
    return { class: 'malformed', raw, reason: `approval channel "${rest}" does not match ${NAME_RE.source}` };
  }
  return { class: 'approval', channel: rest };
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
    case 'agent-instance':
      return `agent:${addr.template}/${addr.instanceId}`;
    case 'topic':
      return `topic:${addr.template}/${addr.topic}`;
    case 'approval':
      return `approval:${addr.channel}`;
    case 'malformed':
      return addr.raw;
  }
}
