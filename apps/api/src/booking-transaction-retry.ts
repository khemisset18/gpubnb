import { Prisma, PrismaClient } from '@prisma/client';

// Business rejections from inside the /bookings transaction (see server.ts). These must
// never be retried and must never be replaced by a generic error — the caller maps them
// straight to a 409 with this exact message.
export const BOOKING_BUSINESS_ERRORS = new Set(['time_slot_unavailable', 'listing_unavailable', 'quote_too_small']);

// P2034: Postgres serialization_failure / deadlock surfaced by Prisma's interactive
// transactions. P2028: Prisma could not even start the transaction within its own
// maxWait budget (observed live under concurrent booking load: "Transaction API error:
// Unable to start a transaction in the given time."). Both are transient infrastructure
// conditions, not business outcomes, so they are safe to retry.
export function isRetryableBookingTransactionError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === 'P2034' || e.code === 'P2028';
  return e instanceof Error && /Unable to start a transaction in the given time|write conflict or a deadlock/i.test(e.message);
}

export async function runBookingTransaction<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(fn, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
    } catch (e) {
      if (attempt >= maxAttempts || !isRetryableBookingTransactionError(e)) throw e;
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt + Math.floor(Math.random() * baseDelayMs)));
    }
  }
}
