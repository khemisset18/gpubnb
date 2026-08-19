import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  AcceleratorOperationalStatus,
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PrismaClient,
  ResourceAllocationStatus,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { Redis } from 'ioredis';

import { syncGpuMiningResourcesFromAccelerators } from '../src/mining-resource-inventory.js';
import { listOwnerRentalGpus } from '../src/rental-gpu-catalog.js';
import { createExactGpuListing } from '../src/rental-listing-service.js';
import { allocateBookingResources, releaseBookingResources } from '../src/resource-allocation-service.js';
import { buildRentalResourceAuthority } from '../src/rental-resource-authority.js';
import { ensureCompatibleMachineWorkspace } from '../src/machine-workspace-catalog.js';
import type { AcceleratorTelemetry } from '../src/accelerator-telemetry.js';

// Logical end-to-end walkthrough of the full GPU rental lifecycle against a real
// Postgres+Redis, calling the real production functions at every hop (not fakes,
// not re-implementations) and verifying the actual DB row/relations after each step
// - not just that a function returned without throwing.
//
// This is the strongest proof achievable in this environment: it cannot execute
// Docker/NVIDIA or a physical GPU_PROOF workload. What it does prove, with real rows:
// heartbeat -> Accelerator/MiningResource identity is stable and correct: the exact
// hardwareUuid this test seeds is the exact hardwareUuid buildRentalResourceAuthority
// hands back for the booked session - the same value the agent's gpu_proof_command()
// now requires (see runner.py/cli.py, covered separately by the agent test suite) to
// pass as --gpus=device=<uuid>. Physical container execution and NVIDIA passthrough
// enforcement itself are explicitly BLOCKED pending physical multi-GPU hardware (see
// the final report) and are not, and cannot honestly be, claimed as proven here.
//
// Skips cleanly if no local Postgres/Redis is reachable. Uses real commits (several
// steps call functions that manage their own transaction and cannot run inside an
// outer rolled-back transaction), so it explicitly tears down every row it created.

const hasDb = Boolean(process.env.DATABASE_URL);

function gpu(deviceId: string): AcceleratorTelemetry {
  return {
    schemaVersion: 1,
    kind: 'GPU',
    vendor: 'NVIDIA',
    model: 'NVIDIA Test GPU E2E',
    deviceId,
    busAddress: null,
    driverVersion: '550.10',
    runtimeVersion: '12.4',
    memoryTotalMiB: 8192,
    memoryUsedMiB: null,
    utilizationPercent: null,
    temperatureC: null,
    powerWatts: null,
    available: true,
    throttling: false,
    capabilities: {},
    metrics: {},
  };
}

