import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LockManager } from './lock.ts';

describe('LockManager (SQLite-based)', () => {
  let db: DatabaseSync;
  let mgr: LockManager;

  before(() => {
    db = new DatabaseSync(':memory:');
    mgr = new LockManager(db);
  });

  after(() => {
    db.close();
  });

  it('lock returns a unique lockId', async () => {
    const id1 = await mgr.lock('agent-a');
    mgr.unlock('agent-a', id1);

    const id2 = await mgr.lock('agent-a');
    mgr.unlock('agent-a', id2);

    assert.notEqual(id1, id2);
    assert.ok(id1.startsWith('lock-'));
    assert.ok(id2.startsWith('lock-'));
  });

  it('lock blocks until previous holder releases', async () => {
    const order: number[] = [];

    const id1 = await mgr.lock('agent-b');

    const p2 = mgr.lock('agent-b').then((id) => {
      order.push(2);
      mgr.unlock('agent-b', id);
    });

    // Give waiter time to start polling
    await new Promise((r) => setTimeout(r, 100));
    order.push(1);
    mgr.unlock('agent-b', id1);

    await p2;
    assert.deepEqual(order, [1, 2]);
  });

  it('lock times out with holder info', async () => {
    const id = await mgr.lock('agent-c');

    await assert.rejects(
      () => mgr.lock('agent-c', 30_000, 200),
      (err: Error) => {
        assert.ok(err.message.includes('Lock timeout'));
        assert.ok(err.message.includes('agent-c'));
        assert.ok(err.message.includes(id)); // shows holder's lockId
        return true;
      },
    );

    mgr.unlock('agent-c', id);
  });

  it('unlock with wrong lockId is a no-op', async () => {
    const id = await mgr.lock('agent-d');
    mgr.unlock('agent-d', 'wrong-id');

    // Lock should still be held
    assert.equal(mgr.isLocked('agent-d'), true);

    mgr.unlock('agent-d', id);
    assert.equal(mgr.isLocked('agent-d'), false);
  });

  it('expired locks are automatically cleared', async () => {
    // Lock with very short duration (100ms)
    const id = await mgr.lock('agent-e', 100);
    assert.equal(mgr.isLocked('agent-e'), true);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 150));

    // isLocked should now return false (expired)
    assert.equal(mgr.isLocked('agent-e'), false);

    // New lock should be acquirable (clears expired on acquire)
    const id2 = await mgr.lock('agent-e');
    assert.notEqual(id, id2);
    mgr.unlock('agent-e', id2);
  });

  it('withLock returns the function result', async () => {
    const result = await mgr.withLock('agent-return', async () => {
      return 42;
    });
    assert.equal(result, 42);
  });

  it('withLock releases on async rejection', async () => {
    await assert.rejects(
      () => mgr.withLock('agent-async-err', async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('async boom');
      }),
      /async boom/,
    );
    assert.equal(mgr.isLocked('agent-async-err'), false);
  });

  it('withLock executes function under lock', async () => {
    let executed = false;

    await mgr.withLock('agent-f', () => {
      executed = true;
      assert.equal(mgr.isLocked('agent-f'), true);
    });

    assert.equal(executed, true);
    assert.equal(mgr.isLocked('agent-f'), false);
  });

  it('withLock releases on error', async () => {
    await assert.rejects(
      () => mgr.withLock('agent-g', () => { throw new Error('boom'); }),
      /boom/,
    );

    assert.equal(mgr.isLocked('agent-g'), false);
  });

  it('withLock serializes concurrent calls', async () => {
    const results: number[] = [];

    const p1 = mgr.withLock('serial', async () => {
      await new Promise((r) => setTimeout(r, 100));
      results.push(1);
    });

    const p2 = mgr.withLock('serial', async () => {
      results.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepEqual(results, [1, 2]);
  });

  it('forceUnlock clears regardless of lockId', async () => {
    await mgr.lock('agent-h');
    assert.equal(mgr.isLocked('agent-h'), true);

    mgr.forceUnlock('agent-h');
    assert.equal(mgr.isLocked('agent-h'), false);
  });

  it('listLocks returns active locks', async () => {
    const id = await mgr.lock('agent-list-test');
    const locks = mgr.listLocks();
    const found = locks.find((l) => l.agentName === 'agent-list-test');
    assert.ok(found);
    assert.equal(found!.lockedBy, id);

    mgr.unlock('agent-list-test', id);
    const after = mgr.listLocks();
    assert.ok(!after.find((l) => l.agentName === 'agent-list-test'));
  });

  it('different agents can be locked independently', async () => {
    const id1 = await mgr.lock('independent-a');
    const id2 = await mgr.lock('independent-b');

    assert.equal(mgr.isLocked('independent-a'), true);
    assert.equal(mgr.isLocked('independent-b'), true);

    mgr.unlock('independent-a', id1);
    assert.equal(mgr.isLocked('independent-a'), false);
    assert.equal(mgr.isLocked('independent-b'), true);

    mgr.unlock('independent-b', id2);
  });
});
