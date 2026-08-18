import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  MiningResourceKind,
  ModerationStatus,
  ResourceAllocationStatus,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Redis } from 'ioredis';

import {
  buildRentalResourceAuthority,
  releaseRentalResourceAuthority,
} from '../src/rental-resource-authority.js';

class FakeRedis {
  readonly leases = new Map<string, { holderId: string; idempotencyKey: string; leaseId: string; fencingToken: string; ttlMs: number }>();
  readonly fences = new Map<string, bigint>();

  seed(resourceId: string, holderId: string, fencingToken: bigint): void {
    this.fences.set(resourceId, fencingToken);
    this.leases.set(resourceId, {
      holderId,
      idempotencyKey: `mining:${resourceId}`,
      leaseId: `lease_seed_${resourceId}`,
      fencingToken: String(fencingToken),
      ttlMs: 45_000,
    });
  }

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (numberOfKeys === 2) {
      const leaseKey = String(args[0]);
      const match = leaseKey.match(/\{([^{}]+)\}/);
      if (!match) throw new Error('fake_lease_key_invalid');
      const resourceId = match[1]!;
      const holderId = String(args[2]);
      const idempotencyKey = String(args[3]);
      const requestedLeaseId = String(args[4]);
      const ttlMs = Number(args[5]);
      const current = this.leases.get(resourceId);
      if (current && current.holderId === holderId && current.idempotencyKey === idempotencyKey) {
        current.ttlMs = ttlMs;
        return [2, current.leaseId, current.fencingToken, ttlMs];
      }
      const fence = (this.fences.get(resourceId) ?? 0n) + 1n;
      this.fences.set(resourceId, fence);
      const next = { holderId, idempotencyKey, leaseId: requestedLeaseId, fencingToken: String(fence), ttlMs };
      this.leases.set(resourceId, next);
      return [1, next.leaseId, next.fencingToken, ttlMs];
    }
    if (numberOfKeys === 1) {
      const leaseKey = String(args[0]);
      const match = leaseKey.match(/\{([^{}]+)\}/);
      if (!match) throw new Error('fake_lease_key_invalid');
      const resourceId = match[1]!;
      const current = this.leases.get(resourceId);
      const leaseId = String(args[1]);
      const holderId = String(args[2]);
      const fencingToken = String(args[3]);
      if (!current) return [0, 'MISSING'];
      if (current.leaseId !== leaseId || current.holderId !== holderId || current.fencingToken !== fencingToken) {
        return [0, 'STALE_LEASE'];
      }
      this.leases.delete(resourceId);
      return [1, '0'];
    }
    throw new Error('fake_eval_unexpected');
  }
}

const gpu = (resourceId: string, hardwareUuid: string) => ({
  id: `accelerator_${resourceId}`,
  hardwareUuid,
  model: 'NVIDIA Test GPU',
  vendor: 'NVIDIA',
  moderationStatus: ModerationStatus.CLEAR,
  status: AcceleratorOperationalStatus.AVAILABLE,
  miningResource: {
    id: resourceId,
    kind: MiningResourceKind.GPU,
    enabled: true,
    quarantined: false,
  },
});

function selectedSession(status = WorkspaceSessionStatus.READY) {
  return {
    id: 'session_00000001',
    status,
    booking: {
      machineAllocation: null,
      acceleratorAllocations: [
        { accelerator: gpu('resource_00000001', 'GPU-aaaaaaaa') },
      ],
      listing: {
        resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
        machine: {
          accelerators: [
            gpu('resource_00000001', 'GPU-aaaaaaaa'),
            gpu('resource_00000002', 'GPU-bbbbbbbb'),
          ],
        },
      },
    },
  };
}

