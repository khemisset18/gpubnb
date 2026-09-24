import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { requestOwnerMiningStart, requestOwnerMiningStop } from '../src/mining-owner-command-service.js';

class FakeLeaseRedis {
  private lease: Record<string, string> | null = null;
  private fence = 0;

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (numberOfKeys === 2) {
      const holderId = String(args[2]);
      const idempotencyKey = String(args[3]);
      const leaseId = String(args[4]);
      const ttlMs = Number(args[5]);
      if (this.lease) {
        if (this.lease.holderId === holderId && this.lease.idempotencyKey === idempotencyKey) {
          return [2, this.lease.leaseId, this.lease.fencingToken, ttlMs];
        }
        return [0, this.lease.leaseId, this.lease.fencingToken, ttlMs];
      }
      this.fence += 1;
      this.lease = { holderId, idempotencyKey, leaseId, fencingToken: String(this.fence) };
      return [1, leaseId, String(this.fence), ttlMs];
    }
    if (!this.lease) return [0, 'MISSING'];
    const leaseId = String(args[1]);
    const holderId = String(args[2]);
    const fencingToken = String(args[3]);
    if (this.lease.leaseId !== leaseId || this.lease.holderId !== holderId || this.lease.fencingToken !== fencingToken) {
      return [0, 'STALE_LEASE'];
    }
    if (args.length === 5) return [1, Number(args[4])];
    this.lease = null;
    return [1, '0'];
  }

  async hgetall(): Promise<Record<string, string>> { return this.lease ? { ...this.lease } : {}; }
  async pttl(): Promise<number> { return this.lease ? 300_000 : -2; }
}

function startableResource() {
  return {
    id: 'resource_00000001',
    machineId: 'machine_00000001',
    kind: 'GPU',
    enabled: true,
    quarantined: false,
    runtimeState: 'IDLE',
    activeRentalId: null,
    updatedAt: new Date('2026-09-24T20:00:00.000Z'),
    machine: { ownerId: 'owner_00000001' },
    accelerator: { hardwareUuid: 'GPU-aaaaaaaa', vendor: 'NVIDIA' },
    configuration: {
      id: 'config_00000001',
      mode: 'OWNER_POOL',
      profileId: 'lolminer_etchash',
      walletAddress: 'wallet.example-123',
      workerName: 'worker_1',
      ownerPoolEndpoint: 'stratum+tcp://1.1.1.1:4444',
      ownerPoolSecretRef: null,
      maximumTemperatureC: 94,
      maximumPowerWatts: 180,
      version: 3,
    },
  };
}

function fakeDb(resource: any) {
  const writes: unknown[][] = [];
  const transitions: any[] = [];
  const tx = {
    miningResource: {
      updateMany: async (args: any) => { transitions.push(args); return { count: 1 }; },
    },
    $queryRaw: async () => [{ sequence: 11n }],
    $executeRaw: async (...args: unknown[]) => { writes.push(args); return 1; },
  };
  const db = {
    miningResource: { findFirst: async () => resource },
    $transaction: async (fn: any) => fn(tx),
  } as unknown as PrismaClient;
  return { db, writes, transitions };
}

test('owner START acquires a fenced lease and persists a durable STARTING command', async () => {
  const { db, writes, transitions } = fakeDb(startableResource());
  const redis = new FakeLeaseRedis() as unknown as Redis;
  const result = await requestOwnerMiningStart(db, redis, {
    machineId: 'machine_00000001',
    resourceId: 'resource_00000001',
    ownerId: 'owner_00000001',
    requestId: 'request_00000001',
    now: new Date(),
  });

  assert.equal(result.action, 'start');
  assert.equal(result.state, 'STARTING');
  assert.equal(result.alreadySatisfied, false);
  assert.match(result.commandId!, /^cmd_[a-f0-9]{32}$/);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].data.runtimeState, 'STARTING');
  assert.ok(writes.length >= 3);
});

test('owner START fails closed when a pool secret reference cannot yet be injected safely', async () => {
  const resource = startableResource();
  resource.configuration.ownerPoolSecretRef = 'secret://local/mining/pool-main';
  const { db } = fakeDb(resource);
  await assert.rejects(
    requestOwnerMiningStart(db, new FakeLeaseRedis() as unknown as Redis, {
      machineId: resource.machineId,
      resourceId: resource.id,
      ownerId: resource.machine.ownerId,
      requestId: 'request_00000001',
    }),
    /mining_pool_secret_runtime_unavailable/,
  );
});

test('owner STOP is idempotent when the resource is already stopped', async () => {
  const resource = startableResource();
  resource.runtimeState = 'STOPPED';
  const { db, writes } = fakeDb(resource);
  const result = await requestOwnerMiningStop(db, new FakeLeaseRedis() as unknown as Redis, {
    machineId: resource.machineId,
    resourceId: resource.id,
    ownerId: resource.machine.ownerId,
    requestId: 'request_00000002',
  });
  assert.equal(result.alreadySatisfied, true);
  assert.equal(result.commandId, null);
  assert.equal(writes.length, 0);
});

test('configuration/start remains impossible while a rental owns the resource', async () => {
  const resource = startableResource();
  resource.activeRentalId = 'rental_00000001';
  const { db } = fakeDb(resource);
  await assert.rejects(
    requestOwnerMiningStart(db, new FakeLeaseRedis() as unknown as Redis, {
      machineId: resource.machineId,
      resourceId: resource.id,
      ownerId: resource.machine.ownerId,
      requestId: 'request_00000003',
    }),
    /mining_resource_rental_active/,
  );
});