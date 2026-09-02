import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  BookingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  PrismaClient,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { Redis } from 'ioredis';

// Real concurrency tests against a real local Postgres+Redis for the two remaining
// confirmed sites: finalizeVerifiedDeveloperStop (workspace-stop-finalizer.ts) and
// confirmSettlement (settlement-transactions.ts), both now wrapped in
// runBookingTransaction. Skips cleanly if no local Postgres/Redis is reachable.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { finalizeVerifiedDeveloperStop } = await import('../src/workspace-stop-finalizer.js');
const { requestSettlement, confirmSettlement } = await import('../src/settlement-transactions.js');
const { ensureCompatibleMachineWorkspace } = await import('../src/machine-workspace-catalog.js');

const hasDb = Boolean(process.env.DATABASE_URL);

function base58Signature(seed: string): string {
  // 44 base58 chars, matching SIGNATURE_PATTERN in settlement-transactions.ts.
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  let h = crypto.createHash('sha256').update(seed).digest();
  while (out.length < 44) {
    h = crypto.createHash('sha256').update(h).digest();
    for (const byte of h) {
      out += alphabet[byte % alphabet.length];
      if (out.length >= 44) break;
    }
  }
  return out;
}

async function seedBooking(prisma: PrismaClient, suffix: string, options: { bookingStatus: BookingStatus; paymentStatus: PaymentStatus }) {
  const now = new Date();
  const owner = await prisma.user.create({ data: { wallet: `owner_stopset_${suffix}`, pseudonym: `owner_stopset_${suffix}`, canHost: true } });
  const renter = await prisma.user.create({ data: { wallet: `renter_stopset_${suffix}`, pseudonym: `renter_stopset_${suffix}` } });
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id, agentPublicKey: `agentkey_stopset_${suffix}`, agentVersion: '0.6.2',
      connectivity: MachineConnectivity.ONLINE, operational: MachineOperational.RESERVED, moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now, lastCudaProbeOk: true, dockerAvailable: true, nvidiaRuntimeAvailable: true,
      virtualizationAvailable: true, verifiedAt: now, ramTotalMiB: 16_384, diskTotalMiB: 51_200,
      vramMiB: 4_096, cudaVersion: '12.4',
    },
  });
  const listing = await prisma.gpuListing.create({
    data: { ownerId: owner.id, machineId: machine.id, title: `stop/settlement test ${suffix}`, description: 'Seeded by concurrency-stop-and-settlement.test.ts', hourlyLamports: 1_000_000n, status: 'ACTIVE' },
  });
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id, listingId: listing.id, idempotencyKey: `idem_stopset_${suffix}`,
      startsAt: new Date(now.getTime() - 3_600_000), endsAt: new Date(now.getTime() - 60_000),
      quotedLamports: 1_000_000n, validSeconds: 3600, expectedSeconds: 3600, status: options.bookingStatus,
    },
  });
  await prisma.payment.create({ data: { bookingId: booking.id, grossLamports: 1_000_000n, status: options.paymentStatus } });
  return {
    owner, renter, machine, listing, booking,
    async cleanup() {
      await prisma.workspaceSessionEvent.deleteMany({ where: { session: { bookingId: booking.id } } }).catch(() => {});
      await prisma.workspaceSession.deleteMany({ where: { bookingId: booking.id } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { bookingId: booking.id } }).catch(() => {});
      await prisma.booking.delete({ where: { id: booking.id } }).catch(() => {});
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

function withPrismaAndRedis(name: string, run: (prisma: PrismaClient, redis: Redis, t: import('node:test').TestContext) => Promise<void>) {
  test(name, { skip: !hasDb }, async (t) => {
    const prisma = new PrismaClient();
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
    try {
      await prisma.$connect();
      redis.on('error', () => {});
      await redis.connect();
    } catch (error) {
      t.skip(`no reachable local Postgres/Redis for this test: ${(error as Error).message}`);
      await prisma.$disconnect().catch(() => {});
      redis.disconnect();
      return;
    }
    try {
      await run(prisma, redis, t);
    } finally {
      await prisma.$disconnect();
      redis.disconnect();
    }
  });
}

withPrismaAndRedis('two concurrent finalizations of the same Developer stop: only one does the real work, the other is a clean idempotent no-op', async (prisma, redis) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBooking(prisma, suffix, { bookingStatus: BookingStatus.ACTIVE, paymentStatus: PaymentStatus.ESCROW_FUNDED });
  try {
    const machineWorkspace = await ensureCompatibleMachineWorkspace(prisma, seed.machine.id, 'developer');
    const activatedAt = new Date(Date.now() - 120_000);
    const session = await prisma.workspaceSession.create({
      data: {
        bookingId: seed.booking.id, renterId: seed.renter.id, machineId: seed.machine.id, machineWorkspaceId: machineWorkspace.id,
        status: WorkspaceSessionStatus.STOP_REQUESTED, isolationType: 'DOCKER', resourceLimits: {},
        startedAt: activatedAt, readyAt: activatedAt, expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => finalizeVerifiedDeveloperStop(prisma, redis, session.id, seed.machine.id)),
    );
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof finalizeVerifiedDeveloperStop>>> => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 6, `every concurrent finalize call must resolve cleanly (idempotent), not throw: ${results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason).join(', ')}`);

    const notAlreadyFinalized = fulfilled.filter((r) => r.value.alreadyFinalized === false);
    assert.equal(notAlreadyFinalized.length, 1, 'exactly one caller must have actually performed the finalization');
    for (const r of fulfilled) {
      assert.equal(r.value.sessionId, session.id);
      assert.equal(r.value.activated, true);
    }

    const finalSession = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(finalSession.status, WorkspaceSessionStatus.COMPLETED, 'session must settle into exactly one terminal status, not flip-flop');
    assert.ok(finalSession.endedAt);

    const events = await prisma.workspaceSessionEvent.findMany({ where: { sessionId: session.id, action: 'GATEWAY_CLEANUP_VERIFIED' } });
    assert.equal(events.length, 1, 'the finalization side effect (event row) must happen exactly once, not once per concurrent caller');
  } finally {
    await seed.cleanup();
  }
});

withPrisma('concurrent settlement request calls on the same booking never double-charge the settlement calculation', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBooking(prisma, suffix, { bookingStatus: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.ESCROW_FUNDED });
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => requestSettlement(prisma, seed.booking.id)),
    );
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof requestSettlement>>> => r.status === 'fulfilled');
    // Every call recomputes the same deterministic settlement and writes the same
    // SETTLEMENT_PENDING status - all concurrent callers succeeding with an identical
    // result is the correct idempotent behavior here (there is no signature yet to
    // conflict over), not a sign of a race.
    assert.ok(fulfilled.length >= 1, 'at least one concurrent request must succeed');
    for (const r of fulfilled) {
      assert.equal(r.value.settlement.payableLamports + r.value.settlement.refundLamports, r.value.settlement.grossLamports);
    }
    const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: seed.booking.id } });
    assert.equal(payment.status, PaymentStatus.SETTLEMENT_PENDING);
  } finally {
    await seed.cleanup();
  }
});

