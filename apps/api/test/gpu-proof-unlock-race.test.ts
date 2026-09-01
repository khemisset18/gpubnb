import assert from 'node:assert/strict';
import test from 'node:test';
import { BookingStatus, JobStatus, MachineOperational } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

// Real bug found live during the private-beta two-machine test: a successful
// GPU_PROOF/GPU_DIAGNOSTIC job used to move the booking straight to
// COMPLETED, racing the frontend's own 10s poll (deriveDeveloperPhase requires
// bookingStatus in {FUNDED,STARTING,ACTIVE}) against the backend reconciler's
// own 10s tick - in the worst case the booking could reach COMPLETED before
// the renter ever saw the Developer Workspace button appear at all. Fixed:
// GPU_PROOF completed now only unlocks STARTING -> ACTIVE (still eligible,
// durably, no timer racing it), and the booking only ever reaches COMPLETED
// once its own real time window has genuinely elapsed with no live Developer
// session - see reconcileExpiredActiveDeveloperBookings.
//
// These tests exercise the real dev-booking-reconciler.ts functions with a
// hand-rolled fake Prisma client (same pattern as
// developer-booking-diagnostic-race.test.ts), not a re-simulation of the
// logic - the assertions read the exact arguments the real code passed to
// the (fake) database.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-at-least-32-characters';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-at-least-32-characters';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
process.env.DEV_PAYMENT_BYPASS = 'false';
process.env.BETA_TEST_DEV_BYPASS = 'false';

const {
  reconcileDevelopmentBookings,
  reconcileExpiredActiveDeveloperBookings,
  findExpiredActiveDeveloperBookings,
} = await import('../src/dev-booking-reconciler.js');
const { config } = await import('../src/config.js');

type Call = { area: string; args: Record<string, unknown> };

function fakeDevelopmentBookingsDb(options: {
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
      update: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.update', args });
        return {};
      },
      updateMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'tx.machine.updateMany', args });
        return { count: 1 };
      },
    },
    payment: { updateMany: async () => ({ count: 1 }) },
  };
  const db = {
    workspaceSession: { findMany: async () => [] },
    booking: { findMany: async () => [] },
    job: {
      findFirst: async () => null,
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'job.findMany', args });
        return options.finishedJobs ?? [];
      },
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  return { db, calls };
}

test('Test C (critical): a successful GPU_PROOF job unlocks STARTING to ACTIVE, never to COMPLETED', async () => {
  const { db, calls } = fakeDevelopmentBookingsDb({
    finishedJobs: [{
      id: 'diagnostic-1',
      status: JobStatus.COMPLETED,
      bookingId: 'booking-1',
      machineId: 'machine-1',
      result: { gpuDetected: true },
    }],
  });
  const result = await reconcileDevelopmentBookings(db, new Date('2026-09-01T20:00:00Z'));

  assert.equal(result.completed, 1, 'the counter is unchanged in shape - it now means "unlocked", not "rental ended"');
  const bookingUpdate = calls.find((call) => call.area === 'tx.booking.updateMany');
  assert.ok(bookingUpdate);
  assert.equal(
    (bookingUpdate.args.where as { status: BookingStatus }).status,
    BookingStatus.STARTING,
    'only unlocks a booking this reconciler itself put into STARTING - never re-matches an already-ACTIVE booking',
  );
  assert.equal(
    (bookingUpdate.args.data as { status: BookingStatus }).status,
    BookingStatus.ACTIVE,
    'GPU_PROOF completed must unlock to ACTIVE (still workspace-eligible), never straight to COMPLETED',
  );
  const machineUpdate = calls.find((call) => call.area === 'tx.machine.update');
  assert.ok(machineUpdate);
  assert.equal((machineUpdate.args.data as { operational: MachineOperational }).operational, MachineOperational.AVAILABLE);
});

test('Test G-equivalent (idempotence): re-running the reconciler against an already-ACTIVE booking is a safe no-op', async () => {
  // bookingUpdateCount: 0 simulates the real Postgres behaviour once the
  // booking is no longer STARTING (already unlocked by a previous tick) -
  // the WHERE clause's status:STARTING guard simply matches nothing.
  const { db, calls } = fakeDevelopmentBookingsDb({
    finishedJobs: [{
      id: 'diagnostic-1',
      status: JobStatus.COMPLETED,
      bookingId: 'booking-1',
      machineId: 'machine-1',
      result: { gpuDetected: true },
    }],
    bookingUpdateCount: 0,
  });
  const result = await reconcileDevelopmentBookings(db, new Date('2026-09-01T20:00:10Z'));

  assert.equal(result.completed, 0, 'an already-unlocked booking must never be counted or re-processed twice');
  assert.equal(
    calls.some((call) => call.area === 'tx.machine.update'),
    false,
    'no machine write on a no-op unlock attempt',
  );
});

