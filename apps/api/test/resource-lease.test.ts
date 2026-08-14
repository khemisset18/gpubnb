import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireResourceLease,
  readResourceLease,
  redisHashTag,
  releaseResourceLease,
  renewResourceLease,
  resourceFenceKey,
  resourceLeaseKey,
  type ResourceLeaseRedis,
} from '../src/resource-lease.js';

class FakeLeaseRedis implements ResourceLeaseRedis {
  private readonly leases = new Map<string, Record<string, string>>();
  private readonly ttls = new Map<string, number>();
  private readonly fences = new Map<string, bigint>();

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (numberOfKeys === 2) {
      const leaseKey = String(args[0]);
      const fenceKey = String(args[1]);
      const holderId = String(args[2]);
      const idempotencyKey = String(args[3]);
      const requestedLeaseId = String(args[4]);
      const ttlMs = Number(args[5]);
      const current = this.leases.get(leaseKey);
      if (current) {
        if (current.holderId === holderId && current.idempotencyKey === idempotencyKey) {
          this.ttls.set(leaseKey, ttlMs);
          return [2, current.leaseId, current.fencingToken, ttlMs];
        }
        return [0, current.leaseId, current.fencingToken, this.ttls.get(leaseKey) ?? 0];
      }
      const fence = (this.fences.get(fenceKey) ?? 0n) + 1n;
      this.fences.set(fenceKey, fence);
      this.leases.set(leaseKey, {
        holderId,
        idempotencyKey,
        leaseId: requestedLeaseId,
        fencingToken: fence.toString(),
      });
      this.ttls.set(leaseKey, ttlMs);
      return [1, requestedLeaseId, fence.toString(), ttlMs];
    }

    assert.equal(numberOfKeys, 1);
    const leaseKey = String(args[0]);
    const current = this.leases.get(leaseKey);
    if (!current) return [0, 'MISSING'];
    const leaseId = String(args[1]);
    const holderId = String(args[2]);
    const fencingToken = String(args[3]);
    if (current.leaseId !== leaseId || current.holderId !== holderId || current.fencingToken !== fencingToken) {
      return [0, 'STALE_LEASE'];
    }
    if (args.length === 5) {
      const ttlMs = Number(args[4]);
      this.ttls.set(leaseKey, ttlMs);
      return [1, ttlMs];
    }
    this.leases.delete(leaseKey);
    this.ttls.delete(leaseKey);
    return [1, '0'];
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...(this.leases.get(key) ?? {}) };
  }

  async pttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -2;
  }
}

test('lease and fence keys are guaranteed to share a Redis Cluster slot', () => {
  const lease = resourceLeaseKey('gpu:machine_0001:0');
  const fence = resourceFenceKey('gpu:machine_0001:0');
  assert.equal(redisHashTag(lease), 'gpu:machine_0001:0');
  assert.equal(redisHashTag(lease), redisHashTag(fence));
});

test('lease acquisition is idempotent and produces monotonic fencing tokens', async () => {
  const redis = new FakeLeaseRedis();
  const first = await acquireResourceLease(redis, {
    resourceId: 'gpu:machine_0001:0',
    holderId: 'booking_00000001',
    idempotencyKey: 'booking:00000001:gpu0',
  });
  assert.equal(first.status, 'ACQUIRED');
  if (first.status === 'BUSY') throw new Error('unexpected_busy');
  assert.equal(first.lease.fencingToken, '1');

  const replay = await acquireResourceLease(redis, {
    resourceId: 'gpu:machine_0001:0',
    holderId: 'booking_00000001',
    idempotencyKey: 'booking:00000001:gpu0',
  });
  assert.equal(replay.status, 'EXISTING');
  if (replay.status === 'BUSY') throw new Error('unexpected_busy');
  assert.equal(replay.lease.leaseId, first.lease.leaseId);
  assert.equal(replay.lease.fencingToken, '1');

  const busy = await acquireResourceLease(redis, {
    resourceId: 'gpu:machine_0001:0',
    holderId: 'booking_00000002',
    idempotencyKey: 'booking:00000002:gpu0',
  });
  assert.equal(busy.status, 'BUSY');

  const staleRelease = await releaseResourceLease(redis, {
    resourceId: first.lease.resourceId,
    holderId: first.lease.holderId,
    leaseId: first.lease.leaseId,
    fencingToken: '2',
  });
  assert.deepEqual(staleRelease, { accepted: false, reason: 'STALE_LEASE' });

  const renewed = await renewResourceLease(redis, {
    resourceId: first.lease.resourceId,
    holderId: first.lease.holderId,
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
    ttlSeconds: 90,
  });
  assert.deepEqual(renewed, { accepted: true, ttlMs: 90_000 });

  assert.deepEqual(await releaseResourceLease(redis, {
    resourceId: first.lease.resourceId,
    holderId: first.lease.holderId,
    leaseId: first.lease.leaseId,
    fencingToken: first.lease.fencingToken,
  }), { accepted: true, ttlMs: 0 });

  const successor = await acquireResourceLease(redis, {
    resourceId: 'gpu:machine_0001:0',
    holderId: 'booking_00000002',
    idempotencyKey: 'booking:00000002:gpu0',
  });
  assert.equal(successor.status, 'ACQUIRED');
  if (successor.status === 'BUSY') throw new Error('unexpected_busy');
  assert.equal(successor.lease.fencingToken, '2');
  assert.equal((await readResourceLease(redis, successor.lease.resourceId))?.leaseId, successor.lease.leaseId);
});
