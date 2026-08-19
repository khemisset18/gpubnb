import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  PrismaClient,
  ResourceAllocationStatus,
} from '@prisma/client';

import { reconcileOrphanedDepositBookings } from '../src/dev-booking-reconciler.js';

// Real-database regression for the crash-orphan gap identified in the previous audit
// pass: POST /bookings creates the Booking row and calls allocateBookingResources() as
// two separate transactions. If the API process dies in between and the original client
// never retries with the same idempotencyKey, the Booking is stuck AWAITING_DEPOSIT with
// zero allocation forever - and booking_no_overlap (EXCLUDE on listingId + time range,
// scoped to AWAITING_DEPOSIT and later) blocks that listing's exact time slot forever too.
//
// Every scenario runs inside one rolled-back Prisma transaction (never committed), so
// this leaves zero footprint in a shared local/CI database regardless of pass or fail.
//
// Skips cleanly if no local Postgres is reachable.

const hasDb = Boolean(process.env.DATABASE_URL);
const ROLLBACK = Symbol('deliberate-test-rollback');

async function seedListing(tx: PrismaClient, suffix: string) {
  const owner = await tx.user.create({
    data: { wallet: `owner_${suffix}`, pseudonym: `owner_${suffix}`, canHost: true },
  });
  const buyer = await tx.user.create({
    data: { wallet: `buyer_${suffix}`, pseudonym: `buyer_${suffix}` },
  });
  const machine = await tx.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_${suffix}`,
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.AVAILABLE,
    },
  });
  const listing = await tx.gpuListing.create({
    data: {
      ownerId: owner.id,
      machineId: machine.id,
      title: 'Orphan reconciler test listing',
      description: 'Seeded by orphaned-deposit-booking-reconciler.test.ts',
      hourlyLamports: 1_000_000n,
      status: ListingStatus.ACTIVE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    },
  });
  return { owner, buyer, machine, listing };
}

async function createBooking(
  tx: PrismaClient,
  buyerId: string,
  listingId: string,
  suffix: string,
  createdAt: Date,
  overrides: { status?: BookingStatus } = {},
) {
  const booking = await tx.booking.create({
    data: {
      buyerId,
      listingId,
      idempotencyKey: `idem_${suffix}`,
      startsAt: new Date(createdAt.getTime() + 3_600_000),
      endsAt: new Date(createdAt.getTime() + 7_200_000),
      quotedLamports: 1_000_000n,
      expectedSeconds: 60,
      status: overrides.status ?? BookingStatus.AWAITING_DEPOSIT,
    },
  });
  // createdAt has @default(now()) with no updatable field in the schema exposed via the
  // normal client API for this model, so backdate it with a raw update to simulate age.
  await tx.$executeRaw`UPDATE "Booking" SET "createdAt" = ${createdAt} WHERE "id" = ${booking.id}`;
  return booking;
}

async function withRollback(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaClient);
      throw ROLLBACK;
    }, { timeout: 10_000 });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

test('reconcileOrphanedDepositBookings', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
  } catch (error) {
    t.skip(`no reachable local Postgres for this integration test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    return;
  }
  t.after(() => prisma.$disconnect());

  await t.test('cancels a truly orphaned AWAITING_DEPOSIT booking past the grace period', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    let bookingId: string | undefined;
    let result: { cancelled: number } | undefined;

    await withRollback(prisma, async (tx) => {
      const { buyer, listing } = await seedListing(tx, suffix);
      const old = new Date(Date.now() - 10 * 60_000); // 10 minutes old, no allocation ever created
      const booking = await createBooking(tx, buyer.id, listing.id, suffix, old);
      bookingId = booking.id;

      result = await reconcileOrphanedDepositBookings(tx, new Date());

      const after = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
      assert.equal(after.status, BookingStatus.CANCELLED);
    });

    assert.equal(result?.cancelled, 1);
    assert.ok(bookingId);
  });

  await t.test('never touches a booking protected by a live accelerator allocation', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    let result: { cancelled: number } | undefined;

    await withRollback(prisma, async (tx) => {
      const { buyer, listing, machine } = await seedListing(tx, suffix);
      const old = new Date(Date.now() - 10 * 60_000);
      const booking = await createBooking(tx, buyer.id, listing.id, suffix, old);
      const accelerator = await tx.accelerator.create({
        data: { machineId: machine.id, hardwareUuid: `GPU-${suffix}`, model: 'Test GPU', vramMiB: 8192 },
      });
      await tx.acceleratorAllocation.create({
        data: {
          bookingId: booking.id,
          acceleratorId: accelerator.id,
          status: ResourceAllocationStatus.HELD,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
        },
      });

      result = await reconcileOrphanedDepositBookings(tx, new Date());

      const after = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
      assert.equal(
        after.status,
        BookingStatus.AWAITING_DEPOSIT,
        'a booking with a live allocation is genuinely pending payment, not an orphan - must never be cancelled by this reconciler',
      );
    });

    assert.equal(result?.cancelled, 0);
  });

  await t.test('never touches an unallocated booking still inside the grace period', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    let result: { cancelled: number } | undefined;

    await withRollback(prisma, async (tx) => {
      const { buyer, listing } = await seedListing(tx, suffix);
      const fresh = new Date(); // created "now" - could still be an in-flight request
      const booking = await createBooking(tx, buyer.id, listing.id, suffix, fresh);

      result = await reconcileOrphanedDepositBookings(tx, new Date());

      const after = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
      assert.equal(after.status, BookingStatus.AWAITING_DEPOSIT);
    });

    assert.equal(result?.cancelled, 0);
  });

  await t.test('is idempotent: a second run finds nothing left to cancel', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    const results: Array<{ cancelled: number }> = [];

    await withRollback(prisma, async (tx) => {
      const { buyer, listing } = await seedListing(tx, suffix);
      const old = new Date(Date.now() - 10 * 60_000);
      await createBooking(tx, buyer.id, listing.id, suffix, old);

      results.push(await reconcileOrphanedDepositBookings(tx, new Date()));
      results.push(await reconcileOrphanedDepositBookings(tx, new Date()));
    });

    assert.deepEqual(results.map((r) => r.cancelled), [1, 0]);
  });

  await t.test('is safe under concurrent execution: only one of two racing runs counts the cancellation', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    let totals: number[] = [];

    await withRollback(prisma, async (tx) => {
      const { buyer, listing } = await seedListing(tx, suffix);
      const old = new Date(Date.now() - 10 * 60_000);
      await createBooking(tx, buyer.id, listing.id, suffix, old);

      const [first, second] = await Promise.all([
        reconcileOrphanedDepositBookings(tx, new Date()),
        reconcileOrphanedDepositBookings(tx, new Date()),
      ]);
      totals = [first.cancelled, second.cancelled];
    });

    assert.equal(totals[0]! + totals[1]!, 1, 'the conditional updateMany count guard must prevent double-counting the same booking');
  });

  await t.test('never touches a FUNDED or otherwise non-AWAITING_DEPOSIT booking, however old', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    let result: { cancelled: number } | undefined;

    await withRollback(prisma, async (tx) => {
      const { buyer, listing } = await seedListing(tx, suffix);
      const old = new Date(Date.now() - 24 * 3_600_000);
      const booking = await createBooking(tx, buyer.id, listing.id, suffix, old, { status: BookingStatus.FUNDED });

      result = await reconcileOrphanedDepositBookings(tx, new Date());

      const after = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
      assert.equal(after.status, BookingStatus.FUNDED);
    });

    assert.equal(result?.cancelled, 0);
  });
});

test('the reconciliation interval runs reconcileOrphanedDepositBookings on every tick, independently of the other reconcilers failing', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const reconcileIntervalId=setInterval');
  assert.ok(start >= 0);
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end);

  assert.match(line, /reconcileOrphanedDepositBookings\(db,now\)/, 'the orphaned-deposit reconciler must actually be wired into the running interval');
  assert.ok(
    line.includes("reconcileOrphanedDepositBookings(db,now).then(result=>{if(result.cancelled>0)")
      && line.includes(".catch(err=>app.log.error({err},'orphaned_deposit_reconcile_failed'))"),
    'a failure in this reconciler must be caught independently and never block the other reconcilers on the same tick',
  );
});
