import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingStatus,
  JobStatus,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { sweepStaleJobs } from '../src/job-staleness-sweep.js';

const NOW = new Date('2026-08-12T03:45:00.000Z');
const minutesAgo = (value: number) => new Date(NOW.getTime() - value * 60_000);
const minutesFromNow = (value: number) => new Date(NOW.getTime() + value * 60_000);

type SeedJob = {
  id: string;
  status: JobStatus;
  bookingId: string;
  machineId: string;
  updatedAt: Date;
  leaseExpiresAt?: Date | null;
  errorCode?: string | null;
  finishedAt?: Date | null;
};

function fakeDb(seed: {
  jobs: SeedJob[];
  bookings?: Array<{ id: string; status: BookingStatus }>;
  sessions?: Array<{ id: string; bookingId: string; status: WorkspaceSessionStatus }>;
  machines?: Array<{ id: string; moderationStatus: ModerationStatus; operational: MachineOperational }>;
  payments?: Array<{ bookingId: string; status: PaymentStatus }>;
  loseRaceForJobId?: string;
}) {
  const jobs = seed.jobs.map(job => ({ leaseExpiresAt: null, ...job }));
  const bookings = (seed.bookings ?? []).map(item => ({ ...item }));
  const sessions = (seed.sessions ?? []).map(item => ({ ...item }));
  const machines = (seed.machines ?? []).map(item => ({ ...item }));
  const payments = (seed.payments ?? []).map(item => ({ ...item }));
  const attemptsClosed: string[] = [];
  let raceLost = false;

  const statusMatches = (status: JobStatus, clause: any) => {
    if (clause?.in) return clause.in.includes(status);
    return status === clause;
  };

  const jobIsStale = (job: typeof jobs[number], clause: any): boolean => {
    if (clause.updatedAt?.lt) return job.updatedAt < clause.updatedAt.lt;
    if (Array.isArray(clause.OR)) {
      return clause.OR.some((part: any) => {
        if (part.leaseExpiresAt?.lt) {
          return job.leaseExpiresAt instanceof Date && job.leaseExpiresAt < part.leaseExpiresAt.lt;
        }
        if (part.leaseExpiresAt === null && part.updatedAt?.lt) {
          return job.leaseExpiresAt === null && job.updatedAt < part.updatedAt.lt;
        }
        return false;
      });
    }
    return true;
  };

  const tx = {
    job: {
      findMany: async ({ where }: any) => jobs
        .filter(job => where.OR.some((part: any) => {
          if (!statusMatches(job.status, part.status)) return false;
          return jobIsStale(job, part);
        }))
        .map(job => ({ id: job.id, status: job.status, bookingId: job.bookingId, machineId: job.machineId })),
      updateMany: async ({ where, data }: any) => {
        const job = jobs.find(item => item.id === where.id);
        if (!job || !statusMatches(job.status, where.status) || !jobIsStale(job, where)) return { count: 0 };
        if (seed.loseRaceForJobId === job.id && !raceLost) {
          raceLost = true;
          job.updatedAt = NOW;
          job.leaseExpiresAt = minutesFromNow(1);
          return { count: 0 };
        }
        Object.assign(job, data);
        return { count: 1 };
      },
    },
    jobAttempt: {
      updateMany: async ({ where }: any) => {
        attemptsClosed.push(where.jobId);
        return { count: 1 };
      },
    },
    booking: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const booking of bookings) {
          if (where.id.in.includes(booking.id) && where.status.in.includes(booking.status)) {
            Object.assign(booking, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    workspaceSession: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const session of sessions) {
          if (where.bookingId.in.includes(session.bookingId) && where.status.in.includes(session.status)) {
            Object.assign(session, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    machine: {
      findMany: async ({ where }: any) => machines
        .filter(machine =>
          where.id.in.includes(machine.id) &&
          (!where.moderationStatus || machine.moderationStatus === where.moderationStatus))
        .map(machine => ({ id: machine.id })),
      findUnique: async ({ where }: any) => machines.find(machine => machine.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const machine = machines.find(item => item.id === where.id);
        if (machine) Object.assign(machine, data);
        return machine ?? {};
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const machine of machines) {
          if (
            where.id.in.includes(machine.id) &&
            (!where.moderationStatus || machine.moderationStatus === where.moderationStatus) &&
            (!where.operational || machine.operational === where.operational)
          ) {
            Object.assign(machine, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    machineQuarantineEvent: {
      create: async () => ({}),
    },
    accelerator: {
      updateMany: async () => ({ count: 0 }),
    },
    payment: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const payment of payments) {
          if (where.bookingId.in.includes(payment.bookingId) && payment.status === where.status) {
            Object.assign(payment, data);
            count += 1;
          }
        }
        return { count };
      },
    },
  };

  return {
    db: { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never,
    jobs,
    bookings,
    sessions,
    machines,
    payments,
    attemptsClosed,
  };
}

test('active explicit lease wins over an old updatedAt timestamp', async () => {
  const { db, jobs } = fakeDb({
    jobs: [{
      id: 'job-active-lease', status: JobStatus.PREPARING, bookingId: 'b1', machineId: 'm1',
      updatedAt: minutesAgo(60), leaseExpiresAt: minutesFromNow(1),
    }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 0);
  assert.equal(jobs[0].status, JobStatus.PREPARING);
});

test('expired explicit lease times out a claimed job and quarantines its machine', async () => {
  const { db, jobs, machines, attemptsClosed } = fakeDb({
    jobs: [{
      id: 'job-expired', status: JobStatus.RUNNING, bookingId: 'b2', machineId: 'm2',
      updatedAt: minutesAgo(1), leaseExpiresAt: minutesAgo(1),
    }],
    machines: [{ id: 'm2', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RUNNING }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 1);
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
  assert.equal(jobs[0].leaseExpiresAt, null);
  assert.deepEqual(attemptsClosed, ['job-expired']);
  assert.equal(machines[0].moderationStatus, ModerationStatus.QUARANTINED);
  assert.equal(machines[0].operational, MachineOperational.UNAVAILABLE);
});

test('legacy claimed row without a lease still uses updatedAt during rollout', async () => {
  const { db, jobs } = fakeDb({
    jobs: [{
      id: 'job-legacy', status: JobStatus.DOWNLOADING, bookingId: 'b3', machineId: 'm3',
      updatedAt: minutesAgo(20), leaseExpiresAt: null,
    }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 1);
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
});

test('queued never-claimed job expires by updatedAt and may safely release RESERVED machine', async () => {
  const { db, jobs, machines } = fakeDb({
    jobs: [{ id: 'job-queued', status: JobStatus.QUEUED, bookingId: 'b4', machineId: 'm4', updatedAt: minutesAgo(20) }],
    machines: [{ id: 'm4', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 1);
  assert.equal(result.machinesReleased, 1);
  assert.equal(result.machinesQuarantined, 0);
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
  assert.equal(machines[0].operational, MachineOperational.AVAILABLE);
});

test('lost sweep CAS race causes zero booking/session/machine/payment side effects', async () => {
  const { db, jobs, bookings, sessions, machines, payments, attemptsClosed } = fakeDb({
    jobs: [{
      id: 'job-race', status: JobStatus.PREPARING, bookingId: 'b5', machineId: 'm5',
      updatedAt: minutesAgo(30), leaseExpiresAt: minutesAgo(1),
    }],
    bookings: [{ id: 'b5', status: BookingStatus.ACTIVE }],
    sessions: [{ id: 's5', bookingId: 'b5', status: WorkspaceSessionStatus.PREPARING }],
    machines: [{ id: 'm5', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED }],
    payments: [{ bookingId: 'b5', status: PaymentStatus.ESCROW_FUNDED }],
    loseRaceForJobId: 'job-race',
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 0);
  assert.equal(jobs[0].status, JobStatus.PREPARING);
  assert.equal(bookings[0].status, BookingStatus.ACTIVE);
  assert.equal(sessions[0].status, WorkspaceSessionStatus.PREPARING);
  assert.equal(machines[0].moderationStatus, ModerationStatus.CLEAR);
  assert.equal(payments[0].status, PaymentStatus.ESCROW_FUNDED);
  assert.deepEqual(attemptsClosed, []);
});

test('stale job never settles payment as success', async () => {
  const { db, bookings, payments } = fakeDb({
    jobs: [{
      id: 'job-upload', status: JobStatus.UPLOADING_RESULTS, bookingId: 'b6', machineId: 'm6',
      updatedAt: minutesAgo(1), leaseExpiresAt: minutesAgo(1),
    }],
    bookings: [{ id: 'b6', status: BookingStatus.STARTING }],
    payments: [{ bookingId: 'b6', status: PaymentStatus.ESCROW_FUNDED }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsFailed, 1);
  assert.equal(bookings[0].status, BookingStatus.DEGRADED);
  assert.equal(payments[0].status, PaymentStatus.SETTLEMENT_PENDING);
});
