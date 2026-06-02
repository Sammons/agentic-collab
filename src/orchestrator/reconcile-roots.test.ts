import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { reconcileEphemeralRoots } from './reconcile-roots.ts';
import type { AgentTemplateRow, ProxyCommand, ProxyResponse } from '../shared/types.ts';

function makeTemplate(id: string): AgentTemplateRow {
  return {
    id,
    personaPath: null,
    engine: 'claude',
    model: null,
    persistent: false,
    cwdBase: '/tmp/base',
    cwdTemplate: null,
    repoRoot: null,
    hookStart: null,
    hookExit: null,
    hookPrepare: null,
    hookCleanup: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('reconcileEphemeralRoots (RFC-006 Q1)', () => {
  let tmpDir: string;
  let db: Database;
  let proxyCommands: Array<{ proxyId: string; command: ProxyCommand }>;
  let broadcasts: string[];
  const proxyDispatch = async (proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
    proxyCommands.push({ proxyId, command });
    return { ok: true };
  };
  const broadcast = (name: string) => { broadcasts.push(name); };

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-roots-test-'));
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh DB per test for isolation.
    if (db) db.close();
    db = new Database(join(tmpDir, `db-${Math.random().toString(36).slice(2)}.db`));
    proxyCommands = [];
    broadcasts = [];
  });

  it('deletes a stale agents row shadowing an ephemeral template, kills its session FIRST, broadcasts once', async () => {
    db.upsertAgentTemplate(makeTemplate('lead-ephemeral'));
    // Stale shadowing row: suspended but still owns a live session.
    db.createAgent({ name: 'lead-ephemeral', engine: 'claude', cwd: '/tmp/x', proxyId: 'proxy-1' });
    db.updateAgentState('lead-ephemeral', 'suspended', 0, { tmuxSession: 'agent-lead-ephemeral' });

    assert.ok(db.getAgent('lead-ephemeral'), 'precondition: stale agents row exists');

    const reconciled = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });

    assert.deepEqual(reconciled, ['lead-ephemeral']);
    assert.equal(db.getAgent('lead-ephemeral'), undefined, 'stale agents row deleted');

    // Session killed FIRST (before delete), targeting the stored tmuxSession.
    assert.equal(proxyCommands.length, 1, 'exactly one proxy command (kill_session)');
    assert.equal(proxyCommands[0]!.command.action, 'kill_session');
    assert.equal(proxyCommands[0]!.proxyId, 'proxy-1');
    assert.equal((proxyCommands[0]!.command as { sessionName: string }).sessionName, 'agent-lead-ephemeral');

    // Broadcast exactly once, gated on the delete.
    assert.deepEqual(broadcasts, ['lead-ephemeral']);

    // `destroyed` event logged.
    const events = db.getEvents('lead-ephemeral');
    assert.ok(events.some((e) => e.event === 'destroyed'), 'destroyed event logged');
  });

  it('is idempotent: a second call no-ops and does not re-broadcast', async () => {
    db.upsertAgentTemplate(makeTemplate('lead-ephemeral'));
    db.createAgent({ name: 'lead-ephemeral', engine: 'claude', cwd: '/tmp/x', proxyId: 'proxy-1' });
    db.updateAgentState('lead-ephemeral', 'suspended', 0, { tmuxSession: 'agent-lead-ephemeral' });

    const first = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });
    assert.deepEqual(first, ['lead-ephemeral']);
    assert.deepEqual(broadcasts, ['lead-ephemeral']);

    // Reset capture; the second run must be a pure no-op.
    proxyCommands = [];
    broadcasts = [];
    const second = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });
    assert.deepEqual(second, [], 'second call reconciles nothing');
    assert.deepEqual(proxyCommands, [], 'no kill_session on no-op');
    assert.deepEqual(broadcasts, [], 'no re-broadcast on no-op (gated on actual delete)');
  });

  it('no-ops when an ephemeral template has no shadowing agents row', async () => {
    db.upsertAgentTemplate(makeTemplate('clean-ephemeral'));
    const reconciled = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });
    assert.deepEqual(reconciled, []);
    assert.deepEqual(proxyCommands, []);
    assert.deepEqual(broadcasts, []);
  });

  it('skips kill_session when the stale row has no proxy/session, but still deletes + broadcasts', async () => {
    db.upsertAgentTemplate(makeTemplate('lead-ephemeral'));
    // Suspended with NO proxy/session (e.g. never spawned).
    db.createAgent({ name: 'lead-ephemeral', engine: 'claude', cwd: '/tmp/x' });

    const reconciled = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });
    assert.deepEqual(reconciled, ['lead-ephemeral']);
    assert.deepEqual(proxyCommands, [], 'no kill_session without proxy+session');
    assert.deepEqual(broadcasts, ['lead-ephemeral']);
    assert.equal(db.getAgent('lead-ephemeral'), undefined);
  });

  it('does NOT touch a persistent agent that shares a name with no template', async () => {
    // A persistent agent (not in listTemplatesAsAgentRecords) must be untouched.
    db.createAgent({ name: 'real-agent', engine: 'claude', cwd: '/tmp/x', proxyId: 'proxy-1' });
    const reconciled = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });
    assert.deepEqual(reconciled, []);
    assert.ok(db.getAgent('real-agent'), 'persistent agent untouched');
  });

  it('does NOT reconcile a LIVE agent (state=active) — no kill, no delete, no broadcast', async () => {
    // Lifecycle safety: a persona flipped to ephemeral while its agent is still
    // running must not be torn down from a background poll.
    db.upsertAgentTemplate(makeTemplate('lead-ephemeral'));
    db.createAgent({ name: 'lead-ephemeral', engine: 'claude', cwd: '/tmp/x', proxyId: 'proxy-1' });
    db.updateAgentState('lead-ephemeral', 'active', 0, { tmuxSession: 'agent-lead-ephemeral' });

    const reconciled = await reconcileEphemeralRoots({ db, proxyDispatch, broadcast });
    assert.deepEqual(reconciled, [], 'a live agent is not reconciled');
    assert.deepEqual(proxyCommands, [], 'no kill_session on a live agent');
    assert.deepEqual(broadcasts, [], 'no broadcast on a live agent');
    assert.ok(db.getAgent('lead-ephemeral'), 'live agent row preserved');
  });

  it('still deletes + broadcasts when kill_session fails (proxy offline) — best-effort', async () => {
    db.upsertAgentTemplate(makeTemplate('lead-ephemeral'));
    db.createAgent({ name: 'lead-ephemeral', engine: 'claude', cwd: '/tmp/x', proxyId: 'proxy-1' });
    db.updateAgentState('lead-ephemeral', 'suspended', 0, { tmuxSession: 'agent-lead-ephemeral' });

    const throwingDispatch = async (): Promise<ProxyResponse> => { throw new Error('proxy offline'); };
    const reconciled = await reconcileEphemeralRoots({ db, proxyDispatch: throwingDispatch, broadcast });
    assert.deepEqual(reconciled, ['lead-ephemeral'], 'delete proceeds despite a kill_session failure');
    assert.deepEqual(broadcasts, ['lead-ephemeral']);
    assert.equal(db.getAgent('lead-ephemeral'), undefined, 'stale row still removed');
  });
});
