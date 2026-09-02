import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  BookingStatus,
  JobStatus,
  JobType,
  MachineConnectivity,
  ModerationStatus,
  PrismaClient,
} from '@prisma/client';

// Real concurrency test against a real local Postgres: simulates multiple concurrent
// GET /agent/jobs/next/:machineId polls (e.g. an agent retrying after a slow response,
// or two agent processes momentarily overlapping during a restart) racing to claim from
// the same queue of real QUEUED jobs. claimNextAgentJob (agent-job-claim.ts) is now
// wrapped in runBookingTransaction - this proves that closes the gap without allowing a
// job to be claimed twice or lost. Skips cleanly if no local Postgres is reachable.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { claimNextAgentJob } = await import('../src/agent-job-claim.js');

const hasDb = Boolean(process.env.DATABASE_URL);

async function seedMachineWithQueuedJobs(prisma: PrismaClient, suffix: string, jobCount: number) {
  const now = new Date();
  const owner = await prisma.user.create({ data: { wallet: `owner_claim_${suffix}`, pseudonym: `owner_claim_${suffix}`, canHost: true } });
  const renter = await prisma.user.create({ data: { wallet: `renter_claim_${suffix}`, pseudonym: `renter_claim_${suffix}` } });
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id, agentPublicKey: `agentkey_claim_${suffix}`, agentVersion: '0.6.2',
      connectivity: MachineConnectivity.ONLINE, operational: 'RESERVED', moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now, lastCudaProbeOk: true, dockerAvailable: true, nvidiaRuntimeAvailable: true,
      virtualizationAvailable: true, verifiedAt: now, ramTotalMiB: 16_384, diskTotalMiB: 51_200,
    },
  });
  // booking_no_overlap is scoped per-listing (listingId, tsrange(startsAt,endsAt)), not
  // per-machine - a separate listing per seeded booking gives every one of them the exact
  // same generous, comfortable time window (no fragile millisecond staggering needed)
  // while still satisfying the real DB constraint, since claim eligibility itself only
  // cares about the job's machineId, never its listing.
  const listings = [];
  const jobs = [];
  for (let i = 0; i < jobCount; i++) {
    const listing = await prisma.gpuListing.create({
      data: { ownerId: owner.id, machineId: machine.id, title: `claim test ${suffix} #${i}`, description: 'Seeded by concurrency-job-claim.test.ts', hourlyLamports: 1_000_000n, status: 'ACTIVE' },
    });
    listings.push(listing);
    const booking = await prisma.booking.create({
      data: {
        buyerId: renter.id, listingId: listing.id, idempotencyKey: `idem_claim_${suffix}_${i}`,
        startsAt: now, endsAt: new Date(now.getTime() + 3_600_000),
        quotedLamports: 1_000_000n, expectedSeconds: 60, status: BookingStatus.ACTIVE,
      },
    });
    const job = await prisma.job.create({
      data: { bookingId: booking.id, renterId: renter.id, machineId: machine.id, type: JobType.GPU_DIAGNOSTIC, status: JobStatus.QUEUED, parameters: {} },
    });
    jobs.push({ booking, job });
  }
  return {
    owner, renter, machine, listings, jobs,
    async cleanup() {
      await prisma.jobAttempt.deleteMany({ where: { jobId: { in: jobs.map((j) => j.job.id) } } }).catch(() => {});
      await prisma.job.deleteMany({ where: { machineId: machine.id } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { listingId: { in: listings.map((l) => l.id) } } }).catch(() => {});
      for (const listing of listings) await prisma.gpuListing.delete({ where: { id: listing.id } }).catch(() => {});
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

withPrisma('more concurrent claim callers than queued jobs: every job is claimed exactly once, no duplicate claim, no lost job', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const JOB_COUNT = 5;
  const CALLERS = 10;
  const seed = await seedMachineWithQueuedJobs(prisma, suffix, JOB_COUNT);
  try {
    const results = await Promise.all(
      Array.from({ length: CALLERS }, () => claimNextAgentJob(prisma, {
        machineId: seed.machine.id,
        agentVersion: '0.6.2',
        reclaimAfterSeconds: 120,
      })),
    );
    const claims = results.filter((r): r is NonNullable<typeof r> => r !== null);
    assert.equal(claims.length, JOB_COUNT, `exactly ${JOB_COUNT} jobs must be claimed (one per job), got ${claims.length}`);

    const claimedJobIds = claims.map((c) => c.id);
    assert.equal(new Set(claimedJobIds).size, JOB_COUNT, 'no job claimed twice - every claimed id must be unique');
    assert.deepEqual(new Set(claimedJobIds), new Set(seed.jobs.map((j) => j.job.id)), 'exactly the seeded jobs, none lost, none fabricated');

    const attemptIds = claims.map((c) => c.attemptId);
    assert.equal(new Set(attemptIds).size, JOB_COUNT, 'every claim must have gotten its own unique attempt');
    const leaseTokens = claims.map((c) => c.leaseToken);
    assert.equal(new Set(leaseTokens).size, JOB_COUNT, 'every claim must have gotten its own unique lease token');

    const remainingCallers = CALLERS - JOB_COUNT;
    const emptyResults = results.filter((r) => r === null);
    assert.equal(emptyResults.length, remainingCallers, 'callers beyond the number of available jobs must get null, not an error and not a duplicate claim');

    // Verify the real DB state matches: every job is ASSIGNED with a real attempt row.
    const dbJobs = await prisma.job.findMany({ where: { machineId: seed.machine.id }, select: { id: true, status: true, currentAttemptId: true, leaseTokenHash: true } });
    for (const job of dbJobs) {
      assert.equal(job.status, JobStatus.ASSIGNED);
      assert.ok(job.currentAttemptId);
      assert.ok(job.leaseTokenHash);
    }
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: { in: claimedJobIds } } });
    assert.equal(attempts.length, JOB_COUNT, 'exactly one JobAttempt row per job - no double-attempt row from a racing loser');
  } finally {
    await seed.cleanup();
  }
});

withPrisma('claiming from an empty queue concurrently returns null for everyone, no crash', async (prisma) => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const seed = await seedMachineWithQueuedJobs(prisma, suffix, 0);
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimNextAgentJob(prisma, { machineId: seed.machine.id, agentVersion: '0.6.2', reclaimAfterSeconds: 120 })),
    );
    assert.ok(results.every((r) => r === null));
  } finally {
    await seed.cleanup();
  }
});
