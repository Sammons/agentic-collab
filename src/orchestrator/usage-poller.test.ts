import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage, parseCodexStatus } from './usage-poller.ts';

describe('parseClaudeUsage', () => {
  it('parses typical /usage output with two buckets', () => {
    const output = [
      '  Current session',
      '  ████▌                                              9% used',
      '  Resets 12pm (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ███████████                                        22% used',
      '  Resets Mar 13, 12am (America/Chicago)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 2);

    assert.equal(buckets[0]!.label, 'Current session');
    assert.equal(buckets[0]!.pctUsed, 9);
    assert.equal(buckets[0]!.resetsAt, '12pm (America/Chicago)');

    assert.equal(buckets[1]!.label, 'Current week (all models)');
    assert.equal(buckets[1]!.pctUsed, 22);
    assert.equal(buckets[1]!.resetsAt, 'Mar 13, 12am (America/Chicago)');
  });

  it('parses three buckets including Sonnet-only', () => {
    const output = [
      '  Current session',
      '  ██                                                 4% used',
      '  Resets 6pm (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ████████████████                                   32% used',
      '  Resets Mar 15, 12am (America/Chicago)',
      '',
      '  Current week (Sonnet only)',
      '  ███████                                            14% used',
      '  Resets Mar 15, 12am (America/Chicago)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 3);
    assert.equal(buckets[2]!.label, 'Current week (Sonnet only)');
    assert.equal(buckets[2]!.pctUsed, 14);
  });

  it('returns empty array for no usage data', () => {
    const buckets = parseClaudeUsage('some random output\nno usage here');
    assert.equal(buckets.length, 0);
  });

  it('handles missing reset info', () => {
    const output = '  Session\n  50% used\n';
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.pctUsed, 50);
    assert.equal(buckets[0]!.resetsAt, '');
  });

  it('skips progress bar lines when finding label', () => {
    const output = [
      '  My label',
      '  ████████████████████████████████████████████',
      '  75% used',
      '  Resets tomorrow',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets[0]!.label, 'My label');
    assert.equal(buckets[0]!.pctUsed, 75);
  });
});

describe('parseCodexStatus', () => {
  it('parses "NN% used" format', () => {
    const output = [
      '  API usage',
      '  45% used',
      '  Resets Mar 20',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.label, 'API usage');
    assert.equal(buckets[0]!.pctUsed, 45);
    assert.equal(buckets[0]!.resetsAt, 'Mar 20');
  });

  it('parses "NN% remaining" format and converts to used', () => {
    const output = [
      '  Weekly budget',
      '  70% remaining',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.pctUsed, 30);
  });

  it('parses "NN% left" format and converts to used', () => {
    const output = '  Budget\n  85% left\n';
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.pctUsed, 15);
  });

  it('returns empty for no usage data', () => {
    const buckets = parseCodexStatus('no status info here');
    assert.equal(buckets.length, 0);
  });
});
