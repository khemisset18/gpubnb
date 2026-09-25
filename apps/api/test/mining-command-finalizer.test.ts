import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalizeMiningTerminalAck,
  reconcileUncertainMiningDelivery,
} from '../src/mining-command-finalizer.js';

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

function fakeDb(runtimeState: string, activeRentalId: string | null = null, hardwareUuid = 'GPU-aaaaaaaa') {
  const transitions: any[] = [];
  const writes: any[] = [];
  const tx = {
    $queryRaw: async () => [{ runtimeState, activeRentalId, hardwareUuid }],
    $executeRaw: async (query: any) => { writes.push(query); return 1; },
    miningResource: {
      updateMany: async (args: any) => { transitions.push(args); return { count: 1 }; },
    },
  };
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as any;
  return { db, transitions, writes };
}


function fakeReconciliationDb(
  row: any,
  runtimeState: string,
  activeRentalId: string | null = null,
  hardwareUuid = 'GPU-aaaaaaaa',
) {
  const transitions: any[] = [];
  const writes: any[] = [];
  let discoveryQueries = 0;
  const tx = {
    $queryRaw: async () => [{ runtimeState, activeRentalId, hardwareUuid }],
    $executeRaw: async (query: any) => { writes.push(query); return 1; },
    miningResource: {
      updateMany: async (args: any) => { transitions.push(args); return { count: 1 }; },
    },
  };
  const db = {
    $queryRaw: async () => {
      discoveryQueries += 1;
      return [row];
    },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as any;
  return { db, transitions, writes, discoveryQueries: () => discoveryQueries };
}

function uncertainCommand(
  commandType: 'start_mining' | 'stop_mining',
  status: 'PENDING' | 'LEASED' | 'DEAD' | 'EXPIRED' = 'DEAD',
) {
  return {
    ...command(commandType),
    status,
    expiresAt: new Date(Date.now() - 60_000),
  };
}

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

test('successful START finalizes STARTING to MINING and deliberately keeps the mining lease', async () => {
  const { db, transitions } = fakeDb('STARTING');
  const { redis, releases } = fakeRedis();
  const outcome = await finalizeMiningTerminalAck(db, redis, command('start_mining'), { status: 'SUCCEEDED' });
  assert.equal(outcome, 'UPDATED');
  assert.equal(transitions[0].data.runtimeState, 'MINING');
  assert.equal(releases(), 0);
});

test('rejected START returns to STOPPED and releases lease without quarantine', async () => {
  const { db, transitions } = fakeDb('STARTING');
  const { redis, releases } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('start_mining'), { status: 'REJECTED', detailCode: 'mining_runtime_generation_stale' });
  assert.equal(transitions[0].data.runtimeState, 'STOPPED');
  assert.equal(transitions[0].data.quarantined, undefined);
  assert.equal(releases(), 1);
});

test('failed START quarantines because process outcome is not verified and releases lease', async () => {
  const { db, transitions } = fakeDb('STARTING');
  const { redis, releases } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('start_mining'), { status: 'FAILED', detailCode: 'miner_process_identity_mismatch' });
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
  assert.equal(transitions[0].data.quarantined, true);
  assert.equal(releases(), 1);
});

test('successful STOP finalizes VERIFYING_STOP to STOPPED and releases lease', async () => {
  const { db, transitions } = fakeDb('VERIFYING_STOP');
  const { redis, releases } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('stop_mining'), { status: 'SUCCEEDED', detailCode: 'mining_resource_stop_verified' });
  assert.equal(transitions[0].data.runtimeState, 'STOPPED');
  assert.equal(releases(), 1);
});

test('failed STOP quarantines and keeps lease for recovery fencing', async () => {
  const { db, transitions } = fakeDb('VERIFYING_STOP');
  const { redis, releases } = fakeRedis();
  await finalizeMiningTerminalAck(db, redis, command('stop_mining'), { status: 'FAILED', detailCode: 'mining_resource_stop_unverified' });
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
  assert.equal(transitions[0].data.quarantined, true);
  assert.equal(releases(), 0);
});

