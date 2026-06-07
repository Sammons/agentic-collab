/**
 * RFC-008 PR-E: unit tests for deriveTelegramStatus (pure bot-status logic).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTelegramStatus } from './telegram-status.ts';
import type { AgentRecord, AgentTelegramConfig } from '../shared/types.ts';

function agent(name: string, telegram: AgentTelegramConfig | null): Pick<AgentRecord, 'name' | 'agentTelegram'> {
  return { name, agentTelegram: telegram };
}

describe('deriveTelegramStatus', () => {
  it('is disabled when unconfigured (no telegram block)', () => {
    const s = deriveTelegramStatus(agent('a', null), false, false);
    assert.equal(s.status, 'disabled');
    assert.equal(s.configured, false);
    assert.equal(s.inbound, false);
    assert.equal(s.routing, null);
    assert.equal(s.chatId, null);
  });

  it('is disabled when configured but inbound:false (outbound-only)', () => {
    const s = deriveTelegramStatus(agent('a', { chatId: '-100', inbound: false, routing: 'self' }), true, false);
    assert.equal(s.status, 'disabled');
    assert.equal(s.configured, true);
    assert.equal(s.inbound, false);
  });

  it('treats the string "false" inbound as outbound-only (nested parser coercion)', () => {
    const cfg = { chatId: '-100', inbound: 'false' as unknown as boolean, routing: 'self' as const };
    const s = deriveTelegramStatus(agent('a', cfg), true, true);
    assert.equal(s.inbound, false);
    assert.equal(s.status, 'disabled');
  });

  it('is token-missing when configured + inbound but no token', () => {
    const s = deriveTelegramStatus(agent('a', { chatId: '-100', routing: 'self' }), false, false);
    assert.equal(s.status, 'token-missing');
    assert.equal(s.inbound, true); // defaults true when undefined
    assert.equal(s.hasToken, false);
  });

  it('is running when configured + inbound + token + polling', () => {
    const s = deriveTelegramStatus(agent('a', { chatId: '-100', routing: 'prefix' }), true, true);
    assert.equal(s.status, 'running');
    assert.equal(s.polling, true);
    assert.equal(s.routing, 'prefix');
    assert.equal(s.chatId, '-100');
  });

  it('is idle when configured + inbound + token but not polling (dedup/pre-restart)', () => {
    const s = deriveTelegramStatus(agent('a', { chatId: '-100', routing: 'self' }), true, false);
    assert.equal(s.status, 'idle');
    assert.equal(s.hasToken, true);
    assert.equal(s.polling, false);
  });

  it('echoes routing and chatId verbatim for the indicator', () => {
    const s = deriveTelegramStatus(agent('almanac', { chatId: '-100123', routing: 'passthrough' }), true, true);
    assert.deepEqual(
      { agent: s.agent, routing: s.routing, chatId: s.chatId },
      { agent: 'almanac', routing: 'passthrough', chatId: '-100123' },
    );
  });

  it('never exposes a token field on the output shape', () => {
    const s = deriveTelegramStatus(agent('a', { chatId: '-100', routing: 'self' }), true, true);
    assert.ok(!('token' in s), 'status object must not carry a token field');
  });
});
