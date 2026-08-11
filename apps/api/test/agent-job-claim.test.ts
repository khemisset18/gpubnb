import assert from 'node:assert/strict';
import test from 'node:test';
import { JobStatus, JobType } from '@prisma/client';

import { claimNextAgentJobInTransaction } from '../src/agent-job-claim.js';

const NOW = new Date('2026-08-11T00:00:00.000Z');

function fakeTransaction(options: {
  abandoned?: { id: string; status: JobStatus } | null;
  queued?: { id: string } | null;
  updateCount?: number;
  previousAttempts?: number;
}) {
  const findQueries: any[] = [];
  const jobUpdates: any[] = [];
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
        createdAttempts.push(query);
        return query.data;
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
    closedAttempts,
    createdAttempts,
    sessionUpdates,
  };
}

const claimOptions = {
  machineId: 'machine-1',
  agentVersion: '0.5.1',
  now: NOW,
  reclaimAfterSeconds: 45,
};

test('a stale Developer preparation is reclaimed before any queued job', async () => {
  const fake = fakeTransaction({
    abandoned: { id: 'stale-job', status: JobStatus.DOWNLOADING },
    queued: { id: 'newer-job' },
    previousAttempts: 1,
  });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed?.id, 'stale-job');
  assert.equal(fake.findQueries.length, 1, 'recovery must take precedence over newer queued work');
  assert.equal(fake.findQueries[0].where.type, JobType.WORKSPACE_PREPARE);
  assert.deepEqual(fake.findQueries[0].where.status.in, [
    JobStatus.ASSIGNED,
    JobStatus.DOWNLOADING,
    JobStatus.PREPARING,
  ]);
  assert.equal(fake.jobUpdates[0].data.status, JobStatus.ASSIGNED);
  assert.equal(fake.closedAttempts[0].data.failureReason, 'agent_lease_expired');
  assert.equal(fake.createdAttempts[0].data.sequence, 2);
  assert.equal(fake.sessionUpdates[0].data.preparationStep, 'AGENT_RECONNECTING');
});

test('fresh progress is protected by the reclaim cutoff', async () => {
  const fake = fakeTransaction({ abandoned: null, queued: null });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed, null);
  assert.equal(fake.findQueries.length, 2);
  assert.equal(
    fake.findQueries[0].where.updatedAt.lte.toISOString(),
    '2026-08-10T23:59:15.000Z',
  );
  assert.equal(fake.jobUpdates.length, 0);
});

test('a lost recovery race never claims a second queued job', async () => {
  const fake = fakeTransaction({
    abandoned: { id: 'stale-job', status: JobStatus.PREPARING },
    queued: { id: 'queued-job' },
    updateCount: 0,
  });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed, null);
  assert.equal(fake.findQueries.length, 1);
  assert.equal(fake.createdAttempts.length, 0);
  assert.equal(fake.sessionUpdates.length, 0);
});

test('normal queued work still receives one auditable attempt', async () => {
  const fake = fakeTransaction({
    abandoned: null,
    queued: { id: 'queued-job' },
  });

  const claimed = await claimNextAgentJobInTransaction(fake.tx, claimOptions);

  assert.equal(claimed?.id, 'queued-job');
  assert.equal(fake.jobUpdates[0].data.status, JobStatus.ASSIGNED);
  assert.equal(fake.createdAttempts[0].data.sequence, 1);
  assert.equal(fake.closedAttempts.length, 0);
});
