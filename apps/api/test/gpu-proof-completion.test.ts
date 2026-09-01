import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  BookingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PrismaClient,
  ResourceAllocationStatus,
} from '@prisma/client';

// config.ts validates PLATFORM_WALLET (and friends) as required at import time.
// ci.yml only generates SESSION_SECRET/INTERNAL_SERVICE_TOKEN for the api job, so
// give every other module under test the same defensive fallback already used by
// rental-marketplace-routes.integration.test.ts. Static imports are hoisted before
// any other top-level statement, so every import that transitively reaches
// config.ts must be dynamic here, evaluated after these fallbacks are in place.
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
const { ensureCompatibleMachineWorkspace } = await import('../src/machine-workspace-catalog.js');
import type { AcceleratorTelemetry } from '../src/accelerator-telemetry.js';

// Real-DB integration tests for completeGpuProofJob (called from
// /agent/jobs/:id/finalize-proof). GPU_PROOF completing must not silently end a
// booking that may still request a Developer workspace on the same accelerator -
// this exercises the actual production function against real Postgres rows, not a
// re-simulation of its logic. Skips cleanly if no local Postgres is reachable
// (same convention as e2e-gpu-rental-lifecycle.test.ts).

const hasDb = Boolean(process.env.DATABASE_URL);

function gpu(deviceId: string): AcceleratorTelemetry {
  return {
    schemaVersion: 1,
    kind: 'GPU',
    vendor: 'NVIDIA',
    model: 'NVIDIA Test GPU',
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

async function seedBookedMachine(prisma: PrismaClient, suffix: string) {
  const hardwareUuid = `GPU-fin-${suffix}`;
  const now = new Date();
  const owner = await prisma.user.create({ data: { wallet: `owner_fin_${suffix}`, pseudonym: `owner_fin_${suffix}`, canHost: true } });
  const renter = await prisma.user.create({ data: { wallet: `renter_fin_${suffix}`, pseudonym: `renter_fin_${suffix}` } });
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_fin_${suffix}`,
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
      cudaVersion: '12.4',
    },
  });
  await prisma.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machine.id, [gpu(hardwareUuid)]));
  const accelerator = await prisma.accelerator.findUniqueOrThrow({ where: { machineId_hardwareUuid: { machineId: machine.id, hardwareUuid } } });
  await prisma.accelerator.update({ where: { id: accelerator.id }, data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now } });
  const listing = await createExactGpuListing(prisma, {
    ownerId: owner.id,
    machineId: machine.id,
    acceleratorId: accelerator.id,
    title: 'finalize-proof test listing',
    description: 'Seeded by gpu-proof-completion.test.ts',
    hourlySol: 0.01,
    now,
    heartbeatStaleAfterSeconds: 60,
  });
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id,
      listingId: listing.id,
      idempotencyKey: `idem_fin_${suffix}`,
      startsAt: new Date(now.getTime() - 25 * 60_000), // simulates a booking that has been open a while (e.g. a slow GPU_PROOF)
      endsAt: new Date(now.getTime() + 3_600_000),
      quotedLamports: 1_000_000n,
      expectedSeconds: 600,
      status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  await allocateBookingResources(prisma, { bookingId: booking.id, buyerId: renter.id });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.ACTIVE } });
  return {
    owner, renter, machine, accelerator, listing, booking,
    async cleanup() {
      await prisma.acceleratorAllocation.deleteMany({ where: { bookingId: booking.id } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { listingId: listing.id } }).catch(() => {});
      await prisma.machineWorkspace.deleteMany({ where: { machineId: machine.id } }).catch(() => {});
      await prisma.gpuListing.delete({ where: { id: listing.id } }).catch(() => {});
      await prisma.machine.delete({ where: { id: machine.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: renter.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

function withPrisma(name: string, run: (prisma: PrismaClient, t: import('node:test').TestContext) => Promise<void>) {
  test(name, { skip: !hasDb }, async (t) => {
    const prisma = new PrismaClient();
    try {
      await prisma.$connect();
    } catch (error) {
      t.skip(`no reachable local Postgres for this test: ${(error as Error).message}`);
      await prisma.$disconnect().catch(() => {});
      return;
    }
    try {
      await run(prisma, t);
    } finally {
      await prisma.$disconnect();
    }
  });
}

// TEST 1 — GPU_PROOF seul: comportement actuel conservé.
withPrisma('GPU_PROOF-only booking (no compatible Developer workspace) completes and releases the machine exactly as before', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBookedMachine(prisma, suffix);
  try {
    const outcome = await completeGpuProofJob(prisma, seed.booking.id, seed.machine.id);
    assert.equal(outcome.bookingStatus, BookingStatus.COMPLETED);
    assert.equal(outcome.machineReleased, true);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(booking.status, BookingStatus.COMPLETED);
    const machine = await prisma.machine.findUniqueOrThrow({ where: { id: seed.machine.id } });
    assert.equal(machine.operational, MachineOperational.AVAILABLE);
  } finally {
    await seed.cleanup();
  }
});

// TEST 2 — Developer Workspace disponible : la location n'est PAS clôturée, le GPU reste réservé.
withPrisma('a booking on a Developer-capable machine is kept alive and the GPU stays locked to it', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBookedMachine(prisma, suffix);
  try {
    await ensureCompatibleMachineWorkspace(prisma, seed.machine.id, 'developer');

    const outcome = await completeGpuProofJob(prisma, seed.booking.id, seed.machine.id);
    assert.equal(outcome.bookingStatus, BookingStatus.STARTING);
    assert.equal(outcome.machineReleased, false);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(booking.status, BookingStatus.STARTING);
    assert.notEqual(booking.status, BookingStatus.COMPLETED);

    // Point critique: le GPU ne doit JAMAIS redevenir AVAILABLE entre GPU_PROOF
    // COMPLETED et l'ouverture réelle du Developer Workspace.
    const machine = await prisma.machine.findUniqueOrThrow({ where: { id: seed.machine.id } });
    assert.notEqual(machine.operational, MachineOperational.AVAILABLE);
    assert.equal(machine.operational, MachineOperational.RESERVED);
  } finally {
    await seed.cleanup();
  }
});

// TEST 8 — même si GPU_PROOF (ou l'attente qui précède) a pris longtemps, la fenêtre
// de sécurité pour demander le workspace repart à zéro à partir de maintenant.
withPrisma('startsAt/endsAt are refreshed to now regardless of how long the booking had already been open', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBookedMachine(prisma, suffix); // seeded with startsAt 25 minutes in the past
  try {
    await ensureCompatibleMachineWorkspace(prisma, seed.machine.id, 'developer');
    const before = Date.now();
    await completeGpuProofJob(prisma, seed.booking.id, seed.machine.id);
    const after = Date.now();

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.ok(booking.startsAt.getTime() >= before - 1000 && booking.startsAt.getTime() <= after + 1000, 'startsAt must be refreshed to "now", not left 25 minutes in the past');
    assert.ok(booking.endsAt.getTime() > booking.startsAt.getTime(), 'endsAt must give a real window after the refreshed startsAt');
  } finally {
    await seed.cleanup();
  }
});

// TEST 10 — race condition : le GPU ne doit pas devenir réservable par une deuxième
// location tant que la première n'a pas réellement terminé son Developer Workspace.
withPrisma('a second booking cannot claim the same accelerator while the first is waiting to open its Developer workspace', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBookedMachine(prisma, suffix);
  try {
    await ensureCompatibleMachineWorkspace(prisma, seed.machine.id, 'developer');
    await completeGpuProofJob(prisma, seed.booking.id, seed.machine.id);

    // Starts after the first booking's refreshed endsAt (now + STALLED_ACTIVATION_GRACE_MS),
    // so this specifically isolates the accelerator-availability guard below from the
    // separate booking_no_overlap DB exclusion constraint (a real, independent defense
    // this same call would also trip if the two windows overlapped in time).
    const secondBooking = await prisma.booking.create({
      data: {
        buyerId: seed.renter.id,
        listingId: seed.listing.id,
        idempotencyKey: `idem_fin2_${suffix}`,
        startsAt: new Date(Date.now() + 21 * 60_000),
        endsAt: new Date(Date.now() + 22 * 60_000),
        quotedLamports: 1_000_000n,
        expectedSeconds: 60,
        status: BookingStatus.AWAITING_DEPOSIT,
      },
    });
    try {
      // completeGpuProofJob deliberately never touches AcceleratorAllocation: the first
      // booking's row is still HELD/CONFIRMED/ACTIVE over its own time range, so the
      // database's own AcceleratorAllocation_no_overlap exclusion constraint (not just
      // the accelerator_not_rentable application check) independently refuses a second
      // live allocation on the same physical accelerator.
      await assert.rejects(() => allocateBookingResources(prisma, { bookingId: secondBooking.id, buyerId: seed.renter.id }));
      const firstAllocation = await prisma.acceleratorAllocation.findFirstOrThrow({ where: { bookingId: seed.booking.id, acceleratorId: seed.accelerator.id } });
      assert.ok(
        ([ResourceAllocationStatus.HELD, ResourceAllocationStatus.CONFIRMED, ResourceAllocationStatus.ACTIVE] as ResourceAllocationStatus[]).includes(firstAllocation.status),
        'the first booking must still hold its allocation - completeGpuProofJob must not have released it',
      );
    } finally {
      await prisma.booking.delete({ where: { id: secondBooking.id } }).catch(() => {});
    }
  } finally {
    await seed.cleanup();
  }
});

// TEST 11 (partiel, côté serveur) — appeler completeGpuProofJob n'importe quand
// n'a d'effet que sur un booking encore FUNDED/STARTING/ACTIVE : un booking déjà
// terminé/annulé n'est jamais rouvert ou réécrit.
withPrisma('completeGpuProofJob never mutates a booking that already reached a different terminal status', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBookedMachine(prisma, suffix);
  try {
    await prisma.booking.update({ where: { id: seed.booking.id }, data: { status: BookingStatus.CANCELLED } });
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });

    await completeGpuProofJob(prisma, seed.booking.id, seed.machine.id);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(after.status, BookingStatus.CANCELLED);
    assert.deepEqual(after.startsAt, before.startsAt);
    assert.deepEqual(after.endsAt, before.endsAt);
  } finally {
    await seed.cleanup();
  }
});
