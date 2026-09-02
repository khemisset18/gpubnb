import { Prisma, PrismaClient } from '@prisma/client';

// Business rejections from inside the /bookings transaction (see server.ts). These must
// never be retried and must never be replaced by a generic error — the caller maps them
// straight to a 409 with this exact message.
export const BOOKING_BUSINESS_ERRORS = new Set(['time_slot_unavailable', 'listing_unavailable', 'quote_too_small']);

// Postgres SQLSTATEs for the exact same transient condition P2034 represents for a
// normal Prisma-generated query: 40001 serialization_failure, 40P01 deadlock_detected.
// Real CI failure found live: lockBookingAndPayment's `SELECT ... FOR UPDATE` is issued
// via tx.$queryRaw (a raw query, needed for FOR UPDATE OF - Prisma's query builder has
// no equivalent), and Prisma wraps *any* raw-query failure as P2010 "Raw query failed"
// regardless of the underlying Postgres error - the real SQLSTATE only survives in the
// message text, never in `.code`. A settlement confirmation under real concurrent load
// hit a genuine 40001 this way and, because P2010 alone is far too broad to blindly
// retry (it also wraps a real SQL syntax error or constraint violation), was silently
// never retried at all before this fix specifically pattern-matched the message for
// these two known-transient SQLSTATEs.
const TRANSIENT_RAW_QUERY_SQLSTATE = /\b(?:40001|40P01)\b|serialization_failure|deadlock_detected|could not serialize access due to concurrent update|deadlock detected/i;

// P2034: Postgres serialization_failure / deadlock surfaced by Prisma's interactive
// transactions. P2028: Prisma could not even start the transaction within its own
// maxWait budget (observed live under concurrent booking load: "Transaction API error:
// Unable to start a transaction in the given time."). Both are transient infrastructure
// conditions, not business outcomes, so they are safe to retry.
export function isRetryableBookingTransactionError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2034' || e.code === 'P2028') return true;
    if (e.code === 'P2010') return TRANSIENT_RAW_QUERY_SQLSTATE.test(e.message);
    return false;
  }
  return e instanceof Error && /Unable to start a transaction in the given time|write conflict or a deadlock/i.test(e.message);
}

export async function runBookingTransaction<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
    maxWait?: number;
    timeout?: number;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;
  // Only ever include the keys the caller actually passed - Prisma then applies its own
  // default for any field left out entirely, rather than every isolationLevel-only caller
  // suddenly also pinning maxWait/timeout to some arbitrary default it never asked for.
  const txOptions: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number } | undefined =
    (options.isolationLevel !== undefined || options.maxWait !== undefined || options.timeout !== undefined)
      ? {
        ...(options.isolationLevel !== undefined ? { isolationLevel: options.isolationLevel } : {}),
        ...(options.maxWait !== undefined ? { maxWait: options.maxWait } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      }
      : undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(fn, txOptions);
    } catch (e) {
      if (attempt >= maxAttempts || !isRetryableBookingTransactionError(e)) throw e;
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt + Math.floor(Math.random() * baseDelayMs)));
    }
  }
}
