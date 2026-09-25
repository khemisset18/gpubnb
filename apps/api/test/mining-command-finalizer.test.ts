import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalizeMiningTerminalAck,
  reconcileTerminalMiningCommands,
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

function terminalDb(options: {
  commandType: 'start_mining' | 'stop_mining';
  status: 'DEAD' | 'EXPIRED';
  runtimeState: string;
  activeRentalId?: string | null;
  hardwareUuid?: string | null;
  commandHardwareUuid?: string;
  fenceValid?: boolean;
  expiredCount?: number;
}) {
  const transitions: any[] = [];
  const writes: any[] = [];
  const expiryQueries: any[] = [];
  const resourceId = 'resource_00000001';
  const generation = '17';
  const row = {
    id: 'command_terminal_0001',
    machineId: 'machine_00000001',
    commandType: options.commandType,
    sequence: 9n,
    status: options.status,
    payload: {
      lease: {
        resourceId,
        holderId: 'mining:resource_00000001',
        leaseId: 'lease_000000001',
        fencingToken: options.fenceValid === false ? '18' : generation,
      },
      payload: {
        resourceId,
        hardwareUuid: options.commandHardwareUuid ?? 'GPU-aaaaaaaa',
        runtimeGeneration: generation,
      },
    },
  };
  const tx = {
    $queryRaw: async () => [{
      runtimeState: options.runtimeState,
      activeRentalId: options.activeRentalId ?? null,
      hardwareUuid: options.hardwareUuid ?? 'GPU-aaaaaaaa',
    }],
    $executeRaw: async (query: any) => { writes.push(query); return 1; },
    miningResource: {
      updateMany: async (args: any) => { transitions.push(args); return { count: 1 }; },
    },
  };
  const db = {
    $executeRaw: async (query: any) => {
      expiryQueries.push(query);
      return options.expiredCount ?? 0;
    },
    $queryRaw: async () => [row],
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as any;
  return { db, transitions, writes, expiryQueries };
}

test('DEAD START without terminal ACK quarantines instead of leaving STARTING stuck', async () => {
  const { db, transitions, writes } = terminalDb({
    commandType: 'start_mining',
    status: 'DEAD',
    runtimeState: 'STARTING',
  });
  const result = await reconcileTerminalMiningCommands(db);
  assert.deepEqual(result, { expired: 0, quarantined: 1, superseded: 0 });
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
  assert.equal(transitions[0].data.quarantined, true);
  assert.equal(writes.length, 2);
});

test('EXPIRED STOP without terminal ACK quarantines instead of claiming a verified stop', async () => {
  const { db, transitions } = terminalDb({
    commandType: 'stop_mining',
    status: 'EXPIRED',
    runtimeState: 'VERIFYING_STOP',
  });
  const result = await reconcileTerminalMiningCommands(db);
  assert.deepEqual(result, { expired: 0, quarantined: 1, superseded: 0 });
  assert.equal(transitions[0].where.runtimeState, 'VERIFYING_STOP');
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
});

test('terminal delivery reconciliation never overwrites rental preemption', async () => {
  const { db, transitions, writes } = terminalDb({
    commandType: 'start_mining',
    status: 'DEAD',
    runtimeState: 'PREEMPTING',
    activeRentalId: 'session_00000001',
  });
  const result = await reconcileTerminalMiningCommands(db);
  assert.deepEqual(result, { expired: 0, quarantined: 0, superseded: 1 });
  assert.equal(transitions.length, 0);
  assert.equal(writes.length, 0);
});

test('invalid fence or hardware identity stays fail-closed on the exact resource', async () => {
  const { db, transitions } = terminalDb({
    commandType: 'stop_mining',
    status: 'DEAD',
    runtimeState: 'VERIFYING_STOP',
    fenceValid: false,
    hardwareUuid: 'GPU-bbbbbbbb',
    commandHardwareUuid: 'GPU-aaaaaaaa',
  });
  const result = await reconcileTerminalMiningCommands(db);
  assert.deepEqual(result, { expired: 0, quarantined: 1, superseded: 0 });
  assert.equal(transitions[0].where.id, 'resource_00000001');
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
});


test('overdue mining commands expire even when normal delivery is not claiming them', async () => {
  const { db, transitions, expiryQueries } = terminalDb({
    commandType: 'start_mining',
    status: 'EXPIRED',
    runtimeState: 'STARTING',
    expiredCount: 1,
  });
  const result = await reconcileTerminalMiningCommands(db);
  assert.deepEqual(result, { expired: 1, quarantined: 1, superseded: 0 });
  assert.equal(expiryQueries.length, 1);
  const sql = expiryQueries[0]?.sql ?? (expiryQueries[0]?.strings ?? []).join('?');
  assert.match(sql, /command\."expiresAt" <= CURRENT_TIMESTAMP/);
  assert.match(sql, /command\."status" = 'PENDING'/);
  assert.match(sql, /command\."leaseExpiresAt" <= CURRENT_TIMESTAMP/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(transitions[0].data.runtimeState, 'QUARANTINED');
});
