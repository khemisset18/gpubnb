import assert from 'node:assert/strict';
import test from 'node:test';
import { JobStatus, JobType } from '@prisma/client';

import { claimNextAgentJobInTransaction } from '../src/agent-job-claim.js';
import { hashJobLeaseToken } from '../src/job-execution-lease.js';

const NOW = new Date('2026-08-11T00:00:00.000Z');

function fakeTransaction(options: {
  abandoned?: { id: string; status: JobStatus } | null;
  queued?: { id: string } | null;
  updateCount?: number;
  previousAttempts?: number;
}) {
  const findQueries: any[] = [];
  const jobUpdates: any[] = [];
  const jobWrites: any[] = [];
  const closedAttempts: any[] = [];
  const createdAttempts: any[] = [];
  const sessionUpdates: any[] = [];

  const tx = {
    job: {
      findFirst: async (query: any) => {
        findQueries.push(query);
        return query.where.type === JobType.WORKSPACE_PREPARE
          ? (options.abandoned ?? null)
          : (options.queued ?? null);
      },
      updateMany: async (query: any) => {
        jobUpdates.push(query);
        return { count: options.updateCount ?? 1 };
      },
      update: async (query: any) => {
        jobWrites.push(query);
        return query.data;
      },
      findUnique: async (query: any) => ({
        id: query.where.id,
        bookingId: 'booking-1',
        type: JobType.WORKSPACE_PREPARE,
        status: JobStatus.ASSIGNED,
        parameters: { workspaceSlug: 'developer' },
        workspaceSession: { id: 'session-1' },
      }),
    },
    jobAttempt: {
      count: async () => options.previousAttempts ?? 0,
      updateMany: async (query: any) => {
        closedAttempts.push(query);
        return { count: 1 };
      },
      create: async (query: any) => {
        const created = { id: `attempt-${query.data.sequence}`, ...query.data };
        createdAttempts.push({ ...query, created });
        return created;
      },
    },
    workspaceSession: {
      updateMany: async (query: any) => {
        sessionUpdates.push(query);
        return { count: 1 };
      },
    },
  };

  return {
    tx: tx as unknown as Parameters<typeof claimNextAgentJobInTransaction>[0],
    findQueries,
    jobUpdates,
    jobWrites,
    closedAttempts,
    createdAttempts,
    sessionUpdates,
  };
}

const claimOptions = {
  machineId: 'machine-1',
  agentVersion: '0.5.5',
  now: NOW,
  reclaimAfterSeconds: 45,
};

test('a stale Developer preparation is reclaimed before any queued job with a new fenced attempt', async () => {
  const fake = fakeTransaction({
    abandoned: { id: 'stale-job', status: JobStatus.DOWNLOADING },
    queued: { id: 'newer-job' },
    previousAttempts: 1,
  });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed?.id, 'stale-job');
  assert.equal(claimed?.attemptId, 'attempt-2');
  assert.equal(typeof claimed?.leaseToken, 'string');
  assert.equal(claimed?.leaseToken.length, 43);
  assert.equal(claimed?.leaseExpiresAt.toISOString(), '2026-08-11T00:00:45.000Z');
  assert.equal(fake.findQueries.length, 1, 'recovery must take precedence over newer queued work');
  assert.deepEqual(fake.findQueries[0].where.status.in, [
    JobStatus.ASSIGNED,
    JobStatus.DOWNLOADING,
    JobStatus.PREPARING,
  ]);
  assert.ok(fake.findQueries[0].where.OR, 'explicit lease expiry or legacy fallback must guard recovery');
  assert.equal(fake.jobUpdates[0].data.status, JobStatus.ASSIGNED);
  assert.equal(fake.closedAttempts[0].data.failureReason, 'agent_lease_expired');
  assert.equal(fake.createdAttempts[0].data.sequence, 2);
  assert.equal(fake.sessionUpdates[0].data.preparationStep, 'AGENT_RECONNECTING');
  assert.equal(fake.jobWrites[0].data.currentAttemptId, 'attempt-2');
  assert.equal(fake.jobWrites[0].data.leaseTokenHash, hashJobLeaseToken(claimed!.leaseToken));
});

test('legacy active jobs remain reclaimable during nullable-column rollout', async () => {
  const fake = fakeTransaction({ abandoned: null, queued: null });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed, null);
  assert.equal(fake.findQueries.length, 2);
  const legacy = fake.findQueries[0].where.OR.find((item: any) => item.leaseExpiresAt === null);
  assert.equal(legacy.updatedAt.lte.toISOString(), '2026-08-10T23:59:15.000Z');
  assert.equal(fake.jobUpdates.length, 0);
});

test('a lost recovery race never claims a second queued job or issues a new lease', async () => {
  const fake = fakeTransaction({
    abandoned: { id: 'stale-job', status: JobStatus.PREPARING },
    queued: { id: 'queued-job' },
    updateCount: 0,
  });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed, null);
  assert.equal(fake.findQueries.length, 1);
  assert.equal(fake.createdAttempts.length, 0);
  assert.equal(fake.jobWrites.length, 0);
  assert.equal(fake.sessionUpdates.length, 0);
});

test('normal queued work receives one auditable attempt and one explicit lease', async () => {
  const fake = fakeTransaction({
    abandoned: null,
    queued: { id: 'queued-job' },
  });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed?.id, 'queued-job');
  assert.equal(claimed?.attemptId, 'attempt-1');
  assert.equal(fake.jobUpdates[0].data.status, JobStatus.ASSIGNED);
  assert.equal(fake.createdAttempts[0].data.sequence, 1);
  assert.equal(fake.closedAttempts.length, 0);
  assert.equal(fake.jobWrites[0].data.currentAttemptId, 'attempt-1');
  assert.equal(fake.jobWrites[0].data.lastAgentReportAt, NOW);
});

test('every new queued rental job is gated to five minutes before startsAt', async () => {
  const fake = fakeTransaction({ abandoned: null, queued: null });

  await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  const queuedQuery = fake.findQueries[1];
  assert.ok(queuedQuery, 'queued lookup should run after abandoned preparation lookup');
  assert.equal(queuedQuery.where.OR, undefined, 'WORKSPACE_PREPARE must not bypass the rental start window');
  assert.equal(
    queuedQuery.where.booking.startsAt.lte.toISOString(),
    '2026-08-11T00:05:00.000Z',
  );
  assert.equal(queuedQuery.where.booking.endsAt.gte, NOW);
});
