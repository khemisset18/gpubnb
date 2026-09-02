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

// config.ts validates PLATFORM_WALLET (and friends) as required at import time - same
// defensive fallback used by every other real-DB test file in this repo.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { activateGatewaySession } = await import('../src/workspace-gateway.js');
const { ensureCompatibleMachineWorkspace } = await import('../src/machine-workspace-catalog.js');

// Real gap found live during the PC A <-> PC B test: activateGatewaySession is the one
// true start of the commercial rental clock (a real upstream frame proven exchanged with
// the renter's browser - see the two ws-frame call sites in workspace-gateway.ts), but it
// used to require booking.status===STARTING exactly. The private-beta GPU_DIAGNOSTIC path
// (dev-booking-reconciler.ts) can already move a booking straight to ACTIVE - proving the
// GPU works - well before any interactive workspace ever opens. When that happens first
// (as it did in the real test), the guard rejected activation outright
// (interactive_workspace_not_activatable), and even where it didn't, endsAt was never
// reset to the real purchased duration from the real open time. workspaceActivatedAt
// (Booking, new column) is now the single, unambiguous idempotency marker for "has the
// real clock started" - independent of which path got the booking to STARTING/ACTIVE.
//
// Skips cleanly if no local Postgres is reachable (same convention as
// gpu-proof-completion.test.ts / workspace-gateway-register-e2e.test.ts).

const hasDb = Boolean(process.env.DATABASE_URL);

