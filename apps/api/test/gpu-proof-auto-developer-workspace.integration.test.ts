import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  BookingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PrismaClient,
  WorkspaceSessionStatus,
} from '@prisma/client';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { completeGpuProofJob } = await import('../src/gpu-proof-completion.js');
const { allocateBookingResources } = await import('../src/resource-allocation-service.js');
const { syncGpuMiningResourcesFromAccelerators } = await import('../src/mining-resource-inventory.js');
const { createExactGpuListing } = await import('../src/rental-listing-service.js');

const hasDb = Boolean(process.env.DATABASE_URL);

test('a fresh Compute rental needs no second renter click after verified GPU_PROOF', { skip: !hasDb }, async (t) => {
  const db = new PrismaClient();
  try {
    await db.$connect();
  } catch (error) {
    t.skip(`no reachable local Postgres for this test: ${(error as Error).message}`);
    await db.$disconnect().catch(() => {});
    return;
  }

  const suffix = crypto.randomBytes(6).toString('hex');
  const now = new Date();
  let ownerId = '';
  let renterId = '';
  let machineId = '';
  let listingId = '';
  let bookingId = '';
  try {
    const owner = await db.user.create({ data: { wallet: `owner_auto_${suffix}`, pseudonym: `owner_auto_${suffix}`, canHost: true } });
    const renter = await db.user.create({ data: { wallet: `renter_auto_${suffix}`, pseudonym: `renter_auto_${suffix}` } });
    ownerId = owner.id;
    renterId = renter.id;

    const machine = await db.machine.create({
      data: {
        ownerId,
        agentPublicKey: `agentkey_auto_${suffix}`,
        agentVersion: '0.6.2',
        connectivity: MachineConnectivity.ONLINE,
        operational: MachineOperational.RESERVED,
        moderationStatus: ModerationStatus.CLEAR,
        lastHeartbeatAt: now,
        lastCudaProbeOk: true,
        dockerAvailable: true,
        nvidiaRuntimeAvailable: true,
        virtualizationAvailable: true,
        verifiedAt: now,
        ramTotalMiB: 16_384,
        diskTotalMiB: 51_200,
        vramMiB: 4096,
        cudaVersion: '13.1',
      },
    });
    machineId = machine.id;

    const hardwareUuid = `GPU-auto-${suffix}`;
    await db.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machineId, [{
      schemaVersion: 1,
      kind: 'GPU',
      vendor: 'NVIDIA',
      model: 'NVIDIA GeForce GTX 1650',
      deviceId: hardwareUuid,
      busAddress: null,
      driverVersion: '592.82',
      runtimeVersion: '13.1',
      memoryTotalMiB: 4096,
      memoryUsedMiB: 0,
      utilizationPercent: 0,
      temperatureC: 45,
      powerWatts: 20,
      available: true,
      throttling: false,
      capabilities: {},
      metrics: {},
    }]));
    const accelerator = await db.accelerator.findUniqueOrThrow({ where: { machineId_hardwareUuid: { machineId, hardwareUuid } } });
    await db.accelerator.update({ where: { id: accelerator.id }, data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now } });

    const listing = await createExactGpuListing(db, {
      ownerId,
      machineId,
      acceleratorId: accelerator.id,
      title: 'auto Developer handoff test',
      description: 'fresh GPU_PROOF to Developer handoff',
      hourlySol: 0.01,
      now,
      heartbeatStaleAfterSeconds: 300,
    });
    listingId = listing.id;

    const booking = await db.booking.create({
      data: {
        buyerId: renterId,
        listingId,
        idempotencyKey: `idem_auto_${suffix}`,
        startsAt: now,
        endsAt: new Date(now.getTime() + 60 * 60_000),
        quotedLamports: 1_000_000n,
        expectedSeconds: 900,
        status: BookingStatus.AWAITING_DEPOSIT,
      },
    });
    bookingId = booking.id;
    await allocateBookingResources(db, { bookingId, buyerId: renterId });
    await db.booking.update({ where: { id: bookingId }, data: { status: BookingStatus.FUNDED } });

    const before = await db.machineWorkspace.findFirst({
      where: { machineId, workspace: { slug: 'developer' } },
    });
    assert.equal(before, null, 'fresh renter path must not depend on a pre-created Developer MachineWorkspace row');

    const outcome = await completeGpuProofJob(db, bookingId, machineId);
    assert.equal(outcome.bookingStatus, BookingStatus.STARTING);
    assert.equal(outcome.machineReleased, false);
    assert.equal(outcome.developerPreparationQueued, true);
    assert.ok(outcome.developerWorkspaceSessionId);

    const session = await db.workspaceSession.findUniqueOrThrow({
      where: { id: outcome.developerWorkspaceSessionId! },
      include: { machineWorkspace: { include: { workspace: true } }, job: true },
    });
    assert.equal(session.machineWorkspace.workspace.slug, 'developer');
    assert.equal(session.status, WorkspaceSessionStatus.PREPARING);
    assert.equal(session.preparationStep, 'GPU_PROOF_VERIFIED_AUTO_DEVELOPER');
    assert.equal(session.job?.type, 'WORKSPACE_PREPARE');
    assert.equal((session.job?.parameters as { workspaceSlug?: string })?.workspaceSlug, 'developer');

    const bookingAfter = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
    assert.equal(bookingAfter.status, BookingStatus.STARTING);
    const machineAfter = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
    assert.equal(machineAfter.operational, MachineOperational.RESERVED, 'GPU stays reserved while Developer prepares');
  } finally {
    if (bookingId) {
      await db.acceleratorAllocation.deleteMany({ where: { bookingId } }).catch(() => {});
      await db.workspaceSessionEvent.deleteMany({ where: { session: { bookingId } } }).catch(() => {});
      await db.workspaceSession.deleteMany({ where: { bookingId } }).catch(() => {});
      await db.job.deleteMany({ where: { bookingId } }).catch(() => {});
      await db.payment.deleteMany({ where: { bookingId } }).catch(() => {});
      await db.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    }
    if (machineId) {
      await db.machineWorkspace.deleteMany({ where: { machineId } }).catch(() => {});
      if (listingId) await db.gpuListing.deleteMany({ where: { id: listingId } }).catch(() => {});
      await db.accelerator.deleteMany({ where: { machineId } }).catch(() => {});
      await db.machine.deleteMany({ where: { id: machineId } }).catch(() => {});
    }
    if (renterId) await db.user.deleteMany({ where: { id: renterId } }).catch(() => {});
    if (ownerId) await db.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
    await db.$disconnect().catch(() => {});
  }
});