withPrisma('concurrent confirmSettlement calls with the SAME signature settle exactly once - no double settlement, no double refund', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBooking(prisma, suffix, { bookingStatus: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.SETTLEMENT_PENDING });
  try {
    const signature = base58Signature(`confirm_${suffix}`);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => confirmSettlement(prisma, seed.booking.id, signature)),
    );
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof confirmSettlement>>> => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 8, `every concurrent confirm with the same signature must resolve idempotently, not throw: ${results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason).join(', ')}`);

    const firstTime = fulfilled.filter((r) => r.value.idempotent === false);
    assert.equal(firstTime.length, 1, 'exactly one caller must have actually performed the settlement write');
    for (const r of fulfilled) {
      assert.equal(r.value.settlementSignature, signature);
      assert.equal(r.value.bookingStatus, BookingStatus.SETTLED);
    }

    const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: seed.booking.id } });
    assert.equal(payment.settlementSignature, signature);
    assert.equal(payment.status, PaymentStatus.RELEASED, 'no refund/partial-refund path should trigger for a fully payable settlement');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: seed.booking.id } });
    assert.equal(booking.status, BookingStatus.SETTLED, 'booking must settle into exactly one terminal status under concurrent confirmation');
  } finally {
    await seed.cleanup();
  }
});

withPrisma('confirmSettlement with a DIFFERENT signature than the one already recorded is cleanly rejected, never silently overwritten', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedBooking(prisma, suffix, { bookingStatus: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.SETTLEMENT_PENDING });
  try {
    const realSignature = base58Signature(`real_${suffix}`);
    const forgedSignature = base58Signature(`forged_${suffix}`);
    const first = await confirmSettlement(prisma, seed.booking.id, realSignature);
    assert.equal(first.idempotent, false);

    await assert.rejects(
      () => confirmSettlement(prisma, seed.booking.id, forgedSignature),
      (e: unknown) => e instanceof Error && e.message === 'settlement_signature_conflict',
    );

    const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: seed.booking.id } });
    assert.equal(payment.settlementSignature, realSignature, 'the original recorded signature must never be overwritten by a conflicting one');
  } finally {
    await seed.cleanup();
  }
});
