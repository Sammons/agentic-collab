import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveConfig } from './engine-config-resolver.ts';
import type { AgentRecord, EngineConfigRecord } from '../shared/types.ts';

/** Minimal AgentRecord factory — only fields relevant to resolution are set. */
function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'test-agent',
    engine: 'claude',
    model: null,
    thinking: null,
    cwd: '/tmp',
    persona: null,
    permissions: null,
    agentGroup: null,
    launchEnv: null,
    account: null,
    sortOrder: 0,
    hookStart: null,
    hookResume: null,
    hookCompact: null,
    hookExit: null,
    hookInterrupt: null,
    hookSubmit: null,
    state: 'idle',
    stateBeforeShutdown: null,
    currentSessionId: null,
    tmuxSession: null,
    proxyId: null,
    lastActivity: null,
    lastContextPct: null,
    reloadQueued: 0,
    reloadTask: null,
    failedAt: null,
    failureReason: null,
    capturedVars: null,
    customButtons: null,
    indicators: null,
    version: 1,
    spawnCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Minimal EngineConfigRecord factory. */
function makeConfig(overrides: Partial<EngineConfigRecord> = {}): EngineConfigRecord {
  return {
    name: 'test-config',
    engine: 'codex',
    model: null,
    thinking: null,
    permissions: null,
    hookStart: null,
    hookResume: null,
    hookCompact: null,
    hookExit: null,
    hookInterrupt: null,
    hookSubmit: null,
    launchEnv: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('resolveEffectiveConfig', () => {
  it('returns agent unchanged when config is null', () => {
    const agent = makeAgent({ model: 'opus', thinking: 'high' });
    const result = resolveEffectiveConfig(agent, null);
    assert.deepEqual(result, agent);
    // Verify identity — same object returned, no copy
    assert.equal(result, agent);
  });

  it('agent engine wins over config engine', () => {
    const agent = makeAgent({ engine: 'claude' });
    const config = makeConfig({ engine: 'codex' });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.engine, 'claude');
  });

  it('merges model from config when agent model is null', () => {
    const agent = makeAgent({ model: null });
    const config = makeConfig({ model: 'opus' });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.model, 'opus');
  });

  it('agent model overrides config model', () => {
    const agent = makeAgent({ model: 'sonnet' });
    const config = makeConfig({ model: 'opus' });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.model, 'sonnet');
  });

  it('merges thinking from config when agent thinking is null', () => {
    const agent = makeAgent({ thinking: null });
    const config = makeConfig({ thinking: 'high' });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.thinking, 'high');
  });

  it('merges permissions from config when agent permissions is null', () => {
    const agent = makeAgent({ permissions: null });
    const config = makeConfig({ permissions: 'skip' });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.permissions, 'skip');
  });

  it('agent permissions override config permissions', () => {
    const agent = makeAgent({ permissions: 'skip' });
    const config = makeConfig({ permissions: null });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.permissions, 'skip');
  });

  it('merges all hook fields from config', () => {
    const agent = makeAgent();
    const config = makeConfig({
      hookStart: 'cfg-start',
      hookResume: 'cfg-resume',
      hookCompact: 'cfg-compact',
      hookExit: 'cfg-exit',
      hookInterrupt: 'cfg-interrupt',
      hookSubmit: 'cfg-submit',
    });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.hookStart, 'cfg-start');
    assert.equal(result.hookResume, 'cfg-resume');
    assert.equal(result.hookCompact, 'cfg-compact');
    assert.equal(result.hookExit, 'cfg-exit');
    assert.equal(result.hookInterrupt, 'cfg-interrupt');
    assert.equal(result.hookSubmit, 'cfg-submit');
  });

  it('agent hook overrides config hook', () => {
    const agent = makeAgent({
      hookStart: 'agent-start',
      hookResume: 'agent-resume',
    });
    const config = makeConfig({
      hookStart: 'cfg-start',
      hookResume: 'cfg-resume',
      hookCompact: 'cfg-compact',
    });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.hookStart, 'agent-start');
    assert.equal(result.hookResume, 'agent-resume');
    assert.equal(result.hookCompact, 'cfg-compact');
  });

  it('merges launchEnv from config when agent launchEnv is null', () => {
    const agent = makeAgent({ launchEnv: null });
    const config = makeConfig({ launchEnv: { FOO: 'bar' } });
    const result = resolveEffectiveConfig(agent, config);
    assert.deepEqual(result.launchEnv, { FOO: 'bar' });
  });

  it('agent launchEnv overrides config launchEnv', () => {
    const agent = makeAgent({ launchEnv: { MY_VAR: 'agent-val' } });
    const config = makeConfig({ launchEnv: { FOO: 'bar' } });
    const result = resolveEffectiveConfig(agent, config);
    assert.deepEqual(result.launchEnv, { MY_VAR: 'agent-val' });
  });

  it('non-config fields (name, cwd, state, etc.) are untouched', () => {
    const agent = makeAgent({
      name: 'my-agent',
      cwd: '/home/test',
      state: 'active',
      persona: 'my-persona',
      currentSessionId: 'sess-123',
      proxyId: 'p1',
      capturedVars: { FOO: 'bar' },
      account: 'acct-1',
      version: 5,
      spawnCount: 3,
    });
    const config = makeConfig({
      engine: 'codex',
      model: 'gpt-4',
      thinking: 'high',
    });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(result.name, 'my-agent');
    assert.equal(result.cwd, '/home/test');
    assert.equal(result.state, 'active');
    assert.equal(result.persona, 'my-persona');
    assert.equal(result.currentSessionId, 'sess-123');
    assert.equal(result.proxyId, 'p1');
    assert.deepEqual(result.capturedVars, { FOO: 'bar' });
    assert.equal(result.account, 'acct-1');
    assert.equal(result.version, 5);
    assert.equal(result.spawnCount, 3);
  });

  it('does not mutate the original agent', () => {
    const agent = makeAgent({ model: null });
    const config = makeConfig({ model: 'opus' });
    const result = resolveEffectiveConfig(agent, config);
    assert.equal(agent.model, null);
    assert.equal(result.model, 'opus');
    assert.notEqual(result, agent);
  });

  it('does not mutate the original config', () => {
    const agent = makeAgent();
    const config = makeConfig({ model: 'opus' });
    const originalConfigModel = config.model;
    resolveEffectiveConfig(agent, config);
    assert.equal(config.model, originalConfigModel);
  });

  it('handles both agent and config having all nulls', () => {
    const agent = makeAgent();
    const config = makeConfig();
    const result = resolveEffectiveConfig(agent, config);
    // engine falls through: agent.engine is 'claude' (non-null), so it stays
    assert.equal(result.engine, 'claude');
    assert.equal(result.model, null);
    assert.equal(result.thinking, null);
    assert.equal(result.permissions, null);
    assert.equal(result.hookStart, null);
    assert.equal(result.launchEnv, null);
  });
});
