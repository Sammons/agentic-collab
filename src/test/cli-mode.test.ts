/**
 * v3 Q7: bin/collab mode-awareness tests.
 *
 * Spawn the CLI in --help mode under two env scenarios and assert the help
 * surface adapts:
 *   - With the full ephemeral env trio (MESSAGE_ID + AGENT_TEMPLATE +
 *     REPLY_PATH) set: ephemeral banner, `complete` and `fail` listed.
 *   - With none of those env vars: persistent banner, `complete` and `fail`
 *     omitted from the help output.
 *
 * `--help` short-circuits before any orchestrator round-trip in bin/collab's
 * main(), so we point ORCHESTRATOR_URL at an unreachable address as a belt-
 * and-suspenders guard — if the help path ever regresses to require network,
 * the test will surface it loudly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COLLAB_BIN = resolve(__dirname, '..', '..', 'bin', 'collab');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCollabHelp(env: Record<string, string | undefined>): RunResult {
  // Start from a minimal env so we don't accidentally inherit MESSAGE_ID etc.
  // from the parent test runner. Keep PATH because Node needs it on the
  // shebang invocation; everything else is explicit.
  const base: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ORCHESTRATOR_URL: 'http://127.0.0.1:1', // unreachable — proves --help is offline
  };
  const merged: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) merged[k] = v;
  }
  const result = spawnSync(process.execPath, [COLLAB_BIN, '--help'], {
    env: merged,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('CLI mode-awareness (bin/collab)', () => {
  it('ephemeral mode: env trio set → banner + complete/fail listed', () => {
    const out = runCollabHelp({
      MESSAGE_ID: 'msg-test-123',
      AGENT_TEMPLATE: 'test-echo',
      REPLY_PATH: '/tmp/reply-test.json',
      TOPIC_NAME: 'echo',
    });
    assert.equal(out.status, 0, `expected exit 0, got ${out.status}; stderr=${out.stderr}`);
    // Banner mentions the message-id and template/topic.
    assert.match(out.stdout, /You are handling message msg-test-123/);
    assert.match(out.stdout, /test-echo\/echo/);
    assert.match(out.stdout, /collab complete --reply/);
    // Both subcommands should appear in the listed commands.
    assert.match(out.stdout, /^\s+complete --reply <json>\s+Ephemeral: signal success/m);
    assert.match(out.stdout, /^\s+fail --reason <text>\s+Ephemeral: signal failure/m);
  });

  it('persistent mode: no env trio → persistent banner + no complete/fail', () => {
    const out = runCollabHelp({
      COLLAB_AGENT: 'persistent-test-agent',
    });
    assert.equal(out.status, 0, `expected exit 0, got ${out.status}; stderr=${out.stderr}`);
    assert.match(out.stdout, /Agent: persistent-test-agent/);
    assert.match(out.stdout, /Send messages with: `collab send <target>/);
    // complete/fail must NOT appear in the command listing.
    assert.doesNotMatch(out.stdout, /^\s+complete --reply <json>/m);
    assert.doesNotMatch(out.stdout, /^\s+fail --reason <text>/m);
    // Ephemeral banner phrase must not leak into persistent mode.
    assert.doesNotMatch(out.stdout, /You are handling message/);
  });

  it('partial env (missing AGENT_TEMPLATE) does NOT flip into ephemeral mode', () => {
    // Per spec: detection is strict — all three must be set. This guards
    // against accidental env leakage from a parent shell.
    const out = runCollabHelp({
      MESSAGE_ID: 'msg-partial',
      REPLY_PATH: '/tmp/reply-partial.json',
      // AGENT_TEMPLATE intentionally omitted
    });
    assert.equal(out.status, 0);
    // Stays in persistent mode despite two of three vars being set.
    assert.match(out.stdout, /Agent:/);
    assert.doesNotMatch(out.stdout, /^\s+complete --reply <json>/m);
    assert.doesNotMatch(out.stdout, /You are handling message/);
  });

  it('partial env (missing REPLY_PATH) does NOT flip into ephemeral mode', () => {
    const out = runCollabHelp({
      MESSAGE_ID: 'msg-partial-2',
      AGENT_TEMPLATE: 'test-echo',
    });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Agent:/);
    assert.doesNotMatch(out.stdout, /^\s+complete --reply <json>/m);
  });
});
