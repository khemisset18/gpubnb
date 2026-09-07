import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedisCapabilityReadiness,
  verifyRedisCapabilities,
} from '../src/redis-capability-readiness.js';

class FakeRedis {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();
  streamCounter = 0;
  calls: string[] = [];
  breakCapability: string | null = null;

  async set(key: string, value: string, _mode: string, _ttl: number, nx: string) {
    this.calls.push('set');
    if (this.breakCapability === 'set') return null;
    if (nx === 'NX' && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async getdel(key: string) {
    this.calls.push('getdel');
    if (this.breakCapability === 'getdel') return null;
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async eval(_script: string, _keys: number, key: string, owner: string, arg: string) {
    this.calls.push('eval');
    if (this.breakCapability === 'eval') return 0;
    const current = this.values.get(key);
    if (current !== owner) return 0;
    if (/^\d+$/.test(arg)) return 1;
    this.values.delete(key);
    return 1;
  }

  async get(key: string) {
    this.calls.push('get');
    return this.values.get(key) ?? null;
  }

  async lpush(key: string, value: string) {
    this.calls.push('lpush');
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async rpop(key: string) {
    this.calls.push('rpop');
    if (this.breakCapability === 'list') return null;
    return this.lists.get(key)?.pop() ?? null;
  }

  async xadd(_key: string, _star: string, ..._args: string[]) {
    this.calls.push('xadd');
    if (this.breakCapability === 'stream') return null;
    this.streamCounter += 1;
    return `${Date.now()}-${this.streamCounter}`;
  }

  async del(...keys: string[]) {
    this.calls.push('del');
    for (const key of keys) {
      this.values.delete(key);
      this.lists.delete(key);
    }
    return keys.length;
  }
}

test('capability proof exercises every Redis semantic GPUbnb depends on', async () => {
  const redis = new FakeRedis();
  await verifyRedisCapabilities(redis as never);
  for (const operation of ['set', 'getdel', 'eval', 'get', 'lpush', 'rpop', 'xadd', 'del']) {
    assert.ok(redis.calls.includes(operation), `missing readiness operation ${operation}`);
  }
  assert.equal(redis.values.size, 0);
  assert.equal(redis.lists.size, 0);
});

test('capability proof fails closed when one-shot consumption is unavailable', async () => {
  const redis = new FakeRedis();
  redis.breakCapability = 'getdel';
  await assert.rejects(
    verifyRedisCapabilities(redis as never),
    /redis_capability_unavailable:getdel-first-consume/,
  );
  assert.ok(redis.calls.includes('del'), 'cleanup must run even when the probe fails');
});

test('capability proof fails closed when Streams are unavailable', async () => {
  const redis = new FakeRedis();
  redis.breakCapability = 'stream';
  await assert.rejects(
    verifyRedisCapabilities(redis as never),
    /redis_capability_unavailable:streams-xadd/,
  );
});

test('readiness caches a successful full capability proof for a bounded interval', async () => {
  const redis = new FakeRedis();
  let clock = 1_000;
  const ready = createRedisCapabilityReadiness(redis as never, 60_000, () => clock);

  await ready();
  const firstSetCount = redis.calls.filter((call) => call === 'set').length;
  await ready();
  assert.equal(redis.calls.filter((call) => call === 'set').length, firstSetCount);

  clock += 60_001;
  await ready();
  assert.ok(redis.calls.filter((call) => call === 'set').length > firstSetCount);
});

test('failed readiness proof is never cached', async () => {
  const redis = new FakeRedis();
  const ready = createRedisCapabilityReadiness(redis as never, 60_000, () => 1_000);
  redis.breakCapability = 'stream';
  await assert.rejects(ready(), /redis_capability_unavailable:streams-xadd/);
  const failedCalls = redis.calls.length;
  redis.breakCapability = null;
  await ready();
  assert.ok(redis.calls.length > failedCalls, 'a failure must be retried on the next readiness check');
});
