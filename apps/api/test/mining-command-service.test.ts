import assert from 'node:assert/strict';
import test from 'node:test';

import { requestMiningStart, requestMiningStop } from '../src/mining-command-service.js';

const resource = (overrides: Record<string, unknown> = {}) => ({
  resourceId: 'resource_00000001',
  machineId: 'machine_00000001',
  ownerId: 'owner_00000001',
  kind: 'GPU',
  enabled: true,
  quarantined: false,
  runtimeState: 'IDLE',
  activeRentalId: null,
  hardwareUuid: 'GPU-aaaaaaaa',
  gpuVendor: 'NVIDIA',
  mode: 'OWNER_POOL',
  profileId: 'lolminer_etchash',
  walletAddress: 'wallet.example-123',
  workerName: 'worker_1',
  ownerPoolEndpoint: 'stratum+tcp://pool.example.com:4444',
  ownerPoolSecretRef: null,
  maximumTemperatureC: 94,
  maximumPowerWatts: 180,
  version: 3,
  ...overrides,
});

function fakeDb(row = resource()) {
  let queryCount = 0;
  const writes: unknown[] = [];
  const tx = {
    $queryRaw: async () => {
      queryCount += 1;
      if (queryCount === 1 || queryCount === 2) return [row];
      if (queryCount === 3) return [{ sequence: 9n }];
      throw new Error(`unexpected_query_${queryCount}`);
    },
    $executeRaw: async (query: unknown) => { writes.push(query); return 1; },
  };
  const db = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  return { db: db as any, writes };
}

function fakeRedis(existingLease: Record<string, string> | null = null, acquiredFence = '17') {
  let evalCalls = 0;
  const redis = {
    eval: async (_script: string, numberOfKeys: number, ..._args: unknown[]) => {
      evalCalls += 1;
      if (numberOfKeys === 2) return [1, 'lease_000000001', acquiredFence, 300000];
      return [1, '300000'];
    },
    hgetall: async () => existingLease ? { ...existingLease } : {},
    pttl: async () => existingLease ? 120000 : -2,
  };
  return { redis: redis as any, evalCalls: () => evalCalls };
}

test('owner start creates one fenced durable command from stored exact-GPU configuration', async () => {
  const { db, writes } = fakeDb();
  const { redis } = fakeRedis();
  const result = await requestMiningStart(db, redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
  });

  assert.equal(result.sequence, 9n);
  assert.ok(result.lease);
  assert.equal(result.lease.resourceId, 'resource_00000001');
  assert.equal(result.lease.fencingToken, '17');
  assert.ok(result.commandId);
  assert.match(result.commandId, /^cmd_[a-f0-9]{32}$/);
  assert.equal(result.alreadySatisfied, false);
  assert.equal(writes.length, 4);
});

test('a new fencing generation produces a new durable START identity while the same fence is deterministic', async () => {
  const first = await requestMiningStart(fakeDb().db, fakeRedis(null, '17').redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
  });
  const replayFence = await requestMiningStart(fakeDb().db, fakeRedis(null, '17').redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
  });
  const newerFence = await requestMiningStart(fakeDb().db, fakeRedis(null, '18').redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
  });

  assert.equal(first.commandId, replayFence.commandId);
  assert.notEqual(first.commandId, newerFence.commandId);
  assert.equal(first.lease?.fencingToken, '17');
  assert.equal(newerFence.lease?.fencingToken, '18');
});

test('start fails closed for an unqualified GPU vendor before durable command creation', async () => {
  const { db, writes } = fakeDb(resource({ gpuVendor: 'AMD' }));
  const { redis, evalCalls } = fakeRedis();
  await assert.rejects(
    requestMiningStart(db, redis, {
      machineId: 'machine_00000001',
      resourceId: 'resource_00000001',
      ownerId: 'owner_00000001',
    }),
    /mining_gpu_vendor_not_qualified/,
  );
  assert.equal(evalCalls(), 0);
  assert.equal(writes.length, 0);
});

test('unresolved pool secret releases an acquired lease and creates no durable command', async () => {
  const { db, writes } = fakeDb(resource({ ownerPoolSecretRef: 'secret://local/mining/pool-main' }));
  const { redis, evalCalls } = fakeRedis();
  await assert.rejects(
    requestMiningStart(db, redis, {
      machineId: 'machine_00000001',
      resourceId: 'resource_00000001',
      ownerId: 'owner_00000001',
    }),
    /miner_secret_resolution_required/,
  );
  assert.equal(evalCalls(), 2);
  assert.equal(writes.length, 0);
});

test('owner STOP is idempotent when resource is already stopped', async () => {
  const { db, writes } = fakeDb(resource({ runtimeState: 'STOPPED' }));
  const { redis, evalCalls } = fakeRedis();
  const result = await requestMiningStop(db, redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
  });
  assert.equal(result.alreadySatisfied, true);
  assert.equal(result.commandId, null);
  assert.equal(result.sequence, null);
  assert.equal(result.lease, null);
  assert.equal(evalCalls(), 0);
  assert.equal(writes.length, 0);
});

test('owner STOP renews an existing mining lease before creating the fenced command', async () => {
  const { db, writes } = fakeDb(resource({ runtimeState: 'MINING' }));
  const { redis, evalCalls } = fakeRedis({
    holderId: 'mining:resource_00000001',
    idempotencyKey: 'mining:start:resource_00000001:v3',
    leaseId: 'lease_000000001',
    fencingToken: '17',
  });
  const result = await requestMiningStop(db, redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
    requestId: 'request_00000009',
  });
  assert.equal(result.alreadySatisfied, false);
  assert.ok(result.lease);
  assert.equal(result.lease.fencingToken, '17');
  assert.equal(result.lease.ttlMs, 300000);
  assert.equal(evalCalls(), 1);
  assert.equal(writes.length, 4);
});

test('owner STOP refuses a foreign rental lease', async () => {
  const { db, writes } = fakeDb(resource({ runtimeState: 'MINING' }));
  const { redis, evalCalls } = fakeRedis({
    holderId: 'rental:session_00000001',
    idempotencyKey: 'rental:session_00000001:resource_00000001',
    leaseId: 'lease_000000001',
    fencingToken: '18',
  });
  await assert.rejects(
    requestMiningStop(db, redis, {
      machineId: 'machine_00000001',
      resourceId: 'resource_00000001',
      ownerId: 'owner_00000001',
    }),
    /mining_resource_lease_busy/,
  );
  assert.equal(evalCalls(), 0);
  assert.equal(writes.length, 0);
});
