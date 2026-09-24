import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { finalizeMiningTerminalAck } from '../src/mining-command-finalizer.js';
import type { ClaimedMachineCommand } from '../src/delivery-store.js';

const miningCommand = (type: 'start_mining' | 'stop_mining'): ClaimedMachineCommand => ({
  id: `command_${type}_0001`,
  machineId: 'machine_00000001',
  commandType: type,
  sequence: 7n,
  idempotencyKey: `${type}:resource_00000001:lease_1`,
  expiresAt: new Date('2026-09-24T21:00:00.000Z'),
  payload: {
    lease: {
      resourceId: 'resource_00000001',
      holderId: 'mining:resource_00000001',
      leaseId: 'lease_000000001',
      fencingToken: '7',
    },
    payload: {
      resourceId: 'resource_00000001',
      hardwareUuid: 'GPU-aaaaaaaa',
      runtimeGeneration: '7',
    },
  },
  status: 'LEASED',
  attempts: 1,
  availableAt: new Date('2026-09-24T20:00:00.000Z'),
  leaseOwner: 'delivery_worker_0001',
  leaseExpiresAt: new Date('2026-09-24T20:00:15.000Z'),
  createdAt: new Date('2026-09-24T20:00:00.000Z'),
});

function fakeDb(state: string, activeRentalId: string | null = null) {
  const updates: any[] = [];
  const writes: unknown[][] = [];
  const tx = {
    $queryRaw: async () => [{ runtimeState: state, activeRentalId }],
    $executeRaw: async (...args: unknown[]) => { writes.push(args); return 1; },
    miningResource: {
      updateMany: async (args: any) => { updates.push(args); return { count: 1 }; },
    },
  };
  const db = { $transaction: async (fn: any) => fn(tx) } as unknown as PrismaClient;
  return { db, updates, writes };
}

function releaseRedis() {
  let releases = 0;
  const redis = {
    eval: async () => { releases += 1; return [1, '0']; },
  } as unknown as Redis;
  return { redis, releases: () => releases };
}

test('successful START finalizes STARTING to MINING without releasing the active mining lease', async () => {
  const { db, updates } = fakeDb('STARTING');
  const { redis, releases } = releaseRedis();
  await finalizeMiningTerminalAck(db, redis, miningCommand('start_mining'), { status: 'SUCCEEDED' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.runtimeState, 'MINING');
  assert.equal(releases(), 0);
});

test('failed START returns to STOPPED and releases its mining lease', async () => {
  const { db, updates } = fakeDb('STARTING');
  const { redis, releases } = releaseRedis();
  await finalizeMiningTerminalAck(db, redis, miningCommand('start_mining'), {
    status: 'REJECTED',
    detailCode: 'miner_secret_resolution_required',
  });
  assert.equal(updates[0].data.runtimeState, 'STOPPED');
  assert.equal(releases(), 1);
});

test('successful STOP finalizes VERIFYING_STOP to STOPPED and releases the lease', async () => {
  const { db, updates } = fakeDb('VERIFYING_STOP');
  const { redis, releases } = releaseRedis();
  await finalizeMiningTerminalAck(db, redis, miningCommand('stop_mining'), { status: 'SUCCEEDED' });
  assert.equal(updates[0].data.runtimeState, 'STOPPED');
  assert.equal(releases(), 1);
});

test('failed STOP quarantines when the stop could not be verified', async () => {
  const { db, updates } = fakeDb('VERIFYING_STOP');
  const { redis, releases } = releaseRedis();
  await finalizeMiningTerminalAck(db, redis, miningCommand('stop_mining'), {
    status: 'FAILED',
    detailCode: 'mining_resource_stop_unverified',
  });
  assert.equal(updates[0].data.runtimeState, 'QUARANTINED');
  assert.equal(releases(), 0);
});

test('late START ACK cannot overwrite rental-priority state', async () => {
  const { db, updates, writes } = fakeDb('RENTAL_BLOCKED', 'rental_00000001');
  const { redis } = releaseRedis();
  await finalizeMiningTerminalAck(db, redis, miningCommand('start_mining'), { status: 'SUCCEEDED' });
  assert.equal(updates.length, 0);
  assert.equal(writes.length, 1); // audit-only superseded ACK
});