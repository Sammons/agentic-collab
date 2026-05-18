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
      raw: 'agent:foo/inst-123',
      expected: { class: 'agent-instance', template: 'foo', instanceId: 'inst-123' },
    },
    {
      raw: 'agent:aws-account-lead/01h-abcdef',
      expected: { class: 'agent-instance', template: 'aws-account-lead', instanceId: '01h-abcdef' },
    },
    {
      raw: 'topic:foo/bar',
      expected: { class: 'topic', template: 'foo', topic: 'bar' },
    },
    {
      raw: 'topic:aws-account-lead/provision',
      expected: { class: 'topic', template: 'aws-account-lead', topic: 'provision' },
    },
    {
      raw: 'approval:my-channel',
      expected: { class: 'approval', channel: 'my-channel' },
    },
    {
      raw: 'approval:aws_account_provision',
      expected: { class: 'approval', channel: 'aws_account_provision' },
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
    { raw: 'agent:/inst-1', description: 'agent: with empty template before slash' },
    { raw: 'agent:foo/', description: 'agent: with empty instance-id after slash' },
    { raw: 'agent:UPPER!', description: 'agent: with invalid chars' },
    { raw: 'agent:foo bar', description: 'agent: with whitespace' },
    { raw: 'topic:', description: 'topic: with empty body' },
    { raw: 'topic:foo', description: 'topic: missing /topic' },
    { raw: 'topic:foo/', description: 'topic: empty topic name' },
    { raw: 'topic:/bar', description: 'topic: empty template' },
    { raw: 'topic:foo/BAD!', description: 'topic: with invalid topic chars' },
    { raw: 'approval:', description: 'approval: with empty channel' },
    { raw: 'approval:bad chan', description: 'approval: with whitespace' },
    { raw: 'approval:BAD!', description: 'approval: with invalid chars' },
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

  it('rejects agent:foo/INSTANCE! with invalid instance-id chars', () => {
    const result = parseAddress('agent:foo/inst!');
    assert.equal(result.class, 'malformed');
  });

  it('accepts a 128-char instance-id', () => {
    const long = 'a' + 'b'.repeat(127);
    assert.equal(long.length, 128);
    const result = parseAddress(`agent:foo/${long}`);
    assert.equal(result.class, 'agent-instance');
    if (result.class === 'agent-instance') {
      assert.equal(result.instanceId, long);
    }
  });

  it('rejects a 129-char instance-id', () => {
    const long = 'a' + 'b'.repeat(128);
    assert.equal(long.length, 129);
    const result = parseAddress(`agent:foo/${long}`);
    assert.equal(result.class, 'malformed');
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

  it('round-trips agent-instance', () => {
    const raw = 'agent:foo/inst-123';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });

  it('round-trips topic', () => {
    const raw = 'topic:foo/bar';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });

  it('round-trips approval', () => {
    const raw = 'approval:my-channel';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });

  it('returns the raw input for malformed addresses', () => {
    const raw = 'weird:foo';
    assert.equal(addressToString(parseAddress(raw)), raw);
  });
});
