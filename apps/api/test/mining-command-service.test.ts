import assert from 'node:assert/strict';
import test from 'node:test';

import { requestMiningStart } from '../src/mining-command-service.js';

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

function fakeRedis() {
  let evalCalls = 0;
  const redis = {
    eval: async (_script: string, numberOfKeys: number, ..._args: unknown[]) => {
      evalCalls += 1;
      if (numberOfKeys === 2) return [1, 'lease_000000001', '17', 300000];
      return [1, '0'];
    },
    hgetall: async () => ({}),
    pttl: async () => -2,
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
  assert.equal(result.lease.resourceId, 'resource_00000001');
  assert.equal(result.lease.fencingToken, '17');
  assert.match(result.commandId, /^cmd_[a-f0-9]{32}$/);
  assert.equal(writes.length, 2);
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