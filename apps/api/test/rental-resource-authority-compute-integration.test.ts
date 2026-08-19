import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  MiningResourceKind,
  ModerationStatus,
  PrismaClient,
  ResourceAllocationStatus,
  WorkspaceRelease,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { Redis } from 'ioredis';

import { buildRentalResourceAuthority, type RentalResourceAuthority } from '../src/rental-resource-authority.js';

// Real-database regression for the reported `rental_resource_authority_missing_for_session`
// failure. Every fake-backed unit test for buildRentalResourceAuthority hands it an
// in-memory session list directly and never exercises the Prisma `where` clause
// itself - so a regression in that filter (exactly what shipped: a hardcoded
// `workspace.slug === 'developer'` that silently excluded every Compute/GPU_PROOF
// session, the only workspace kind renters can actually book in private beta) was
// invisible to the existing suite. This test seeds a real Compute booking graph in
// Postgres and calls the real function against it.
//
// The whole seed + call runs inside one Prisma interactive transaction that is
// always rolled back (never committed), so this test leaves zero footprint in a
// shared local/CI database regardless of pass or fail.
//
// Skips cleanly if no local Postgres/Redis is reachable, instead of reporting a
// false pass or a confusing connection-refused failure. Some CI workflows (e.g.
// api-mining-ci.yml) provision Postgres but not Redis for this suite, so both
// must be checked independently - DATABASE_URL being set says nothing about
// Redis reachability.

const hasDb = Boolean(process.env.DATABASE_URL);
const ROLLBACK = Symbol('deliberate-test-rollback');

test('buildRentalResourceAuthority resolves a real Compute/GPU_PROOF session (rental_resource_authority_missing_for_session regression)', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
  try {
    await prisma.$connect();
  } catch (error) {
    t.skip(`no reachable local Postgres for this integration test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }
  redis.on('error', () => {}); // avoid noisy "Unhandled error event" logs; the connect() rejection below is what we act on
  try {
    await redis.connect();
  } catch (error) {
    t.skip(`no reachable local Redis for this integration test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }
  t.after(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  const suffix = crypto.randomBytes(6).toString('hex');
  const hardwareUuid = `GPU-test-${suffix}`;
  let authority: RentalResourceAuthority | undefined;
  let sessionId: string | undefined;

  try {
    await prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({
        data: { wallet: `owner_${suffix}`, pseudonym: `owner_${suffix}`, canHost: true },
      });
      const renter = await tx.user.create({
        data: { wallet: `renter_${suffix}`, pseudonym: `renter_${suffix}` },
      });
      const machine = await tx.machine.create({
        data: {
          ownerId: owner.id,
          agentPublicKey: `agentkey_${suffix}`,
          connectivity: MachineConnectivity.ONLINE,
          operational: MachineOperational.AVAILABLE,
        },
      });
      const accelerator = await tx.accelerator.create({
        data: {
          machineId: machine.id,
          hardwareUuid,
          vendor: 'NVIDIA',
          model: 'NVIDIA Test GPU',
          vramMiB: 8192,
          status: AcceleratorOperationalStatus.RESERVED,
          moderationStatus: ModerationStatus.CLEAR,
          isolationVerified: true,
          verifiedAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
      await tx.miningResource.create({
        data: {
          id: crypto.randomUUID(),
          machineId: machine.id,
          kind: MiningResourceKind.GPU,
          resourceKey: `gpu:${machine.id}:uuid:${hardwareUuid}`,
          displayName: 'NVIDIA Test GPU',
          acceleratorId: accelerator.id,
          enabled: true,
          quarantined: false,
          lastSeenAt: new Date(),
        },
      });
      const computeWorkspace = await tx.workspaceDefinition.upsert({
        where: { slug: 'compute' },
        update: {},
        create: {
          slug: 'compute',
          name: 'Compute Workspace',
          category: 'COMPUTE',
          release: WorkspaceRelease.BETA,
          manifest: {},
        },
      });
      const machineWorkspace = await tx.machineWorkspace.create({
        data: {
          machineId: machine.id,
          workspaceId: computeWorkspace.id,
          compatibilityScore: 100,
          state: 'READY',
          analysis: {},
        },
      });
      const listing = await tx.gpuListing.create({
        data: {
          ownerId: owner.id,
          machineId: machine.id,
          title: 'Integration test listing',
          description: 'Seeded by rental-resource-authority-compute-integration.test.ts',
          hourlyLamports: 1_000_000n,
          status: ListingStatus.ACTIVE,
          resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
          accelerators: { create: { acceleratorId: accelerator.id } },
        },
      });
      const booking = await tx.booking.create({
        data: {
          buyerId: renter.id,
          listingId: listing.id,
          idempotencyKey: `idem_${suffix}`,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3_600_000),
          quotedLamports: 1_000_000n,
          expectedSeconds: 60,
        },
      });
      await tx.acceleratorAllocation.create({
        data: {
          bookingId: booking.id,
          acceleratorId: accelerator.id,
          status: ResourceAllocationStatus.CONFIRMED,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
        },
      });
      const session = await tx.workspaceSession.create({
        data: {
          bookingId: booking.id,
          renterId: renter.id,
          machineId: machine.id,
          machineWorkspaceId: machineWorkspace.id,
          status: WorkspaceSessionStatus.READY,
          isolationType: 'DOCKER',
          resourceLimits: {},
          expiresAt: booking.endsAt,
        },
      });

      sessionId = session.id;
      authority = await buildRentalResourceAuthority(tx as unknown as PrismaClient, redis, machine.id);

      throw ROLLBACK;
    }, { timeout: 10_000 });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  const resolved = authority?.sessions.find((entry) => entry.sessionId === sessionId);
  assert.ok(
    resolved,
    'a real Compute/GPU_PROOF WorkspaceSession must be resolvable from the rental resource authority - ' +
      'if this is undefined, the API would answer rental_resource_authority_missing_for_session for every ' +
      'renter job, exactly as reported',
  );
  assert.equal(resolved!.blockedReason, undefined);
  assert.equal(resolved!.resources.length, 1);
  assert.equal(resolved!.resources[0]!.hardwareUuid, hardwareUuid);
});
