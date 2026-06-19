import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pruneSelection } from './state.ts';

describe('pruneSelection', () => {
  it('removes selected names not present in the roster', () => {
    const selected = new Set(['a', 'b', 'gone']);
    const removed = pruneSelection(selected, [{ name: 'a' }, { name: 'b' }]);
    assert.equal(removed, 1);
    assert.deepEqual([...selected], ['a', 'b']);
  });

  it('keeps names still present in the roster', () => {
    const selected = new Set(['a', 'b']);
    const removed = pruneSelection(selected, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    assert.equal(removed, 0);
    assert.deepEqual([...selected], ['a', 'b']);
  });

  it('reproduces the selected-greater-than-total case (roster shrank by one)', () => {
    // 28 selected; roster shrinks to 27 because one was destroyed.
    const selected = new Set(Array.from({ length: 28 }, (_, i) => `agent-${i}`));
    const roster = Array.from({ length: 27 }, (_, i) => ({ name: `agent-${i}` }));
    const removed = pruneSelection(selected, roster);
    assert.equal(removed, 1);
    assert.equal(selected.size, 27);
    assert.equal(selected.has('agent-27'), false);
    assert.ok(selected.size <= roster.length, 'selection must not exceed roster after prune');
  });

  it('prunes everything when the roster is empty', () => {
    const selected = new Set(['a', 'b']);
    const removed = pruneSelection(selected, []);
    assert.equal(removed, 2);
    assert.equal(selected.size, 0);
  });

  it('no-ops on an empty selection', () => {
    const selected = new Set<string>();
    const removed = pruneSelection(selected, [{ name: 'a' }]);
    assert.equal(removed, 0);
    assert.equal(selected.size, 0);
  });

  it('mutates in place rather than returning a new set', () => {
    const selected = new Set(['a', 'gone']);
    const result = pruneSelection(selected, [{ name: 'a' }]);
    assert.equal(typeof result, 'number');
    assert.deepEqual([...selected], ['a']);
  });
});