test('a failed GPU_PROOF job still degrades the booking immediately, matching the pre-fix behaviour exactly', async () => {
  const { db, calls } = fakeDevelopmentBookingsDb({
    finishedJobs: [{
      id: 'diagnostic-1',
      status: JobStatus.FAILED,
      bookingId: 'booking-1',
      machineId: 'machine-1',
      result: null,
    }],
  });
  const result = await reconcileDevelopmentBookings(db, new Date('2026-09-01T20:00:00Z'));

  assert.equal(result.degraded, 1);
  const bookingUpdate = calls.find((call) => call.area === 'tx.booking.updateMany');
  assert.ok(bookingUpdate);
  assert.deepEqual((bookingUpdate.args.where as { status: { in: BookingStatus[] } }).status.in, [
    BookingStatus.STARTING,
    BookingStatus.ACTIVE,
  ]);
  assert.equal((bookingUpdate.args.data as { status: BookingStatus }).status, BookingStatus.DEGRADED);
  const machineUpdate = calls.find((call) => call.area === 'tx.machine.update');
  assert.equal((machineUpdate?.args.data as { operational: MachineOperational }).operational, MachineOperational.DEGRADED);
});

function fakeExpiryDb(options: {
  expiredBookings?: Array<{ id: string; listing: { machineId: string } }>;
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
    },
  };
  const db = {
    booking: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ area: 'booking.findMany', args });
        return options.expiredBookings ?? [];
      },
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  return { db, calls };
}

test('Test F: a genuinely expired ACTIVE booking with no live Developer session settles to COMPLETED', async () => {
  const previousBeta = config.BETA_TEST_DEV_BYPASS;
  const previousEscrow = config.ESCROW_PROGRAM_ID;
  config.BETA_TEST_DEV_BYPASS = 'true';
  config.ESCROW_PROGRAM_ID = 'NOT_DEPLOYED_YET';
  try {
    const { db, calls } = fakeExpiryDb({
      expiredBookings: [{ id: 'booking-1', listing: { machineId: 'machine-1' } }],
    });
    const result = await reconcileExpiredActiveDeveloperBookings(db, new Date('2026-09-01T22:00:00Z'));

    assert.equal(result.completed, 1);
    const query = calls.find((call) => call.area === 'booking.findMany');
    assert.ok(query);
    const where = query.args.where as {
      status: BookingStatus;
      endsAt: { lt: Date };
      workspaceSessions: { none: { machineWorkspace: { workspace: { slug: string } } } };
    };
    assert.equal(where.status, BookingStatus.ACTIVE);
    assert.equal(where.workspaceSessions.none.machineWorkspace.workspace.slug, 'developer');
    const bookingUpdate = calls.find((call) => call.area === 'tx.booking.updateMany');
    assert.ok(bookingUpdate);
    assert.equal((bookingUpdate.args.data as { status: BookingStatus }).status, BookingStatus.COMPLETED);
  } finally {
    config.BETA_TEST_DEV_BYPASS = previousBeta;
    config.ESCROW_PROGRAM_ID = previousEscrow;
  }
});

test('Test E: this expiry sweep never even queries a booking that already has a live Developer session (query-level exclusion)', async () => {
  const previousBeta = config.BETA_TEST_DEV_BYPASS;
  const previousEscrow = config.ESCROW_PROGRAM_ID;
  config.BETA_TEST_DEV_BYPASS = 'true';
  config.ESCROW_PROGRAM_ID = 'NOT_DEPLOYED_YET';
  try {
    // A real Developer session existing means this booking would never be
    // returned by findExpiredActiveDeveloperBookings's own WHERE clause in
    // the first place (workspaceSessions:{none:...}) - modelled here by the
    // fake simply returning nothing, exactly like the real query would.
    const { db, calls } = fakeExpiryDb({ expiredBookings: [] });
    const result = await reconcileExpiredActiveDeveloperBookings(db, new Date('2026-09-01T22:00:00Z'));

    assert.equal(result.completed, 0);
    assert.equal(calls.some((call) => call.area === 'tx.booking.updateMany'), false);
  } finally {
    config.BETA_TEST_DEV_BYPASS = previousBeta;
    config.ESCROW_PROGRAM_ID = previousEscrow;
  }
});

test('the expiry sweep is a no-op outside the dev-bypass gate, exactly like every other mechanism in this file', async () => {
  const previousBeta = config.BETA_TEST_DEV_BYPASS;
  config.BETA_TEST_DEV_BYPASS = 'false';
  try {
    const { db, calls } = fakeExpiryDb({ expiredBookings: [{ id: 'booking-1', listing: { machineId: 'machine-1' } }] });
    const result = await reconcileExpiredActiveDeveloperBookings(db, new Date('2026-09-01T22:00:00Z'));

    assert.equal(result.completed, 0);
    assert.equal(calls.length, 0, 'must not even query when the bypass gate is off');
  } finally {
    config.BETA_TEST_DEV_BYPASS = previousBeta;
  }
});

test('findExpiredActiveDeveloperBookings only ever matches ACTIVE bookings whose real endsAt has passed', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const db = {
    booking: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push(args);
        return [];
      },
    },
  } as unknown as PrismaClient;
  const now = new Date('2026-09-01T22:00:00Z');
  await findExpiredActiveDeveloperBookings(db, now);
  const where = calls[0]!.where as { status: BookingStatus; endsAt: { lt: Date } };
  assert.equal(where.status, BookingStatus.ACTIVE);
  assert.equal(where.endsAt.lt, now);
});
