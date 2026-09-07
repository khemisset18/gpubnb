import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { reconcileDevelopmentBookings } from './dev-booking-reconciler.js';
import { runWithDistributedTaskLease } from './distributed-task-lease.js';

export type DevelopmentBookingReconciliation = Awaited<ReturnType<typeof reconcileDevelopmentBookings>>;

const EMPTY_RECONCILIATION: DevelopmentBookingReconciliation = {
  funded: 0,
  queued: 0,
  completed: 0,
  degraded: 0,
  quarantinedDeveloper: 0,
};

export type ScheduledDevelopmentBookingReconciliation = {
  result: DevelopmentBookingReconciliation;
  executed: boolean;
  leaseLost: boolean;
};

export async function reconcileDevelopmentBookingsScheduled(
  redis: Pick<Redis, 'set' | 'eval'>,
  db: PrismaClient,
  now = new Date(),
): Promise<ScheduledDevelopmentBookingReconciliation> {
  const leased = await runWithDistributedTaskLease(
    redis,
    'development-bookings',
    () => reconcileDevelopmentBookings(db, now),
    { ttlMs: 30_000, renewalMs: 10_000 },
  );
  if (leased.status === 'skipped_locked') {
    return { result: { ...EMPTY_RECONCILIATION }, executed: false, leaseLost: false };
  }
  return { result: leased.value, executed: true, leaseLost: leased.leaseLost };
}