function databaseWithSessions(sessions: unknown[], releaseStatus = WorkspaceSessionStatus.STOPPING): PrismaClient {
  return {
    workspaceSession: {
      findMany: async () => sessions,
      findFirst: async () => ({
        id: 'session_00000001',
        status: releaseStatus,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    },
  } as unknown as PrismaClient;
}

describe('rental resource authority', () => {
  it('preempts an older mining lease with one newer fence and refreshes idempotently', async () => {
    const redis = new FakeRedis();
    redis.seed('resource_00000001', 'mining:resource_00000001', 7n);
    const db = databaseWithSessions([selectedSession()]);

    const first = await buildRentalResourceAuthority(db, redis as unknown as Redis, 'machine_00000001');
    assert.equal(first.sessions.length, 1);
    assert.deepEqual(first.sessions[0]!.resources.map((resource) => resource.resourceId), ['resource_00000001']);
    assert.equal(first.sessions[0]!.resources[0]!.lease.fencingToken, '8');
    assert.equal(first.sessions[0]!.resources[0]!.lease.holderId, 'rental:session_00000001');

    const second = await buildRentalResourceAuthority(db, redis as unknown as Redis, 'machine_00000001');
    assert.equal(second.sessions[0]!.resources[0]!.lease.fencingToken, '8');
    assert.equal(redis.fences.get('resource_00000001'), 8n);
  });

  it('full-machine authority maps every qualified GPU resource', async () => {
    const redis = new FakeRedis();
    const session = selectedSession();
    session.booking.machineAllocation = { status: ResourceAllocationStatus.CONFIRMED };
    session.booking.acceleratorAllocations = [];
    session.booking.listing.resourceMode = ListingResourceMode.FULL_MACHINE;
    const authority = await buildRentalResourceAuthority(
      databaseWithSessions([session]),
      redis as unknown as Redis,
      'machine_00000001',
    );
    assert.deepEqual(
      authority.sessions[0]!.resources.map((resource) => resource.resourceId),
      ['resource_00000001', 'resource_00000002'],
    );
  });

  it('repairs a missing GPU resource mapping from stable hardware identity', async () => {
    const redis = new FakeRedis();
    const session = selectedSession();
    const accelerator = session.booking.acceleratorAllocations[0]!.accelerator;
    accelerator.miningResource = null;
    let upsertCalls = 0;
    const db = {
      workspaceSession: {
        findMany: async () => [session],
        findFirst: async () => ({
          id: 'session_00000001',
          status: WorkspaceSessionStatus.STOPPING,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      miningResource: {
        upsert: async () => {
          upsertCalls += 1;
          return {
            id: 'resource_repaired_01',
            acceleratorId: accelerator.id,
            kind: MiningResourceKind.GPU,
            enabled: true,
            quarantined: false,
          };
        },
        update: async () => ({
          id: 'resource_repaired_01',
          kind: MiningResourceKind.GPU,
          enabled: true,
          quarantined: false,
        }),
      },
    } as unknown as PrismaClient;

    const authority = await buildRentalResourceAuthority(db, redis as unknown as Redis, 'machine_00000001');
    assert.equal(upsertCalls, 1);
    assert.deepEqual(
      authority.sessions[0]!.resources.map((resource) => resource.resourceId),
      ['resource_repaired_01'],
    );
  });

  it('fails closed when an existing GPU resource is disabled', async () => {
    const redis = new FakeRedis();
    const session = selectedSession();
    session.booking.acceleratorAllocations[0]!.accelerator.miningResource!.enabled = false;
    const authority = await buildRentalResourceAuthority(
      databaseWithSessions([session]),
      redis as unknown as Redis,
      'machine_00000001',
    );
    assert.equal(authority.sessions[0]!.blockedReason, 'rental_gpu_resource_disabled');
    assert.equal(authority.sessions[0]!.resources.length, 0);
    assert.equal(redis.leases.size, 0);
  });

  it('rejects overlapping live sessions before creating a fencing war', async () => {
    const redis = new FakeRedis();
    const first = selectedSession();
    const second = selectedSession();
    second.id = 'session_00000002';
    await assert.rejects(
      buildRentalResourceAuthority(databaseWithSessions([first, second]), redis as unknown as Redis, 'machine_00000001'),
      /rental_gpu_resource_authority_conflict/,
    );
    assert.equal(redis.leases.size, 0);
  });

  it('releases the exact rental lease only after stop intent', async () => {
    const redis = new FakeRedis();
    const db = databaseWithSessions([selectedSession()]);
    const authority = await buildRentalResourceAuthority(db, redis as unknown as Redis, 'machine_00000001');
    const lease = authority.sessions[0]!.resources[0]!.lease;
    const released = await releaseRentalResourceAuthority(
      db,
      redis as unknown as Redis,
      'machine_00000001',
      'session_00000001',
      [lease],
    );
    assert.equal(released.released, 1);
    assert.equal(redis.leases.has('resource_00000001'), false);
  });

  it('does not release a live READY rental lease', async () => {
    const redis = new FakeRedis();
    const db = databaseWithSessions([selectedSession()], WorkspaceSessionStatus.READY);
    const authority = await buildRentalResourceAuthority(db, redis as unknown as Redis, 'machine_00000001');
    const lease = authority.sessions[0]!.resources[0]!.lease;
    await assert.rejects(
      releaseRentalResourceAuthority(db, redis as unknown as Redis, 'machine_00000001', 'session_00000001', [lease]),
      /rental_session_not_releasable/,
    );
    assert.equal(redis.leases.has('resource_00000001'), true);
  });
});
