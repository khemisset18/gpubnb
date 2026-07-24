import assert from 'node:assert/strict';
import test from 'node:test';
import { BookingStatus, PaymentStatus, type PrismaClient } from '@prisma/client';
import { confirmSettlement, requestSettlement } from '../src/settlement-transactions.js';

const id = (char: string) => `c${char.repeat(24)}`;
const validSignature = '3'.repeat(64);

function bookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: id('b'),
    buyerId: id('u'),
    listingId: id('l'),
    startsAt: new Date('2026-07-01T10:00:00.000Z'),
    endsAt: new Date('2026-07-01T11:00:00.000Z'),
    quotedLamports: 3_600_000_000n,
    validSeconds: 1_800,
    expectedSeconds: 3_600,
    status: BookingStatus.COMPLETED,
    listing: { machineId: id('m') },
    payment: {
      id: id('p'),
      bookingId: id('b'),
      grossLamports: 3_600_000_000n,
      payableLamports: 0n,
      platformLamports: 0n,
      providerLamports: 0n,
      refundLamports: 0n,
      status: PaymentStatus.ESCROW_FUNDED,
      settlementSignature: null,
    },
    ...overrides,
  };
}

function fakeDb(fixture: ReturnType<typeof bookingFixture>) {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const tx = {
    $queryRaw: async () => [{ id: fixture.id }],
    $executeRaw: async () => { calls.push({ kind: 'outbox' }); return 1; },
    booking: {
      findUnique: async () => fixture,
      update: async ({ data }: { data: unknown }) => { calls.push({ kind: 'booking.update', value: data }); return fixture; },
    },
    payment: {
      update: async ({ data }: { data: unknown }) => { calls.push({ kind: 'payment.update', value: data }); return fixture.payment; },
    },
  };
  const db = {
    $transaction: async (handler: (client: typeof tx) => Promise<unknown>) => handler(tx),
    booking: { findUnique: async () => fixture },
  } as unknown as PrismaClient;
  return { db, calls };
}

test('requestSettlement atomically persists calculated settlement and outbox event', async () => {
  const { db, calls } = fakeDb(bookingFixture());
  const result = await requestSettlement(db, id('b'));

  assert.equal(result.settlement.grossLamports, 3_600_000_000n);
  assert.equal(result.settlement.payableLamports, 1_800_000_000n);
  assert.equal(result.settlement.refundLamports, 1_800_000_000n);
  assert.ok(calls.some((call) => call.kind === 'payment.update'));
  assert.ok(calls.some((call) => call.kind === 'outbox'));
});

test('confirmSettlement creates a partial refund and settles booking once', async () => {
  const fixture = bookingFixture({
    payment: {
      ...bookingFixture().payment,
      status: PaymentStatus.SETTLEMENT_PENDING,
    },
  });
  const { db, calls } = fakeDb(fixture);
  const result = await confirmSettlement(db, id('b'), validSignature);

  assert.equal(result.bookingStatus, BookingStatus.SETTLED);
  assert.equal(result.paymentStatus, PaymentStatus.PARTIALLY_REFUNDED);
  assert.equal(result.idempotent, false);
  const paymentUpdate = calls.find((call) => call.kind === 'payment.update');
  assert.deepEqual(paymentUpdate?.value, {
    status: PaymentStatus.PARTIALLY_REFUNDED,
    settlementSignature: validSignature,
  });
});

test('confirmSettlement is idempotent for the same finalized signature', async () => {
  const fixture = bookingFixture({
    status: BookingStatus.SETTLED,
    payment: {
      ...bookingFixture().payment,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      settlementSignature: validSignature,
    },
  });
  const { db, calls } = fakeDb(fixture);
  const result = await confirmSettlement(db, id('b'), validSignature);

  assert.equal(result.idempotent, true);
  assert.equal(calls.length, 0);
});

test('confirmSettlement refuses a conflicting signature', async () => {
  const fixture = bookingFixture({
    status: BookingStatus.SETTLED,
    payment: {
      ...bookingFixture().payment,
      status: PaymentStatus.RELEASED,
      settlementSignature: validSignature,
    },
  });
  const { db } = fakeDb(fixture);
  await assert.rejects(
    () => confirmSettlement(db, id('b'), '4'.repeat(64)),
    /settlement_signature_conflict/,
  );
});

test('requestSettlement refuses an escrow amount mismatch', async () => {
  const fixture = bookingFixture({
    payment: { ...bookingFixture().payment, grossLamports: 1n },
  });
  const { db, calls } = fakeDb(fixture);
  await assert.rejects(() => requestSettlement(db, id('b')), /escrow_amount_mismatch/);
  assert.equal(calls.length, 0);
});