test('late terminal ACK is audited but cannot overwrite a newer state or release its lease', async () => {
  const { db, transitions, writes } = fakeDb('MINING');
  const { redis, releases } = fakeRedis();
  const outcome = await finalizeMiningTerminalAck(db, redis, command('stop_mining'), { status: 'SUCCEEDED' });
  assert.equal(outcome, 'STALE_STATE');
  assert.equal(transitions.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(releases(), 0);
});

test('late START failure cannot release the lease reused by an in-flight STOP', async () => {
  const { db, transitions, writes } = fakeDb('VERIFYING_STOP');
  const { redis, releases } = fakeRedis();
  const outcome = await finalizeMiningTerminalAck(
    db,
    redis,
    command('start_mining'),
    { status: 'FAILED', detailCode: 'late_start_failure' },
  );
  assert.equal(outcome, 'STALE_STATE');
  assert.equal(transitions.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(releases(), 0);
});

test('terminal ACK rejects hardware identity mismatch before state transition', async () => {
  const { db, transitions } = fakeDb('VERIFYING_STOP', null, 'GPU-bbbbbbbb');
  const { redis, releases } = fakeRedis();
  await assert.rejects(
    finalizeMiningTerminalAck(db, redis, command('stop_mining'), { status: 'SUCCEEDED' }),
    /mining_terminal_hardware_identity_conflict/,
  );
  assert.equal(transitions.length, 0);
  assert.equal(releases(), 0);
});

test('terminal ACK rejects a fence mismatch before touching DB or Redis', async () => {
  let transactions = 0;
  const db = { $transaction: async () => { transactions += 1; } } as any;
  const { redis, releases } = fakeRedis();
  const bad = command('stop_mining');
  bad.payload.payload.runtimeGeneration = '18';
  await assert.rejects(
    finalizeMiningTerminalAck(db, redis, bad, { status: 'SUCCEEDED' }),
    /mining_terminal_fence_mismatch/,
  );
  assert.equal(transactions, 0);
  assert.equal(releases(), 0);
});

test('DEAD START without terminal ACK quarantines instead of assuming STOPPED or MINING', async () => {
  const row = uncertainCommand('start_mining', 'DEAD');
  const { db, transitions, writes, discoveryQueries } = fakeReconciliationDb(row, 'STARTING');
  const result = await reconcileUncertainMiningDelivery(db, new Date());

  assert.deepEqual(result, { scanned: 1, updated: 1, stale: 0 });
  assert.equal(discoveryQueries(), 1);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].where.runtimeState, 'STARTING');
  assert.equal(transitions[0].where.activeRentalId, null);
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
  assert.equal(transitions[0].data.quarantined, true);
  assert.equal(writes.length, 3);
});

test('expired STOP without terminal ACK quarantines VERIFYING_STOP and terminalizes the command', async () => {
  const row = uncertainCommand('stop_mining', 'LEASED');
  const { db, transitions, writes } = fakeReconciliationDb(row, 'VERIFYING_STOP');
  const result = await reconcileUncertainMiningDelivery(db, new Date());

  assert.deepEqual(result, { scanned: 1, updated: 1, stale: 0 });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].where.runtimeState, 'VERIFYING_STOP');
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
  assert.equal(writes.length, 3);
});

test('uncertain mining delivery cannot overwrite a rental-owned resource', async () => {
  const row = uncertainCommand('start_mining', 'EXPIRED');
  const { db, transitions, writes } = fakeReconciliationDb(
    row,
    'STARTING',
    'session_00000001',
  );
  const result = await reconcileUncertainMiningDelivery(db, new Date());

  assert.deepEqual(result, { scanned: 1, updated: 0, stale: 1 });
  assert.equal(transitions.length, 0);
  assert.equal(writes.length, 0);
});

test('uncertain mining delivery rejects changed GPU hardware identity before lifecycle mutation', async () => {
  const row = uncertainCommand('stop_mining', 'DEAD');
  const { db, transitions, writes } = fakeReconciliationDb(
    row,
    'VERIFYING_STOP',
    null,
    'GPU-bbbbbbbb',
  );
  await assert.rejects(
    reconcileUncertainMiningDelivery(db, new Date()),
    /mining_terminal_hardware_identity_conflict/,
  );
  assert.equal(transitions.length, 0);
  assert.equal(writes.length, 0);
});
