import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BookingStatus, JobStatus, JobType, MachineOperational, WorkspaceSessionStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-at-least-32-characters';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-at-least-32-characters';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
process.env.DEV_PAYMENT_BYPASS = 'false';
process.env.BETA_TEST_DEV_BYPASS = 'false';

const { reconcileDevelopmentBookings } = await import('../src/dev-booking-reconciler.js');

type Call = { area: string; args: Record<string, unknown> };

function fakeReconcilerDb(options: {
  racedSessions?: Array<{ id: string; bookingId: string; machineId: string }>;
  finishedJobs?: Array<Record<string, unknown>>;
  bookingUpdateCount?: number;
} = {}): { db: PrismaClient; calls: Call[] } {
  const calls: Call[] = [];
  const tx = {
    booking: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.booking.updateMany', args });
        return { count: options.bookingUpdateCount ?? 1 };
      },
    },
    machine: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.updateMany', args });
        return { count: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.update', args });
        return {};
      },
    },
    workspaceSession: {
      update: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.workspaceSession.update', args });
        return {};
      },
    },
  };
  const db = {
    workspaceSession: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'workspaceSession.findMany', args });
        return options.racedSessions ?? [];
      },
    },
    booking: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'booking.findMany', args });
        return [];
      },
    },
    job: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'job.findMany', args });
        return options.finishedJobs ?? [];
      },
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  return { db, calls };
}

test('recovers an unexpired Developer preparation misclassified as COMPLETED by the beta diagnostic', async () => {
  const { db, calls } = fakeReconcilerDb({
    racedSessions: [{ id: 'workspace-1', bookingId: 'booking-1', machineId: 'machine-1' }],
  });
  const result = await reconcileDevelopmentBookings(db, new Date('2026-08-11T03:20:00Z'));

  assert.deepEqual(result, {
    funded: 0,
    queued: 0,
    completed: 0,
    degraded: 0,
    recoveredDeveloper: 1,
  });
  const bookingUpdate = calls.find(call => call.area === 'tx.booking.updateMany');
  assert.ok(bookingUpdate);
  assert.equal((bookingUpdate.args.data as { status: BookingStatus }).status, BookingStatus.STARTING);
  const bookingWhere = bookingUpdate.args.where as {
    status: BookingStatus;
    workspaceSessions: { some: { id: string; job: { is: { type: JobType; status: { in: JobStatus[] } } } } };
  };
  assert.equal(bookingWhere.status, BookingStatus.COMPLETED);
  assert.equal(bookingWhere.workspaceSessions.some.id, 'workspace-1');
  assert.equal(bookingWhere.workspaceSessions.some.job.is.type, JobType.WORKSPACE_PREPARE);
  assert.ok(bookingWhere.workspaceSessions.some.job.is.status.in.includes(JobStatus.QUEUED));

  const machineUpdate = calls.find(call => call.area === 'tx.machine.updateMany');
  assert.ok(machineUpdate);
  assert.equal((machineUpdate.args.data as { operational: MachineOperational }).operational, MachineOperational.RESERVED);
  const auditEvent = calls.find(call => call.area === 'tx.workspaceSession.update');
  assert.ok(auditEvent);
  assert.equal(
    (((auditEvent.args.data as { events: { create: { action: string } } }).events.create).action),
    'DIAGNOSTIC_COMPLETION_RACE_RECOVERED',
  );
});

test('a stale diagnostic result cannot close a booking after a Developer session wins the race', async () => {
  const { db, calls } = fakeReconcilerDb({
    finishedJobs: [{
      id: 'diagnostic-1',
      status: JobStatus.COMPLETED,
      bookingId: 'booking-1',
      machineId: 'machine-1',
      result: { gpuDetected: true },
    }],
    // Simulates a Developer session being inserted after the read but before the
    // atomic updateMany. The relation guard makes the update affect zero rows.
    bookingUpdateCount: 0,
  });
  const result = await reconcileDevelopmentBookings(db, new Date('2026-08-11T03:20:00Z'));

  assert.equal(result.completed, 0);
  const jobQuery = calls.find(call => call.area === 'job.findMany');
  assert.ok(jobQuery);
  const queryBooking = (jobQuery.args.where as {
    booking: { workspaceSessions: { none: { machineWorkspace: { workspace: { slug: string } } } } };
  }).booking;
  assert.equal(queryBooking.workspaceSessions.none.machineWorkspace.workspace.slug, 'developer');

  const bookingUpdate = calls.find(call => call.area === 'tx.booking.updateMany');
  assert.ok(bookingUpdate);
  const atomicWhere = bookingUpdate.args.where as {
    workspaceSessions: { none: { machineWorkspace: { workspace: { slug: string } } } };
  };
  assert.equal(atomicWhere.workspaceSessions.none.machineWorkspace.workspace.slug, 'developer');
  assert.equal(calls.some(call => call.area === 'tx.machine.update'), false);
});

test('creating Developer cancels only a still-queued beta diagnostic before enqueuing WORKSPACE_PREPARE', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:bookingId/workspace/developer'");
  const end = source.indexOf("app.post('/bookings/:bookingId/workspace/retry'", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /tx\.job\.updateMany\(\{where:\{bookingId,type:JobType\.GPU_DIAGNOSTIC,status:JobStatus\.QUEUED\},data:\{status:JobStatus\.CANCELLED,errorCode:'superseded_by_developer_workspace'/,
  );
  assert.match(body, /type:JobType\.WORKSPACE_PREPARE/);
});
