/**
 * Agent lifecycle and state management tests.
 * Verifies agent CRUD via test control API, state transitions, and field serialization.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('Agent Lifecycle', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Default fixtures ──

  it('default fixture has exactly 3 agents', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    assert.equal(agents.length, 3);
  });

  it('default agents are idle, active, and failed', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string; state: string }[];
    const states = agents.map((a) => a.state);
    assert.deepEqual(states, ['idle', 'active', 'failed']);
  });

  it('default agents have correct names', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    const names = agents.map((a) => a.name);
    assert.deepEqual(names, ['test-claude', 'test-codex', 'test-failed']);
  });

  // ── State transitions via set-agents ──

  it('set-agents can change agent state from idle to active', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', state: 'active' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string; state: string }[];
    const claude = agents.find((a) => a.name === 'test-claude');
    assert.equal(claude?.state, 'active');
  });

  it('set-agents broadcasts agent_update via WebSocket', async () => {
    const updatePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS agent_update timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      let gotInit = false;
      ws.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        if (parsed['type'] === 'init') {
          gotInit = true;
          // Now trigger the state change
          fetch(`${ctx.baseUrl}/test/set-agents`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([{ name: 'test-claude', state: 'spawning' }]),
          });
          return;
        }
        if (gotInit && parsed['type'] === 'agent_update') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS connection error'));
      };
    });

    const event = await updatePromise;
    assert.equal(event['type'], 'agent_update');
    const agent = event['agent'] as { name: string; state: string };
    assert.equal(agent.name, 'test-claude');
    assert.equal(agent.state, 'spawning');
  });

  // ── Adding new agents ──

  it('set-agents can add a new agent', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'brand-new-agent', engine: 'codex', state: 'void' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string; engine: string; state: string }[];
    assert.equal(agents.length, 4);
    const newAgent = agents.find((a) => a.name === 'brand-new-agent');
    assert.ok(newAgent, 'new agent should exist');
    assert.equal(newAgent.engine, 'codex');
    assert.equal(newAgent.state, 'void');
  });

  it('new agent inherits default fields from first fixture agent', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'inherited-agent', state: 'idle' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as Record<string, unknown>[];
    const agent = agents.find((a) => a['name'] === 'inherited-agent')!;
    // Should inherit cwd from the default agent template
    assert.equal(agent['cwd'], '/tmp');
    assert.equal(agent['version'], 1);
    assert.equal(agent['spawnCount'], 1);
  });

  // ── Valid state values ──

  it('all valid AgentState values are accepted', async () => {
    const validStates = ['void', 'spawning', 'active', 'idle', 'suspending', 'suspended', 'failed', 'resuming'];
    for (const state of validStates) {
      await fetch(`${ctx.baseUrl}/test/set-agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ name: 'test-claude', state }]),
      });
      const res = await fetch(`${ctx.baseUrl}/api/agents`);
      const agents = (await res.json()) as { name: string; state: string }[];
      const claude = agents.find((a) => a.name === 'test-claude');
      assert.equal(claude?.state, state, `state '${state}' should be accepted`);
    }
  });

  // ── Required AgentRecord fields ──

  it('agents have all required AgentRecord fields', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as Record<string, unknown>[];
    const requiredFields = [
      'name', 'engine', 'model', 'thinking', 'cwd', 'persona', 'permissions',
      'proxyHost', 'agentGroup', 'launchEnv', 'sortOrder',
      'hookStart', 'hookResume', 'hookCompact', 'hookExit',
      'hookInterrupt', 'hookSubmit', 'hookDetectSession', 'detectSessionRegex',
      'state', 'stateBeforeShutdown', 'currentSessionId', 'tmuxSession',
      'proxyId', 'lastActivity', 'lastContextPct', 'reloadQueued', 'reloadTask',
      'failedAt', 'failureReason', 'capturedVars', 'customButtons', 'indicators',
      'version', 'spawnCount', 'createdAt',
    ];

    for (const agent of agents) {
      for (const field of requiredFields) {
        assert.ok(
          field in agent,
          `agent '${agent['name'] as string}' missing field '${field}'`,
        );
      }
    }
  });

  // ── Complex fields ──

  it('agent with customButtons field serializes correctly', async () => {
    const buttons = JSON.stringify([{ label: 'Reload', action: 'reload' }]);
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', customButtons: buttons }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as Record<string, unknown>[];
    const claude = agents.find((a) => a['name'] === 'test-claude')!;
    assert.equal(claude['customButtons'], buttons);
  });

  it('agent with indicators field serializes correctly', async () => {
    const indicatorsDef = JSON.stringify([
      { id: 'oom', regex: 'out of memory', badge: 'OOM', style: 'danger' },
    ]);
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', indicators: indicatorsDef }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as Record<string, unknown>[];
    const claude = agents.find((a) => a['name'] === 'test-claude')!;
    assert.equal(claude['indicators'], indicatorsDef);
  });

  it('agent with capturedVars field serializes correctly', async () => {
    const vars = { SESSION_ID: 'abc-123', CONTEXT_PCT: '42' };
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', capturedVars: vars }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as Record<string, unknown>[];
    const claude = agents.find((a) => a['name'] === 'test-claude')!;
    assert.deepEqual(claude['capturedVars'], vars);
  });

  // ── set-agents without name is ignored ──

  it('set-agents ignores entries without a name field', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ state: 'active' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    // Should still have exactly 3 default agents
    assert.equal(agents.length, 3);
  });
});
