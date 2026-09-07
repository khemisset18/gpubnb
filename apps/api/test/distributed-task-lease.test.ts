import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithDistributedTaskLease } from '../src/distributed-task-lease.js';

class FakeRedis {
  private readonly values = new Map<string, string>();
  setCalls = 0;
  evalCalls: Array<{ key: string; token: string; ttl?: string }> = [];

  async set(key: string, token: string, mode: string, ttl: number, condition: string): Promise<'OK' | null> {
    assert.equal(mode, 'PX');
    assert.ok(ttl >= 5_000);
    assert.equal(condition, 'NX');
    this.setCalls += 1;
    if (this.values.has(key)) return null;
    this.values.set(key, token);
    return 'OK';
  }

  async eval(script: string, _keyCount: number, key: string, token: string, ttl?: string): Promise<number> {
    this.evalCalls.push({ key, token, ttl });
    if (this.values.get(key) !== token) return 0;
    if (script.includes('PEXPIRE')) return 1;
    if (script.includes("redis.call('DEL'")) {
      this.values.delete(key);
      return 1;
    }
    throw new Error('unexpected_script');
  }

  occupy(key: string, token = 'other-owner'): void {
    this.values.set(key, token);
  }

  steal(key: string): void {
    this.values.set(key, 'successor-owner');
  }

  value(key: string): string | undefined {
    return this.values.get(key);
  }
}

test('only the lease owner executes and the lease is released afterward', async () => {
  const redis = new FakeRedis();
  let executions = 0;
  const result = await runWithDistributedTaskLease(redis as never, 'booking-reconcile', async () => {
    executions += 1;
    return 42;
  });

  assert.deepEqual(result, { status: 'executed', value: 42, leaseLost: false });
  assert.equal(executions, 1);
  assert.equal(redis.value('gpubnb:task-lease:booking-reconcile'), undefined);
  assert.equal(redis.evalCalls.some((call) => call.ttl === undefined), true, 'release must use compare-and-delete');
});

test('a competing owner makes the task skip without side effects', async () => {
  const redis = new FakeRedis();
  redis.occupy('gpubnb:task-lease:booking-reconcile');
  let executed = false;

  const result = await runWithDistributedTaskLease(redis as never, 'booking-reconcile', async () => {
    executed = true;
  });

  assert.deepEqual(result, { status: 'skipped_locked' });
  assert.equal(executed, false);
  assert.equal(redis.evalCalls.length, 0);
});

test('release never deletes a successor lease after ownership changes', async () => {
  const redis = new FakeRedis();
  const key = 'gpubnb:task-lease:booking-reconcile';

  const result = await runWithDistributedTaskLease(redis as never, 'booking-reconcile', async () => {
    redis.steal(key);
    return 'done';
  });

  assert.equal(result.status, 'executed');
  assert.equal(redis.value(key), 'successor-owner');
});

test('renewal detects ownership loss without deleting the successor', async () => {
  const redis = new FakeRedis();
  const key = 'gpubnb:task-lease:booking-reconcile';

  const result = await runWithDistributedTaskLease(
    redis as never,
    'booking-reconcile',
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      redis.steal(key);
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      return 'done';
    },
    { ttlMs: 5_000, renewalMs: 1_000 },
  );

  assert.deepEqual(result, { status: 'executed', value: 'done', leaseLost: true });
  assert.equal(redis.value(key), 'successor-owner');
  assert.equal(redis.evalCalls.some((call) => call.ttl === '5000'), true, 'renewal must compare owner before extending TTL');
});

test('a task finishing after its last confirmed TTL is marked lease-lost', async () => {
  const redis = new FakeRedis();
  let now = 10_000;
  const result = await runWithDistributedTaskLease(
    redis as never,
    'booking-reconcile',
    async () => {
      now += 5_000;
      return 'late';
    },
    { ttlMs: 5_000, renewalMs: 1_000, now: () => now },
  );

  assert.deepEqual(result, { status: 'executed', value: 'late', leaseLost: true });
});

test('invalid task names fail closed before touching Redis', async () => {
  const redis = new FakeRedis();
  await assert.rejects(
    () => runWithDistributedTaskLease(redis as never, '../bad', async () => undefined),
    /invalid_distributed_task_name/,
  );
  assert.equal(redis.setCalls, 0);
});
