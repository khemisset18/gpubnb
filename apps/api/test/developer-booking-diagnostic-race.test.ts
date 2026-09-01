import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BookingStatus, JobStatus, JobType, MachineOperational, ModerationStatus, PaymentStatus, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';
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
const { config } = await import('../src/config.js');

type Call = { area: string; args: Record<string, unknown> };

function fakeReconcilerDb(options: {
  racedSessions?: Array<{ id: string; bookingId: string; machineId: string; jobId: string | null }>;
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
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.findUnique', args });
        return { moderationStatus: ModerationStatus.CLEAR, quarantinedAt: null };
      },
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.updateMany', args });
        return { count: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.update', args });
        return {};
      },
    },
    accelerator: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.accelerator.updateMany', args });
        return { count: 0 };
      },
    },
    gpuListing: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.gpuListing.updateMany', args });
        return { count: 0 };
      },
    },
    machineQuarantineEvent: {
      create: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machineQuarantineEvent.create', args });
        return {};
      },
    },
    workspaceSession: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.workspaceSession.updateMany', args });
        return { count: 1 };
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.workspaceSession.update', args });
        return {};
      },
    },
    job: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.job.updateMany', args });
        return { count: 1 };
      },
    },
    jobAttempt: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.jobAttempt.updateMany', args });
        return { count: 1 };
      },
    },
    payment: {
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.payment.updateMany', args });
        return { count: 1 };
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
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ area: 'job.findFirst', args });
        return null;
      },
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'job.findMany', args });
        return options.finishedJobs ?? [];
      },
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  return { db, calls };
}

test('a completed booking with a live Developer runtime fails closed instead of resurrecting without allocation', async () => {
  const { db, calls } = fakeReconcilerDb({
    racedSessions: [{ id: 'workspace-1', bookingId: 'booking-1', machineId: 'machine-1', jobId: 'job-1' }],
  });
  const result = await reconcileDevelopmentBookings(db, new Date('2026-08-11T03:20:00Z'));

  assert.deepEqual(result, {
    funded: 0,
    queued: 0,
    completed: 0,
    degraded: 0,
    quarantinedDeveloper: 1,
  });
  assert.equal(
    calls.some(call => call.area === 'tx.booking.updateMany'),
    false,
    'COMPLETED must never be moved backwards to STARTING after its allocation was released',
  );

  const sessionUpdate = calls.find(call => call.area === 'tx.workspaceSession.updateMany');
  assert.ok(sessionUpdate);
  assert.equal((sessionUpdate.args.data as { status: WorkspaceSessionStatus }).status, WorkspaceSessionStatus.QUARANTINED);
  assert.equal(
    (sessionUpdate.args.data as { terminationReason: SessionTerminationReason }).terminationReason,
    SessionTerminationReason.SECURITY_POLICY,
  );

  const jobUpdate = calls.find(call => call.area === 'tx.job.updateMany');
  assert.ok(jobUpdate);
  assert.equal((jobUpdate.args.data as { status: JobStatus }).status, JobStatus.QUARANTINED);
  assert.equal((jobUpdate.args.data as { leaseExpiresAt: null }).leaseExpiresAt, null);

  const paymentUpdate = calls.find(call => call.area === 'tx.payment.updateMany');
  assert.ok(paymentUpdate);
  assert.equal((paymentUpdate.args.data as { status: PaymentStatus }).status, PaymentStatus.SETTLEMENT_PENDING);

  const machineUpdate = calls.find(call => call.area === 'tx.machine.updateMany');
  assert.ok(machineUpdate);
  assert.equal((machineUpdate.args.data as { operational: MachineOperational }).operational, MachineOperational.UNAVAILABLE);

  // moderationStatus now flows through the shared enterQuarantine() helper (a
  // singular tx.machine.update, not the updateMany above), which also appends a
  // durable MachineQuarantineEvent history row - see quarantine-service.ts.
  const quarantineWrite = calls.find(call => call.area === 'tx.machine.update');
  assert.ok(quarantineWrite);
  assert.equal((quarantineWrite.args.data as { moderationStatus: ModerationStatus }).moderationStatus, ModerationStatus.QUARANTINED);
  assert.equal((quarantineWrite.args.data as { quarantineReasonCode: string }).quarantineReasonCode, 'DIAGNOSTIC_COMPLETION_RACE');
  const historyEvent = calls.find(call => call.area === 'tx.machineQuarantineEvent.create');
  assert.ok(historyEvent, 'entering quarantine must append a durable MachineQuarantineEvent row');
  assert.equal((historyEvent.args.data as { status: string }).status, 'ENTERED');

  const auditEvent = calls.find(call => call.area === 'tx.workspaceSession.update');
  assert.ok(auditEvent);
  assert.equal(
    (((auditEvent.args.data as { events: { create: { action: string } } }).events.create).action),
    'DIAGNOSTIC_COMPLETION_RACE_QUARANTINED',
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

test('beta payment bypass skips the legacy GPU diagnostic queue', async () => {
  const previousBeta = config.BETA_TEST_DEV_BYPASS;
  const previousEscrow = config.ESCROW_PROGRAM_ID;
  const previousDev = config.DEV_PAYMENT_BYPASS;

  config.BETA_TEST_DEV_BYPASS = 'true';
  config.ESCROW_PROGRAM_ID = 'NOT_DEPLOYED_YET';
  config.DEV_PAYMENT_BYPASS = 'false';

  try {
    const { db, calls } = fakeReconcilerDb();
    const result = await reconcileDevelopmentBookings(db, new Date('2026-08-17T03:00:00Z'));

    assert.equal(result.queued, 0);
    assert.equal(
      calls.filter(call => call.area === 'booking.findMany').length,
      1,
      'beta bypass must query funding candidates but skip legacy diagnostic candidates',
    );
    assert.equal(
      calls.some(call => call.area === 'job.findFirst'),
      false,
      'beta bypass must not inspect or enqueue legacy GPU_DIAGNOSTIC work',
    );
  } finally {
    config.BETA_TEST_DEV_BYPASS = previousBeta;
    config.ESCROW_PROGRAM_ID = previousEscrow;
    config.DEV_PAYMENT_BYPASS = previousDev;
  }
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
