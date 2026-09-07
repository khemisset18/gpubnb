import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithDistributedTaskLease } from '../src/distributed-task-lease.js';

class FakeRedis {
  readonly values = new Map<string, string>();
  releaseCalls = 0;

  async set(key: string, value: string, _px: 'PX', _ttl: number, _nx: 'NX') {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async eval(script: string, _numKeys: number, key: string, token: string, ttl?: string) {
    const current = this.values.get(key);
    if (script.includes('PEXPIRE')) return current === token && Boolean(ttl) ? 1 : 0;
    if (script.includes("redis.call('DEL'")) {
      this.releaseCalls += 1;
      if (current !== token) return 0;
      this.values.delete(key);
      return 1;
    }
    throw new Error('unexpected_script');
  }
}

test('runs the task only for the lease owner and releases with compare-and-delete', async () => {
  const redis = new FakeRedis();
  const key = 'gpubnb:task:offline-sweep';

  const first = await runWithDistributedTaskLease(redis as never, key, 3_000, async () => 'done');
  assert.deepEqual(first, { acquired: true, value: 'done', leaseLost: false });
  assert.equal(redis.values.has(key), false);
  assert.equal(redis.releaseCalls, 1);
});

test('skips the task when another process already owns the lease', async () => {
  const redis = new FakeRedis();
  const key = 'gpubnb:task:booking-reconcile';
  redis.values.set(key, 'another-owner');
  let ran = false;

  const result = await runWithDistributedTaskLease(redis as never, key, 3_000, async () => {
    ran = true;
  });

  assert.deepEqual(result, { acquired: false });
  assert.equal(ran, false);
  assert.equal(redis.values.get(key), 'another-owner');
});

test('rejects unsafe lease configuration before touching Redis', async () => {
  const redis = new FakeRedis();
  await assert.rejects(
    () => runWithDistributedTaskLease(redis as never, 'not-namespaced', 3_000, async () => undefined),
    /invalid_distributed_task_lease_key/,
  );
  await assert.rejects(
    () => runWithDistributedTaskLease(redis as never, 'gpubnb:task:test', 2_999, async () => undefined),
    /distributed_task_lease_too_short/,
  );
});
