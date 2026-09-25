import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeMiningTerminalAck } from '../src/mining-command-finalizer.js';

const command = (commandType: 'start_mining' | 'stop_mining') => ({
  id: `command_${commandType}_0001`,
  machineId: 'machine_00000001',
  commandType,
  sequence: 7n,
  idempotencyKey: `mining:${commandType}:0001`,
  expiresAt: new Date(Date.now() + 60_000),
  payload: {
    lease: {
      resourceId: 'resource_00000001',
      holderId: 'mining:resource_00000001',
      leaseId: 'lease_000000001',
      fencingToken: '17',
    },
    payload: {
      resourceId: 'resource_00000001',
      hardwareUuid: 'GPU-aaaaaaaa',
      runtimeGeneration: '17',
    },
  },
  status: 'LEASED',
  attempts: 1,
  availableAt: new Date(),
  leaseOwner: 'delivery_worker_0001',
  leaseExpiresAt: new Date(Date.now() + 30_000),
  createdAt: new Date(),
}) as any;

function fakeRedis() {
  let releases = 0;
  return {
    redis: {
      eval: async (_script: string, numberOfKeys: number) => {
        assert.equal(numberOfKeys, 1);
        releases += 1;
        return [1, '0'];
      },
      hgetall: async () => ({}),
      pttl: async () => -2,
    } as any,
    releases: () => releases,
  };
}

test('successful START finalizes only STARTING resource to MINING and releases exact lease', async () => {
  let query: any;
  const db = { $queryRaw: async (value: any) => { query = value; return [{ id: 'resource_00000001' }]; } } as any;
  const { redis, releases } = fakeRedis();
  const outcome = await finalizeMiningTerminalAck(db, redis, command('start_mining'), { status: 'SUCCEEDED' });
  assert.equal(outcome, 'UPDATED');
  assert.equal(releases(), 1);
  assert.ok(query.values.includes('STARTING'));
  assert.ok(query.values.includes('MINING'));
  assert.ok(query.values.includes('resource_00000001'));
  assert.ok(query.values.includes('GPU-aaaaaaaa'));
});

test('rejected START returns to STOPPED without quarantine', async () => {
  let query: any;
  const db = { $queryRaw: async (value: any) => { query = value; return [{ id: 'resource_00000001' }]; } } as any;
  const { redis } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('start_mining'), { status: 'REJECTED', detailCode: 'mining_runtime_generation_stale' });
  assert.ok(query.values.includes('STARTING'));
  assert.ok(query.values.includes('STOPPED'));
  assert.ok(query.values.includes(false));
});

test('failed START quarantines because process outcome was not verified', async () => {
  let query: any;
  const db = { $queryRaw: async (value: any) => { query = value; return [{ id: 'resource_00000001' }]; } } as any;
  const { redis } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('start_mining'), { status: 'FAILED', detailCode: 'miner_process_identity_mismatch' });
  assert.ok(query.values.includes('QUARANTINED'));
  assert.ok(query.values.includes(true));
});

test('successful STOP finalizes VERIFYING_STOP to STOPPED', async () => {
  let query: any;
  const db = { $queryRaw: async (value: any) => { query = value; return [{ id: 'resource_00000001' }]; } } as any;
  const { redis } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('stop_mining'), { status: 'SUCCEEDED', detailCode: 'mining_resource_stop_verified' });
  assert.ok(query.values.includes('VERIFYING_STOP'));
  assert.ok(query.values.includes('STOPPED'));
});

test('late terminal ACK cannot overwrite a newer resource state', async () => {
  const db = { $queryRaw: async () => [] } as any;
  const { redis, releases } = fakeRedis();
  const outcome = await finalizeMiningTerminalAck(db, redis, command('stop_mining'), { status: 'SUCCEEDED' });
  assert.equal(outcome, 'STALE_STATE');
  assert.equal(releases(), 1);
});

test('terminal ACK rejects a fence mismatch before touching DB or Redis', async () => {
  let dbCalls = 0;
  const db = { $queryRaw: async () => { dbCalls += 1; return []; } } as any;
  const { redis, releases } = fakeRedis();
  const bad = command('stop_mining');
  bad.payload.payload.runtimeGeneration = '18';
  await assert.rejects(
    finalizeMiningTerminalAck(db, redis, bad, { status: 'SUCCEEDED' }),
    /mining_terminal_fence_mismatch/,
  );
  assert.equal(dbCalls, 0);
  assert.equal(releases(), 0);
});