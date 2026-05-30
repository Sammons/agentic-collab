import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionName,
  requireProxy,
  isRunning,
  isTransitioning,
  canSuspend,
  canResume,
  ProxyUnavailableError,
} from './agent-entity.ts';
import type { AgentRecord } from './types.ts';

// ── Test Fixtures ──

function makeAgent(overrides: Partial<AgentRecord> & Record<string, unknown> = {}): AgentRecord {
  const base = {
    name: 'test-agent',
    engine: 'claude',
    state: 'active',
    model: null,
    thinking: null,
    cwd: '/test',
    persona: null,
    permissions: null,
    proxyId: 'proxy-1',
    proxyPin: null,
    sortOrder: 0,
    account: null,
    capturedVars: null,
    launchEnv: null,
    version: 1,
    spawnCount: 0,
    createdAt: '2024-01-01T00:00:00Z',
    lastActivity: null,
    hookStart: null,
    hookResume: null,
    hookCompact: null,
    hookExit: null,
    hookInterrupt: null,
    hookSubmit: null,
    customButtons: null,
    indicators: null,
    currentSessionId: null,
    failedAt: null,
    failureReason: null,
    reloadQueued: 0,
    reloadTask: null,
    icon: null,
    agentGroup: null,
    lastContextPct: null,
    tmuxSession: null,
  };
  return { ...base, ...overrides } as AgentRecord;
}

// ── requireProxy edge cases (proxy pinning, RFC-003) ──

describe('requireProxy', () => {
  // baseline (un-pinned) behavior
  test('no pin + proxyId set returns proxyId', () => {
    const agent = makeAgent({ proxyId: 'proxy-9' });
    assert.equal(requireProxy(agent), 'proxy-9');
  });

  test('no pin + proxyId set with registeredProxies provided returns proxyId', () => {
    const agent = makeAgent({ proxyId: 'proxy-1' });
    assert.equal(requireProxy(agent, new Set(['proxy-1'])), 'proxy-1');
  });

  test('no pin + no proxyId throws ProxyUnavailableError', () => {
    const agent = makeAgent({ proxyId: null });
    assert.throws(() => requireProxy(agent), ProxyUnavailableError);
  });

  // pinned behavior
  test('pin set + in registeredProxies returns pin', () => {
    const agent = makeAgent({ proxyPin: 'proxy-2', proxyId: 'proxy-1' });
    assert.equal(requireProxy(agent, new Set(['proxy-2'])), 'proxy-2');
  });

  test('pin set + NOT in registeredProxies throws ProxyUnavailableError', () => {
    const agent = makeAgent({ proxyPin: 'proxy-2' });
    assert.throws(() => requireProxy(agent, new Set(['proxy-1'])), ProxyUnavailableError);
  });

  test('pin overrides a different proxyId (returns pin not proxyId)', () => {
    const agent = makeAgent({ proxyPin: 'proxy-2', proxyId: 'proxy-1' });
    assert.equal(requireProxy(agent, new Set(['proxy-2'])), 'proxy-2');
  });

  test('pin set but no registeredProxies arg returns pin (no throw)', () => {
    const agent = makeAgent({ proxyPin: 'proxy-2', proxyId: 'proxy-1' });
    assert.equal(requireProxy(agent), 'proxy-2');
  });

  test('ProxyUnavailableError carries agentName and pin', () => {
    const agent = makeAgent({ name: 'pinned-agent', proxyPin: 'down-proxy', proxyId: 'proxy-1' });
    try {
      requireProxy(agent, new Set(['proxy-1']));
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof ProxyUnavailableError);
      assert.equal(err.agentName, 'pinned-agent');
      assert.equal(err.pin, 'down-proxy');
    }
  });
});

// ── sessionName ──

describe('sessionName', () => {
  test('returns tmuxSession when set', () => {
    const agent = makeAgent({ tmuxSession: 'custom-session' });
    assert.equal(sessionName(agent), 'custom-session');
  });

  test('falls back to agent-<name> when tmuxSession is null', () => {
    const agent = makeAgent({ name: 'foo', tmuxSession: null });
    assert.equal(sessionName(agent), 'agent-foo');
  });
});

// ── state group helpers ──

describe('state group helpers', () => {
  test('isRunning is true for active/idle/spawning/resuming', () => {
    for (const state of ['active', 'idle', 'spawning', 'resuming'] as const) {
      assert.equal(isRunning(makeAgent({ state })), true, state);
    }
  });

  test('isRunning is false for void/suspending/suspended/failed', () => {
    for (const state of ['void', 'suspending', 'suspended', 'failed'] as const) {
      assert.equal(isRunning(makeAgent({ state })), false, state);
    }
  });

  test('isTransitioning is true for spawning/resuming/suspending', () => {
    for (const state of ['spawning', 'resuming', 'suspending'] as const) {
      assert.equal(isTransitioning(makeAgent({ state })), true, state);
    }
  });

  test('isTransitioning is false for active/idle', () => {
    for (const state of ['active', 'idle'] as const) {
      assert.equal(isTransitioning(makeAgent({ state })), false, state);
    }
  });

  test('canSuspend is true for active/idle only', () => {
    assert.equal(canSuspend(makeAgent({ state: 'active' })), true);
    assert.equal(canSuspend(makeAgent({ state: 'idle' })), true);
    assert.equal(canSuspend(makeAgent({ state: 'suspended' })), false);
  });

  test('canResume is true for suspended/failed only', () => {
    assert.equal(canResume(makeAgent({ state: 'suspended' })), true);
    assert.equal(canResume(makeAgent({ state: 'failed' })), true);
    assert.equal(canResume(makeAgent({ state: 'active' })), false);
  });
});
