import assert from 'node:assert/strict';
import test from 'node:test';
import { JobStatus } from '@prisma/client';

import { jobLeaseExpiresAt } from '../src/job-execution-lease.js';
import { sweepStaleJobs } from '../src/job-staleness-sweep.js';

test('a 30 second API-agent outage cannot stale or quarantine a job with a 90 second lease', async () => {
  const claimedAt = new Date('2026-09-07T00:00:00.000Z');
  const outageObservedAt = new Date(claimedAt.getTime() + 30_000);
  const leaseExpiresAt = jobLeaseExpiresAt(claimedAt, 90);

  const job = {
    id: 'job-network-blip',
    status: JobStatus.RUNNING,
    bookingId: 'booking-network-blip',
    machineId: 'machine-network-blip',
    // Deliberately older than the tiny staleAfterSeconds used below. For an
    // explicitly leased claimed job, old updatedAt must NOT matter while the
    // lease itself is still alive.
    updatedAt: claimedAt,
    leaseExpiresAt,
  };

  let anyMutationAttempted = false;
  const tx = {
    $queryRaw: async () => [{ acquired: true }],
    job: {
      findMany: async ({ where }: any) => {
        const claimedClause = where.OR.find((part: any) => part.status?.in?.includes(JobStatus.RUNNING));
        assert.ok(claimedClause, 'sweep must include claimed RUNNING jobs');
        assert.ok(Array.isArray(claimedClause.OR), 'claimed jobs must use the explicit lease/fallback predicate');

        const leaseExpired = job.leaseExpiresAt < claimedClause.OR[0].leaseExpiresAt.lt;
        const legacyFallback = job.leaseExpiresAt === null && job.updatedAt < claimedClause.OR[1].updatedAt.lt;
        return leaseExpired || legacyFallback
          ? [{ id: job.id, status: job.status, bookingId: job.bookingId, machineId: job.machineId }]
          : [];
      },
      updateMany: async () => {
        anyMutationAttempted = true;
        throw new Error('30s outage must not mutate the leased job');
      },
    },
  };

  const db = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;

  // 15 seconds intentionally makes updatedAt "stale" at t+30. The explicit
  // 90s lease must still win; otherwise this reproduces the original false
  // quarantine failure mode despite the lease protocol.
  const result = await sweepStaleJobs(db, outageObservedAt, 15);

  assert.equal(leaseExpiresAt.getTime() - outageObservedAt.getTime(), 60_000);
  assert.equal(result.jobsTimedOut, 0);
  assert.equal(result.jobsFailed, 0);
  assert.equal(result.machinesQuarantined, 0);
  assert.equal(anyMutationAttempted, false);
});