async function seedReadySession(prisma: PrismaClient, suffix: string, options: {
  bookingStatus: BookingStatus;
  expectedSeconds: number;
  bookingStartsAt?: Date;
  bookingEndsAt?: Date;
  workspaceActivatedAt?: Date | null;
}) {
  const now = new Date();
  const owner = await prisma.user.create({ data: { wallet: `owner_act_${suffix}`, pseudonym: `owner_act_${suffix}`, canHost: true } });
  const renter = await prisma.user.create({ data: { wallet: `renter_act_${suffix}`, pseudonym: `renter_act_${suffix}` } });
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_act_${suffix}`,
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.RESERVED,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now,
      lastCudaProbeOk: true,
      cudaVersion: '12.4',
      vramMiB: 4_096,
      dockerAvailable: true,
      nvidiaRuntimeAvailable: true,
      virtualizationAvailable: true,
      verifiedAt: now,
      ramTotalMiB: 16_384,
      diskTotalMiB: 51_200,
    },
  });
  const machineWorkspace = await ensureCompatibleMachineWorkspace(prisma, machine.id, 'developer');
  const listing = await prisma.gpuListing.create({
    data: {
      ownerId: owner.id, machineId: machine.id,
      title: `activation test listing ${suffix}`, description: 'Seeded by workspace-activation-timer.test.ts',
      hourlyLamports: 1_000_000n, status: 'ACTIVE',
    },
  });
  const bookingStartsAt = options.bookingStartsAt ?? now;
  const bookingEndsAt = options.bookingEndsAt ?? new Date(now.getTime() + 3_600_000);
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id, listingId: listing.id, idempotencyKey: `idem_act_${suffix}`,
      startsAt: bookingStartsAt, endsAt: bookingEndsAt,
      quotedLamports: 1_000_000n, expectedSeconds: options.expectedSeconds,
      status: options.bookingStatus,
      ...(options.workspaceActivatedAt !== undefined ? { workspaceActivatedAt: options.workspaceActivatedAt } : {}),
    },
  });
  await prisma.machineAllocation.create({
    data: { bookingId: booking.id, machineId: machine.id, status: 'ACTIVE', startsAt: bookingStartsAt, endsAt: bookingEndsAt },
  });
  const job = await prisma.job.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id,
      type: 'WORKSPACE_PREPARE', parameters: { workspaceSlug: 'developer', timeoutSeconds: 1200 },
      status: 'COMPLETED', finishedAt: now,
    },
  });
  const session = await prisma.workspaceSession.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id,
      machineWorkspaceId: machineWorkspace.id, jobId: job.id,
      status: WorkspaceSessionStatus.READY, isolationType: 'DOCKER',
      resourceLimits: { maxRamMiB: 4096, maxCpuCores: 2, storageQuotaMiB: 10240, networkAccess: 'RESTRICTED', autoStopMinutes: 60 },
      connectionType: 'GPUBNB_GATEWAY', connectionMetadata: { gatewayPath: `/workspace-gateway/placeholder` },
      preparationProgress: 100, preparationStep: 'CONNECTION_READY',
      readyAt: now, expiresAt: bookingEndsAt,
    },
  });
  return {
    owner, renter, machine, listing, booking, session,
    async cleanup() {
      await prisma.workspaceSessionEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
      await prisma.workspaceSession.deleteMany({ where: { id: session.id } }).catch(() => {});
      await prisma.job.deleteMany({ where: { id: job.id } }).catch(() => {});
      await prisma.machineAllocation.deleteMany({ where: { bookingId: booking.id } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: booking.id } }).catch(() => {});
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

withPrisma('activates from STARTING exactly as before: booking becomes ACTIVE, real clock starts', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedReadySession(prisma, suffix, { bookingStatus: BookingStatus.STARTING, expectedSeconds: 900 });
  try {
    const before = Date.now();
    const result = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    const after = Date.now();
    assert.ok(result?.activated, JSON.stringify(result));

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(booking.status, BookingStatus.ACTIVE);
    assert.ok(booking.workspaceActivatedAt, 'workspaceActivatedAt must be set');
    assert.ok(booking.workspaceActivatedAt!.getTime() >= before - 1000 && booking.workspaceActivatedAt!.getTime() <= after + 1000);
    assert.equal(booking.endsAt.getTime() - booking.workspaceActivatedAt!.getTime(), 900_000, 'endsAt must be exactly expectedSeconds after the real activation moment');
  } finally {
    await seed.cleanup();
  }
});

// THE fix: previously required booking.status===STARTING exactly, so a booking already
// ACTIVE via the GPU_DIAGNOSTIC path (proving the GPU, unrelated to this interactive
// activation) was rejected outright - interactive_workspace_not_activatable - breaking
// the Developer workspace connection entirely.
withPrisma('also activates from ACTIVE (the GPU_DIAGNOSTIC beta-bypass path already proved the GPU before any workspace opened)', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedReadySession(prisma, suffix, { bookingStatus: BookingStatus.ACTIVE, expectedSeconds: 900, workspaceActivatedAt: null });
  try {
    const result = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    assert.ok(result?.activated, JSON.stringify(result));
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(booking.status, BookingStatus.ACTIVE);
    assert.ok(booking.workspaceActivatedAt);
  } finally {
    await seed.cleanup();
  }
});

// The 15-minute example from the spec: GPU Proof + waiting ate 8 minutes of wall-clock
// time before the workspace ever opened. Once it does, the renter must get the full 15
// minutes from that moment - not 15 minus the 8 already elapsed since booking creation.
withPrisma('a 15-minute booking still grants a full ~15 minutes after activation, even though 8 minutes already elapsed since booking creation', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const eightMinutesAgo = new Date(Date.now() - 8 * 60_000);
  const seed = await seedReadySession(prisma, suffix, {
    bookingStatus: BookingStatus.STARTING,
    expectedSeconds: 15 * 60,
    bookingStartsAt: eightMinutesAgo,
    bookingEndsAt: new Date(eightMinutesAgo.getTime() + 20 * 60_000), // a stale STARTING-safety window, not the real 15 minutes
  });
  try {
    const before = Date.now();
    const result = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    assert.ok(result?.activated);
    const remainingSeconds = (result!.expiresAt.getTime() - before) / 1000;
    // Must be very close to a full 15 minutes (900s) from activation - a few hundred ms of
    // slack only for this test's own execution time between reading `before` and the
    // activation transaction's own `new Date()`, never anywhere near the ~7 minutes it
    // would be if the 8 already-elapsed minutes had been deducted.
    assert.ok(remainingSeconds > 899 && remainingSeconds <= 901, `expected ~900s (15 minutes) remaining, got ${remainingSeconds}s`);
  } finally {
    await seed.cleanup();
  }
});

withPrisma('is idempotent: a second call (refresh, reconnect, double click) never re-extends the deadline', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedReadySession(prisma, suffix, { bookingStatus: BookingStatus.STARTING, expectedSeconds: 900 });
  try {
    const first = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    assert.ok(first?.activated);
    const bookingAfterFirst = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });

    const second = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    assert.deepEqual(second, { activated: false, expiresAt: first!.expiresAt }, 'second call must be a pure idempotent read');

    const bookingAfterSecond = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.deepEqual(bookingAfterSecond.endsAt, bookingAfterFirst.endsAt, 'endsAt must not move on a second activation');
    assert.deepEqual(bookingAfterSecond.workspaceActivatedAt, bookingAfterFirst.workspaceActivatedAt);
  } finally {
    await seed.cleanup();
  }
});

withPrisma('refuses to activate a session that is not actually READY yet', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedReadySession(prisma, suffix, { bookingStatus: BookingStatus.STARTING, expectedSeconds: 900 });
  try {
    await prisma.workspaceSession.update({ where: { id: seed.session.id }, data: { status: WorkspaceSessionStatus.PREPARING } });
    const result = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    assert.equal(result, null);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(booking.workspaceActivatedAt, null);
  } finally {
    await seed.cleanup();
  }
});

withPrisma('refuses to activate a booking in a status that was never eligible in the first place', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedReadySession(prisma, suffix, { bookingStatus: BookingStatus.FUNDED, expectedSeconds: 900 });
  try {
    const result = await activateGatewaySession(prisma, seed.session.id, seed.machine.id);
    assert.equal(result, null, 'FUNDED must still go through /register first, not straight to interactive activation');
  } finally {
    await seed.cleanup();
  }
});