test('full GPU rental lifecycle: heartbeat -> inventory -> publish -> booking -> allocation -> signed authority -> release -> available again', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
  try {
    await prisma.$connect();
  } catch (error) {
    t.skip(`no reachable local Postgres for this E2E test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }
  redis.on('error', () => {});
  try {
    await redis.connect();
  } catch (error) {
    t.skip(`no reachable local Redis for this E2E test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }

  const suffix = crypto.randomBytes(6).toString('hex');
  const hardwareUuid = `GPU-e2e-${suffix}`;
  const now = new Date();

  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
  });

  // --- Step 1: host GPU physically detected + linked, machine record exists ---
  const owner = await prisma.user.create({
    data: { wallet: `owner_${suffix}`, pseudonym: `owner_${suffix}`, canHost: true },
  });
  cleanup.push(() => prisma.user.delete({ where: { id: owner.id } }));
  const renter = await prisma.user.create({
    data: { wallet: `renter_${suffix}`, pseudonym: `renter_${suffix}` },
  });
  cleanup.push(() => prisma.user.delete({ where: { id: renter.id } }));
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_${suffix}`,
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.AVAILABLE,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now,
      lastCudaProbeOk: true,
      dockerAvailable: true,
      nvidiaRuntimeAvailable: true,
      virtualizationAvailable: true,
      verifiedAt: now,
      ramTotalMiB: 16_384,
      diskTotalMiB: 51_200,
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machine.id } }));

  // --- Step 2/3/4: heartbeat -> accelerator inventory -> MiningResource, via the
  // real production bridge (this exact function is the fix for
  // rental_gpu_resource_mapping_missing) ---
  await prisma.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machine.id, [gpu(hardwareUuid)]));

  const accelerator = await prisma.accelerator.findUniqueOrThrow({
    where: { machineId_hardwareUuid: { machineId: machine.id, hardwareUuid } },
    include: { miningResource: true },
  });
  assert.equal(accelerator.status, AcceleratorOperationalStatus.AVAILABLE, 'a fresh, available GPU must sync to AVAILABLE');
  assert.ok(accelerator.miningResource, 'MiningResource must exist for this exact accelerator after heartbeat sync');
  assert.equal(accelerator.miningResource!.enabled, true);
  // isolationVerified/verifiedAt come from Machine state, not the accelerator sync call
  // itself - set them directly to match a host that has already completed verification.
  await prisma.accelerator.update({
    where: { id: accelerator.id },
    data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now },
  });

  // --- Step 5: annonce publiable - the real publish-readiness gate agrees ---
  const ownerGpus = await listOwnerRentalGpus(prisma, machine.id, owner.id, now, 60);
  const readiness = ownerGpus?.find((row) => row.id === accelerator.id);
  assert.ok(readiness, 'the exact accelerator must appear in the owner rentable-GPU catalog');
  assert.equal(readiness!.publishable, true, `expected publishable, got blockingReason=${readiness!.blockingReason}`);

  // --- Step 6: annonce (listing) created through the real transactional service ---
  const listing = await createExactGpuListing(prisma, {
    ownerId: owner.id,
    machineId: machine.id,
    acceleratorId: accelerator.id,
    title: 'E2E lifecycle listing',
    description: 'Seeded by e2e-gpu-rental-lifecycle.test.ts to walk the full rental path.',
    hourlySol: 0.01,
    now,
    heartbeatStaleAfterSeconds: 60,
  });
  cleanup.push(() => prisma.gpuListing.delete({ where: { id: listing.id } }));
  assert.equal(listing.resourceMode, ListingResourceMode.SELECTED_ACCELERATORS);
  assert.equal(listing.accelerator?.id, accelerator.id, 'the listing must be bound to the exact accelerator, by id');
  const listingAcceleratorRow = await prisma.listingAccelerator.findUniqueOrThrow({
    where: { listingId_acceleratorId: { listingId: listing.id, acceleratorId: accelerator.id } },
  });
  assert.ok(listingAcceleratorRow, 'ListingAccelerator relation row must exist, binding listing <-> exact accelerator');

  // --- Step 7: booking (rental) created (mirrors what POST /bookings persists) ---
  const startsAt = new Date(now.getTime() + 60_000);
  const endsAt = new Date(now.getTime() + 3_660_000);
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id,
      listingId: listing.id,
      idempotencyKey: `idem_${suffix}`,
      startsAt,
      endsAt,
      quotedLamports: 1_000_000n,
      expectedSeconds: 60,
      status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  cleanup.push(() => prisma.booking.delete({ where: { id: booking.id } }));

  // --- Step 8: resource allocation, through the real transactional service ---
  const allocation = await allocateBookingResources(prisma, { bookingId: booking.id, buyerId: renter.id });
  assert.equal(allocation.mode, ListingResourceMode.SELECTED_ACCELERATORS);
  assert.deepEqual(allocation.acceleratorIds, [accelerator.id]);
  const allocationRow = await prisma.acceleratorAllocation.findFirstOrThrow({
    where: { bookingId: booking.id, acceleratorId: accelerator.id },
  });
  assert.equal(allocationRow.status, ResourceAllocationStatus.HELD);

  // Funding transition (BETA_TEST_DEV_BYPASS/escrow are out of scope here - this test
  // asserts the resource/session graph, not the payment state machine).
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.ACTIVE } });

  // --- Step 9/10/11: Compute workspace session + job, exactly as ensureComputePreparation
  // creates them, then the real signed rental resource authority resolves the exact
  // physical GPU for that session ---
  const machineWorkspace = await ensureCompatibleMachineWorkspace(prisma, machine.id, 'compute');
  const job = await prisma.job.create({
    data: {
      bookingId: booking.id,
      renterId: renter.id,
      machineId: machine.id,
      type: 'GPU_PROOF',
      parameters: { durationSeconds: 30, workspaceSlug: 'compute' },
    },
  });
  cleanup.push(() => prisma.job.delete({ where: { id: job.id } }).catch(() => {}));
  const session = await prisma.workspaceSession.create({
    data: {
      bookingId: booking.id,
      renterId: renter.id,
      machineId: machine.id,
      machineWorkspaceId: machineWorkspace.id,
      jobId: job.id,
      status: WorkspaceSessionStatus.READY,
      isolationType: 'DOCKER',
      resourceLimits: {},
      expiresAt: endsAt,
    },
  });

  const authority = await buildRentalResourceAuthority(prisma, redis, machine.id);
  const resolvedSession = authority.sessions.find((entry) => entry.sessionId === session.id);
  assert.ok(resolvedSession, 'the Compute session must resolve in the rental resource authority');
  assert.equal(resolvedSession!.blockedReason, undefined);
  assert.equal(resolvedSession!.resources.length, 1);
  // This is the exact value the agent's gpu_proof_command() now requires and passes as
  // --gpus=device=<uuid> (see runner.py) - proven identical to the hardwareUuid this
  // test seeded in step 2, all the way through heartbeat -> Accelerator ->
  // MiningResource -> AcceleratorAllocation -> WorkspaceSession -> signed authority.
  assert.equal(resolvedSession!.resources[0]!.hardwareUuid, hardwareUuid);
  assert.ok(resolvedSession!.resources[0]!.lease.leaseId, 'a real Redis lease must be issued for this exact resource');

  // --- Step 12-16: GPU proof executes physically - BLOCKED here, see final report.
  // Simulate the job/booking reaching a terminal successful state the way
  // /agent/jobs/:id/finalize-proof would leave it. ---
  await prisma.job.update({ where: { id: job.id }, data: { status: 'COMPLETED', finishedAt: new Date() } });
  await prisma.workspaceSession.update({ where: { id: session.id }, data: { status: WorkspaceSessionStatus.COMPLETED, endedAt: new Date() } });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.COMPLETED } });

  // --- Step 17: cleanup / resource released, through the real transactional service ---
  await releaseBookingResources(prisma, booking.id);
  const releasedRow = await prisma.acceleratorAllocation.findFirstOrThrow({
    where: { bookingId: booking.id, acceleratorId: accelerator.id },
  });
  assert.equal(releasedRow.status, ResourceAllocationStatus.RELEASED);
  assert.ok(releasedRow.releasedAt);

  // --- Step 18: resource genuinely available again - proven by allocating it to a
  // second, non-overlapping booking succeeding, not merely by reading a status enum ---
  const secondBooking = await prisma.booking.create({
    data: {
      buyerId: renter.id,
      listingId: listing.id,
      idempotencyKey: `idem2_${suffix}`,
      startsAt: new Date(endsAt.getTime() + 60_000),
      endsAt: new Date(endsAt.getTime() + 3_660_000),
      quotedLamports: 1_000_000n,
      expectedSeconds: 60,
      status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  cleanup.push(() => prisma.booking.delete({ where: { id: secondBooking.id } }));
  const secondAllocation = await allocateBookingResources(prisma, { bookingId: secondBooking.id, buyerId: renter.id });
  assert.deepEqual(secondAllocation.acceleratorIds, [accelerator.id], 'the same physical GPU must be re-rentable once released, not stuck');
});
