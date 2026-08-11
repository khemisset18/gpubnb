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

// RC1 Phase 5 finding: a job whose status reports were lost mid-flight (e.g. an API
// outage) could stay stuck forever even after its agent/machine fully recovered,
// because the only existing sweep (offline-sweep-service.ts) keys off machine
// heartbeat staleness, not job staleness. This is the regression suite for the fix.

const NOW = new Date('2026-08-06T22:30:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function fakeDb(seed: {
  jobs: Array<{ id: string; status: JobStatus; bookingId: string; machineId: string; updatedAt: Date; errorCode?: string | null; finishedAt?: Date | null }>;
  bookings?: Array<{ id: string; status: BookingStatus }>;
  sessions?: Array<{ id: string; bookingId: string; status: WorkspaceSessionStatus }>;
  machines?: Array<{ id: string; moderationStatus: ModerationStatus; operational: MachineOperational }>;
  payments?: Array<{ bookingId: string; status: PaymentStatus }>;
}) {
  const jobs = seed.jobs.map(j => ({ ...j }));
  const bookings = (seed.bookings ?? []).map(b => ({ ...b }));
  const sessions = (seed.sessions ?? []).map(s => ({ ...s }));
  const machines = (seed.machines ?? []).map(m => ({ ...m }));
  const payments = (seed.payments ?? []).map(p => ({ ...p }));

  const matchesStatus = (value: unknown, clause: unknown): boolean => {
    if (clause && typeof clause === 'object' && 'in' in (clause as Record<string, unknown>)) {
      return ((clause as { in: unknown[] }).in).includes(value);
    }
    return value === clause;
  };

  const tx = {
    job: {
      findMany: async ({ where }: { where: { status: { in: JobStatus[] }; updatedAt: { lt: Date } } }) =>
        jobs
          .filter(j => where.status.in.includes(j.status) && j.updatedAt < where.updatedAt.lt)
          .map(j => ({ id: j.id, status: j.status, bookingId: j.bookingId, machineId: j.machineId })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] }; status: unknown }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const j of jobs) {
          if (where.id.in.includes(j.id) && matchesStatus(j.status, where.status)) { Object.assign(j, data); count++; }
        }
        return { count };
      },
    },
    booking: {
      updateMany: async ({ where, data }: { where: { id: { in: string[] }; status: { in: BookingStatus[] } }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const b of bookings) {
          if (where.id.in.includes(b.id) && matchesStatus(b.status, where.status)) { Object.assign(b, data); count++; }
        }
        return { count };
      },
    },
    workspaceSession: {
      updateMany: async ({ where, data }: { where: { bookingId: { in: string[] }; status: { in: WorkspaceSessionStatus[] } }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const s of sessions) {
          if (where.bookingId.in.includes(s.bookingId) && matchesStatus(s.status, where.status)) { Object.assign(s, data); count++; }
        }
        return { count };
      },
    },
    machine: {
      updateMany: async ({ where, data }: { where: { id: { in: string[] }; moderationStatus: ModerationStatus; operational?: MachineOperational }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const m of machines) {
          if (where.id.in.includes(m.id) && m.moderationStatus === where.moderationStatus && (!where.operational || m.operational === where.operational)) { Object.assign(m, data); count++; }
        }
        return { count };
      },
    },
    payment: {
      updateMany: async ({ where, data }: { where: { bookingId: { in: string[] }; status: PaymentStatus }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const p of payments) {
          if (where.bookingId.in.includes(p.bookingId) && p.status === where.status) { Object.assign(p, data); count++; }
        }
        return { count };
      },
    },
  };
  const db = { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) };
  return { db: db as never, jobs, bookings, sessions, machines, payments };
}

test('1) a recent RUNNING job is left untouched', async () => {
  const { db, jobs } = fakeDb({ jobs: [{ id: 'j1', status: JobStatus.RUNNING, bookingId: 'b1', machineId: 'm1', updatedAt: minutesAgo(1) }] });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 0);
  assert.equal(jobs[0].status, JobStatus.RUNNING, 'a healthy in-progress job must never be touched');
});

test('2) an old UPLOADING_RESULTS job is moved to a terminal state (FAILED, not TIMED_OUT, per the job state machine)', async () => {
  const { db, jobs } = fakeDb({ jobs: [{ id: 'j2', status: JobStatus.UPLOADING_RESULTS, bookingId: 'b2', machineId: 'm2', updatedAt: minutesAgo(20) }] });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsFailed, 1);
  assert.equal(jobs[0].status, JobStatus.FAILED);
  assert.equal(jobs[0].errorCode, 'job_stale_timeout');
  assert.ok(jobs[0].finishedAt);
});

test('3) an already-COMPLETED job is left untouched', async () => {
  const { db, jobs } = fakeDb({ jobs: [{ id: 'j3', status: JobStatus.COMPLETED, bookingId: 'b3', machineId: 'm3', updatedAt: minutesAgo(120) }] });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut + result.jobsFailed, 0);
  assert.equal(jobs[0].status, JobStatus.COMPLETED, 'a terminal job must never be re-touched, no matter how old');
});

