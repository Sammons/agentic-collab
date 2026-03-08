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
    const output = '  Session\n  ████████████████████  50% used\n';
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

  it('ignores "NN% used" without adjacent progress bar (false positive)', () => {
    const output = [
      '  Claude adapter: parseContextPercent reports %',
      '  used directly: 19% used',
      '  some other text',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 0);
  });

  it('ignores stray "NN% used" in conversation text', () => {
    const output = [
      '  The API shows 45% used this month',
      '  We need to reduce usage',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 0);
  });
});

describe('parseCodexStatus', () => {
  it('parses real codex /status output', () => {
    const output = [
      '╭─────────────────────────────────────────────────────────────────────────────────╮',
      '│  >_ OpenAI Codex (v0.111.0)                                                     │',
      '│                                                                                 │',
      '│  Model:                gpt-5.4 (reasoning xhigh, summaries auto)                │',
      '│  Account:              user@example.com (Plus)                                    │',
      '│                                                                                 │',
      '│  5h limit:             [████████████████░░░░] 80% left (resets 12:19)           │',
      '│  Weekly limit:         [█████░░░░░░░░░░░░░░░] 26% left (resets 01:44 on 13 Mar) │',
      '╰─────────────────────────────────────────────────────────────────────────────────╯',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0]!.label, '5h limit');
    assert.equal(buckets[0]!.pctUsed, 20); // 100 - 80
    assert.equal(buckets[0]!.resetsAt, '12:19');
    assert.equal(buckets[1]!.label, 'Weekly limit');
    assert.equal(buckets[1]!.pctUsed, 74); // 100 - 26
    assert.equal(buckets[1]!.resetsAt, '01:44 on 13 Mar');
  });

  it('parses "NN% used" format', () => {
    const output = '│  Daily limit:  [████] 45% used (resets tomorrow) │';
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.label, 'Daily limit');
    assert.equal(buckets[0]!.pctUsed, 45);
    assert.equal(buckets[0]!.resetsAt, 'tomorrow');
  });

  it('ignores non-limit lines (model, account, prompts)', () => {
    const output = [
      '│  Model:                gpt-5.4 (reasoning xhigh)                │',
      '│  Account:              test@test.io (Plus)                      │',
      '› Implement {feature}',
      '  83% context left',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 0);
  });

  it('returns empty for no usage data', () => {
    const buckets = parseCodexStatus('no status info here');
    assert.equal(buckets.length, 0);
  });
});
