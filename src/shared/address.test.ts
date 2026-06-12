import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, addressToString, type Address } from './address.ts';

describe('parseAddress', () => {
  // ── Valid forms ──

  const validCases: Array<{ raw: string; expected: Address }> = [
    { raw: 'foo', expected: { class: 'agent', name: 'foo' } },
    { raw: 'agent-1', expected: { class: 'agent', name: 'agent-1' } },
    { raw: 'a', expected: { class: 'agent', name: 'a' } },
    { raw: 'agent:foo', expected: { class: 'agent', name: 'foo' } },
    { raw: 'agent:my_agent-2', expected: { class: 'agent', name: 'my_agent-2' } },
    {
      raw: 'approval:my-channel',
      expected: { class: 'approval', channel: 'my-channel' },
    },
    {
      raw: 'approval:aws_account_provision',
      expected: { class: 'approval', channel: 'aws_account_provision' },
    },
    {
      raw: 'telegram:almanac',
      expected: { class: 'telegram', agentName: 'almanac' },
    },
    {
      raw: 'telegram:my_agent-2',
      expected: { class: 'telegram', agentName: 'my_agent-2' },
    },
  ];

  for (const { raw, expected } of validCases) {
    it(`parses "${raw}" as ${expected.class}`, () => {
      assert.deepEqual(parseAddress(raw), expected);
    });
  }

  // ── Malformed forms ──

  const malformedCases: Array<{ raw: unknown; description: string }> = [
    { raw: '', description: 'empty string' },
    { raw: 'agent:', description: 'agent: with empty name' },
    { raw: 'agent:/inst-1', description: 'agent: with slash (instance form removed by RFC-009)' },
    { raw: 'agent:foo/', description: 'agent: with trailing slash' },
    { raw: 'agent:foo/bar', description: 'agent: slash form (instance addressing removed by RFC-009)' },
    { raw: 'agent:UPPER!', description: 'agent: with invalid chars' },
    { raw: 'agent:foo bar', description: 'agent: with whitespace' },
    { raw: 'topic:', description: 'topic: prefix (removed by RFC-009)' },
    { raw: 'topic:foo', description: 'topic: prefix with name (removed by RFC-009)' },
    { raw: 'topic:foo/bar', description: 'topic: slash form (removed by RFC-009)' },
    { raw: 'approval:', description: 'approval: with empty channel' },
    { raw: 'approval:bad chan', description: 'approval: with whitespace' },
    { raw: 'approval:BAD!', description: 'approval: with invalid chars' },
    { raw: 'telegram:', description: 'telegram: with empty agent name' },
    { raw: 'telegram:bad name', description: 'telegram: with whitespace' },
    { raw: 'telegram:BAD!', description: 'telegram: with invalid chars' },
    { raw: 'weird:foo', description: 'unknown prefix' },
    { raw: 'http://foo/bar', description: 'unrelated URL-looking string' },
    { raw: '-leading-dash', description: 'bare name starting with dash' },
    { raw: '_leading_underscore', description: 'bare name starting with underscore' },
    { raw: 'has space', description: 'bare name with whitespace' },
    { raw: null, description: 'null input' },
    { raw: undefined, description: 'undefined input' },
    { raw: 42, description: 'numeric input' },
    { raw: {}, description: 'object input' },
  ];

  for (const { raw, description } of malformedCases) {
    it(`marks ${description} as malformed`, () => {
      const result = parseAddress(raw);
      assert.equal(result.class, 'malformed');
      if (result.class === 'malformed') {
        assert.equal(typeof result.reason, 'string');
        assert.ok(result.reason.length > 0, 'reason should be non-empty');
      }
    });
  }

  it('produces a stable reason for unknown prefix', () => {
    const result = parseAddress('weird:foo');
    assert.equal(result.class, 'malformed');
    if (result.class === 'malformed') {
      assert.match(result.reason, /unknown address prefix/);
    }
  });

  // RFC-009: instance addressing removed. `agent:<tmpl>/<id>` now fails
  // NAME_RE (slash is not a name char) and `topic:` is an unknown prefix.
  it('marks agent:foo/bar malformed with a name-shape reason', () => {
    const result = parseAddress('agent:foo/bar');
    assert.equal(result.class, 'malformed');
    if (result.class === 'malformed') {
      assert.match(result.reason, /does not match/);
    }
  });

  it('marks topic:foo/bar malformed with an unknown-prefix reason', () => {
    const result = parseAddress('topic:foo/bar');
    assert.equal(result.class, 'malformed');
    if (result.class === 'malformed') {
      assert.match(result.reason, /unknown address prefix/);
      assert.ok(!result.reason.includes('topic:'), 'expected-prefix list must not advertise topic:');
    }
  });
});

describe('addressToString', () => {
  it('round-trips agent', () => {
    const addr = parseAddress('agent:foo');
    assert.equal(addressToString(addr), 'agent:foo');
  });

  it('renders bare-name agent in canonical agent: form', () => {
    // Bare name parses to {class:'agent', name:'foo'}; canonical render is `agent:foo`.
    const addr = parseAddress('foo');
    assert.equal(addressToString(addr), 'agent:foo');
  });

  it('round-trips approval', () => {
    const raw = 'approval:my-channel';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });

  it('round-trips telegram', () => {
    const raw = 'telegram:almanac';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });

  it('returns the raw input for malformed addresses', () => {
    const raw = 'weird:foo';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });
});