test('4) a stale job is processed even though its machine looks perfectly healthy (the actual RC1 bug)', async () => {
  const { db, jobs, machines } = fakeDb({
    jobs: [{ id: 'j4', status: JobStatus.RUNNING, bookingId: 'b4', machineId: 'm4', updatedAt: minutesAgo(30) }],
    machines: [{ id: 'm4', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.AVAILABLE }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 1);
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
  assert.equal(machines[0].moderationStatus, ModerationStatus.QUARANTINED, 'staleness must be detected independently of machine connectivity/heartbeat');
});

test('5) running the sweep twice in a row is idempotent: identical result, no double writes', async () => {
  const { db, jobs, bookings, machines, payments } = fakeDb({
    jobs: [{ id: 'j5', status: JobStatus.RUNNING, bookingId: 'b5', machineId: 'm5', updatedAt: minutesAgo(30) }],
    bookings: [{ id: 'b5', status: BookingStatus.ACTIVE }],
    machines: [{ id: 'm5', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.AVAILABLE }],
    payments: [{ bookingId: 'b5', status: PaymentStatus.ESCROW_FUNDED }],
  });
  const first = await sweepStaleJobs(db, NOW, 900);
  const second = await sweepStaleJobs(db, NOW, 900);
  assert.equal(first.jobsTimedOut, 1);
  assert.deepEqual(second, { ...first, jobsTimedOut: 0, jobsFailed: 0, bookingsDegraded: 0, sessionsTimedOut: 0, machinesReleased: 0, machinesQuarantined: 0, paymentsPendingSettlement: 0 });
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
  assert.equal(bookings[0].status, BookingStatus.DEGRADED);
  assert.equal(machines[0].moderationStatus, ModerationStatus.QUARANTINED);
  assert.equal(payments[0].status, PaymentStatus.SETTLEMENT_PENDING);
});

test('6) cleanup of a claimed job cannot be proven from the API process, so its machine is quarantined', async () => {
  const { db, machines } = fakeDb({
    jobs: [{ id: 'j6', status: JobStatus.PREPARING, bookingId: 'b6', machineId: 'm6', updatedAt: minutesAgo(45) }],
    machines: [{ id: 'm6', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED }],
  });
  await sweepStaleJobs(db, NOW, 900);
  assert.equal(machines[0].moderationStatus, ModerationStatus.QUARANTINED);
  assert.equal(machines[0].operational, MachineOperational.UNAVAILABLE);
});

test('7) a stale job never resolves its booking or payment as a success', async () => {
  const { db, bookings, payments } = fakeDb({
    jobs: [{ id: 'j7', status: JobStatus.UPLOADING_RESULTS, bookingId: 'b7', machineId: 'm7', updatedAt: minutesAgo(20) }],
    bookings: [{ id: 'b7', status: BookingStatus.STARTING }],
    payments: [{ bookingId: 'b7', status: PaymentStatus.ESCROW_FUNDED }],
  });
  await sweepStaleJobs(db, NOW, 900);
  assert.equal(bookings[0].status, BookingStatus.DEGRADED);
  assert.notEqual(bookings[0].status, BookingStatus.COMPLETED);
  assert.equal(payments[0].status, PaymentStatus.SETTLEMENT_PENDING);
  assert.notEqual(payments[0].status, PaymentStatus.ESCROW_FUNDED);
});

test('a job just under the configured threshold is left alone (boundary)', async () => {
  const { db, jobs } = fakeDb({ jobs: [{ id: 'j8', status: JobStatus.RUNNING, bookingId: 'b8', machineId: 'm8', updatedAt: minutesAgo(10) }] });
  const result = await sweepStaleJobs(db, NOW, 900); // 900s = 15min threshold, job is 10min old
  assert.equal(result.jobsTimedOut, 0);
  assert.equal(jobs[0].status, JobStatus.RUNNING);
});

test('8) an abandoned QUEUED workspace job expires and releases its never-used machine without quarantine', async () => {
  const { db, jobs, bookings, sessions, machines } = fakeDb({
    jobs: [{ id: 'j9', status: JobStatus.QUEUED, bookingId: 'b9', machineId: 'm9', updatedAt: minutesAgo(20) }],
    bookings: [{ id: 'b9', status: BookingStatus.STARTING }],
    sessions: [{ id: 's9', bookingId: 'b9', status: WorkspaceSessionStatus.PREPARING }],
    machines: [{ id: 'm9', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 1);
  assert.equal(result.machinesReleased, 1);
  assert.equal(result.machinesQuarantined, 0);
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
  assert.equal(bookings[0].status, BookingStatus.DEGRADED);
  assert.equal(sessions[0].status, WorkspaceSessionStatus.TIMED_OUT);
  assert.equal(machines[0].operational, MachineOperational.AVAILABLE);
  assert.equal(machines[0].moderationStatus, ModerationStatus.CLEAR);
});

test('9) a DOWNLOADING job with recent progress remains active', async () => {
  const { db, jobs } = fakeDb({
    jobs: [{ id: 'j10', status: JobStatus.DOWNLOADING, bookingId: 'b10', machineId: 'm10', updatedAt: minutesAgo(1) }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 0);
  assert.equal(jobs[0].status, JobStatus.DOWNLOADING);
});

test('10) a DOWNLOADING job without progress expires and quarantines the claimed machine', async () => {
  const { db, jobs, machines } = fakeDb({
    jobs: [{ id: 'j11', status: JobStatus.DOWNLOADING, bookingId: 'b11', machineId: 'm11', updatedAt: minutesAgo(20) }],
    machines: [{ id: 'm11', moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED }],
  });
  const result = await sweepStaleJobs(db, NOW, 900);
  assert.equal(result.jobsTimedOut, 1);
  assert.equal(result.machinesReleased, 0);
  assert.equal(result.machinesQuarantined, 1);
  assert.equal(jobs[0].status, JobStatus.TIMED_OUT);
  assert.equal(machines[0].moderationStatus, ModerationStatus.QUARANTINED);
});
