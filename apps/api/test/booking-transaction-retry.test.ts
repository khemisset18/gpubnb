import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { runBookingTransaction, isRetryableBookingTransactionError, BOOKING_BUSINESS_ERRORS } from '../src/booking-transaction-retry.js';

// Regression for a real finding from RC1 Phase 5 concurrent-booking chaos testing:
// firing two overlapping POST /bookings at the same time made Prisma's transaction
// fail with its own internal message ("Transaction API error: Unable to start a
// transaction in the given time.") instead of retrying or cleanly rejecting.

function serializationConflict() {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: 'test' },
  );
}

function transactionStartTimeout() {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction API error: Unable to start a transaction in the given time.',
    { code: 'P2028', clientVersion: 'test' },
  );
}

function fakeDb(behaviors: Array<() => unknown>) {
  let calls = 0;
  const transactionOptions: unknown[] = [];
  const db = {
    $transaction: async (fn: (tx: unknown) => unknown, options?: unknown) => {
      calls++;
      transactionOptions.push(options);
      const behavior = behaviors[calls - 1] ?? behaviors[behaviors.length - 1];
      const outcome = behavior();
      if (outcome instanceof Error) throw outcome;
      return fn(outcome as never);
    },
  };
  return { db: db as never, getCalls: () => calls, getTransactionOptions: () => transactionOptions };
}

test('1) a serialization conflict on the first attempt succeeds on retry', async () => {
  const { db, getCalls } = fakeDb([() => serializationConflict(), () => ({ ok: true })]);
  const result = await runBookingTransaction(db, async tx => tx, { maxAttempts: 3, baseDelayMs: 1 });
  assert.deepEqual(result, { ok: true });
  assert.equal(getCalls(), 2, 'must retry exactly once before succeeding');
});

test('2) a conflict repeated on every attempt is exhausted after maxAttempts and rethrown, not swallowed', async () => {
  const { db, getCalls } = fakeDb([
    () => transactionStartTimeout(),
    () => transactionStartTimeout(),
    () => transactionStartTimeout(),
  ]);
  await assert.rejects(
    () => runBookingTransaction(db, async tx => tx, { maxAttempts: 3, baseDelayMs: 1 }),
    (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2028',
  );
  assert.equal(getCalls(), 3, 'must attempt exactly maxAttempts times, no more, no fewer');
});

test('3) a real business rejection (time_slot_unavailable) is never retried', async () => {
  const { db, getCalls } = fakeDb([() => new Error('time_slot_unavailable'), () => ({ ok: true })]);
  await assert.rejects(
    () => runBookingTransaction(db, async tx => tx, { maxAttempts: 3, baseDelayMs: 1 }),
    (e: unknown) => e instanceof Error && e.message === 'time_slot_unavailable',
  );
  assert.equal(getCalls(), 1, 'a genuine slot conflict must fail on the first attempt, wasting no retries');
  assert.ok(BOOKING_BUSINESS_ERRORS.has('time_slot_unavailable'));
  assert.equal(isRetryableBookingTransactionError(new Error('time_slot_unavailable')), false);
});

test('4) an unrecognized error is never retried and is not classified as retryable', async () => {
  const { db, getCalls } = fakeDb([() => new TypeError('unexpected null reference'), () => ({ ok: true })]);
  await assert.rejects(
    () => runBookingTransaction(db, async tx => tx, { maxAttempts: 3, baseDelayMs: 1 }),
    (e: unknown) => e instanceof TypeError && e.message === 'unexpected null reference',
  );
  assert.equal(getCalls(), 1, 'an unknown error must not be retried');
  assert.equal(isRetryableBookingTransactionError(new TypeError('unexpected null reference')), false);
});

// Real gap found live during the PC A <-> PC B test: /agent/jobs/:id/complete and
// completeGpuProofJob (called by /finalize-proof) both ran their own raw db.$transaction
// under Serializable isolation, with no retry at all - unlike /bookings, which already
// used this exact helper for this exact error class. A P2034 there propagated straight to
// Fastify's generic 500 handler. Serializable must survive being wrapped in the retry -
// this only closes the gap if the isolation level is still actually threaded through to
// every attempt, not silently dropped.
test('5) the isolation level is passed through to every attempt, including retries - Serializable is not silently dropped', async () => {
  const { db, getTransactionOptions } = fakeDb([() => serializationConflict(), () => ({ ok: true })]);
  const result = await runBookingTransaction(db, async tx => tx, {
    maxAttempts: 3,
    baseDelayMs: 1,
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
  assert.deepEqual(result, { ok: true });
  const options = getTransactionOptions();
  assert.equal(options.length, 2, 'both the failed attempt and the retry must have run');
  for (const opts of options) {
    assert.deepEqual(opts, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
});

test('6) omitting isolationLevel keeps the previous default behaviour - no options object forced on callers that never asked for one', async () => {
  const { db, getTransactionOptions } = fakeDb([() => ({ ok: true })]);
  await runBookingTransaction(db, async tx => tx, { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(getTransactionOptions()[0], undefined);
});

// allocateBookingResources tunes maxWait/timeout independently of isolationLevel - both
// must survive the wrap unchanged, and neither may be forced onto a caller that only set
// isolationLevel (test 5 above) or vice versa.
test('7) maxWait and timeout are threaded through alongside isolationLevel, without forcing unrelated defaults', async () => {
  const { db, getTransactionOptions } = fakeDb([() => ({ ok: true })]);
  await runBookingTransaction(db, async tx => tx, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
  assert.deepEqual(getTransactionOptions()[0], {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
});

test('8) maxWait/timeout alone (no isolationLevel) are still passed through', async () => {
  const { db, getTransactionOptions } = fakeDb([() => ({ ok: true })]);
  await runBookingTransaction(db, async tx => tx, { maxWait: 5_000, timeout: 10_000 });
  assert.deepEqual(getTransactionOptions()[0], { maxWait: 5_000, timeout: 10_000 });
});

test('isRetryableBookingTransactionError recognizes both known transient Prisma codes', () => {
  assert.equal(isRetryableBookingTransactionError(serializationConflict()), true);
  assert.equal(isRetryableBookingTransactionError(transactionStartTimeout()), true);
  const unrelatedKnownError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
  assert.equal(isRetryableBookingTransactionError(unrelatedKnownError), false);
});
