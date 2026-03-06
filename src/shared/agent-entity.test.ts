import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionName, requireProxy, isRunning, isTransitioning, canSuspend, canResume } from './agent-entity.ts';
import type { AgentRecord } from './types.ts';

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'test',
    engine: 'claude',
    cwd: '/tmp',
    state: 'void',
    version: 1,
    spawnCount: 0,
    createdAt: new Date().toISOString(),
    proxyId: null,
    tmuxSession: null,
    sessionId: null,
    model: null,
    thinking: null,
    persona: null,
    permissions: null,
    proxyHost: null,
    task: null,
    dangerouslySkipPermissions: 0,
    reloadQueued: 0,
    reloadTask: null,
    stateBeforeShutdown: null,
    lastActivity: null,
    lastContextPct: null,
    failedAt: null,
    failureReason: null,
    ...overrides,
  };
}

describe('agent-entity helpers', () => {
  describe('sessionName', () => {
    it('returns tmuxSession when set', () => {
      const agent = makeAgent({ tmuxSession: 'custom-session' });
      assert.equal(sessionName(agent), 'custom-session');
    });

    it('returns agent-{name} when tmuxSession is null', () => {
      const agent = makeAgent({ name: 'my-agent', tmuxSession: null });
      assert.equal(sessionName(agent), 'agent-my-agent');
    });
  });

  describe('requireProxy', () => {
    it('returns proxyId when set', () => {
      const agent = makeAgent({ proxyId: 'p1' });
      assert.equal(requireProxy(agent), 'p1');
    });

    it('throws when proxyId is null', () => {
      const agent = makeAgent({ proxyId: null });
      assert.throws(() => requireProxy(agent), /no proxy/);
    });
  });

  describe('isRunning', () => {
    for (const state of ['active', 'idle', 'spawning', 'resuming'] as const) {
      it(`returns true for ${state}`, () => {
        assert.equal(isRunning(makeAgent({ state })), true);
      });
    }

    for (const state of ['void', 'suspended', 'failed', 'suspending'] as const) {
      it(`returns false for ${state}`, () => {
        assert.equal(isRunning(makeAgent({ state })), false);
      });
    }
  });

  describe('isTransitioning', () => {
    for (const state of ['spawning', 'resuming', 'suspending'] as const) {
      it(`returns true for ${state}`, () => {
        assert.equal(isTransitioning(makeAgent({ state })), true);
      });
    }

    for (const state of ['void', 'active', 'idle', 'suspended', 'failed'] as const) {
      it(`returns false for ${state}`, () => {
        assert.equal(isTransitioning(makeAgent({ state })), false);
      });
    }
  });

  describe('canSuspend', () => {
    for (const state of ['active', 'idle'] as const) {
      it(`returns true for ${state}`, () => {
        assert.equal(canSuspend(makeAgent({ state })), true);
      });
    }

    for (const state of ['void', 'suspended', 'failed', 'spawning', 'resuming', 'suspending'] as const) {
      it(`returns false for ${state}`, () => {
        assert.equal(canSuspend(makeAgent({ state })), false);
      });
    }
  });

  describe('canResume', () => {
    for (const state of ['suspended', 'failed'] as const) {
      it(`returns true for ${state}`, () => {
        assert.equal(canResume(makeAgent({ state })), true);
      });
    }

    for (const state of ['void', 'active', 'idle', 'spawning', 'resuming', 'suspending'] as const) {
      it(`returns false for ${state}`, () => {
        assert.equal(canResume(makeAgent({ state })), false);
      });
    }
  });
});
