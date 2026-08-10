import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareComputeRental, stopRentalSession } from '../src/rental-workflow-transactions.js';

const ids = {
  booking: 'cm000000000000000000001',
  renter: 'cm000000000000000000002',
  listing: 'cm000000000000000000003',
  machine: 'cm000000000000000000004',
  workspace: 'cm000000000000000000005',
  session: 'cm000000000000000000006',
  job: 'cm000000000000000000007',
};

test('prepareComputeRental writes session, job, outbox and machine command in one transaction', async () => {
  const writes: string[] = [];
  const startsAt = new Date(Date.now() + 60_000);
  const endsAt = new Date(Date.now() + 3_600_000);
  const tx = {
    workspaceSession: {
      findFirst: async () => null,
      create: async () => ({
        id: ids.session,
        status: 'PREPARING',
        expiresAt: endsAt,
        resourceLimits: {},
        preparationProgress: 5,
        preparationStep: 'RESERVATION_CONFIRMED',
      }),
      update: async () => { writes.push('session.update'); return {}; },
    },
    booking: {
      findFirst: async () => ({
        id: ids.booking,
        buyerId: ids.renter,
        listingId: ids.listing,
        startsAt,
        endsAt,
        listing: { id: ids.listing, machineId: ids.machine },
      }),
    },
    machineWorkspace: {
      findFirst: async () => ({ id: ids.workspace, configuration: null }),
    },
    job: {
      create: async () => { writes.push('job.create'); return { id: ids.job }; },
    },
    $queryRaw: async () => [{ sequence: 1n }],
    $executeRaw: async (parts: TemplateStringsArray) => {
      const sql = parts.join('');
      writes.push(sql.includes('OutboxEvent') ? 'outbox' : sql.includes('MachineCommand') ? 'command' : 'sql');
      return 1;
    },
  };
  const db = { $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx) };

  const result = await prepareComputeRental(db as never, ids.booking, ids.renter);

  assert.equal(result.id, ids.session);
  assert.deepEqual(writes, ['job.create', 'session.update', 'outbox', 'command']);
});

test('prepareComputeRental is idempotent for an existing renter session', async () => {
  let transactionWrites = 0;
  const startsAt = new Date(Date.now() + 60_000);
  const endsAt = new Date(Date.now() + 3_600_000);
  const existing = {
    id: ids.session,
    renterId: ids.renter,
    status: 'PREPARING',
    expiresAt: new Date(),
    resourceLimits: {},
    preparationProgress: 10,
    preparationStep: 'DOWNLOADING',
  };
  const tx = {
    // The machineWorkspace lookup now happens before the existing-session check (the
    // check is scoped to it: one session per (booking, machineWorkspace), not per
    // booking), so both must be mocked even though this test only exercises the
    // "already exists" idempotency path.
    booking: {
      findFirst: async () => ({
        id: ids.booking,
        buyerId: ids.renter,
        listingId: ids.listing,
        startsAt,
        endsAt,
        listing: { id: ids.listing, machineId: ids.machine },
      }),
    },
    machineWorkspace: {
      findFirst: async () => ({ id: ids.workspace, configuration: null }),
    },
    workspaceSession: { findFirst: async () => existing },
  };
  const db = {
    $transaction: async (handler: (value: typeof tx) => unknown) => {
      const result = await handler(tx);
      transactionWrites += 1;
      return result;
    },
  };

  const result = await prepareComputeRental(db as never, ids.booking, ids.renter);
  assert.equal(result.id, ids.session);
  assert.equal(transactionWrites, 1);
});

test('stopRentalSession atomically requests cancellation and emits a stop command', async () => {
  const writes: string[] = [];
  const tx = {
    workspaceSession: {
      findFirst: async () => ({
        id: ids.session,
        renterId: ids.renter,
        jobId: ids.job,
        status: 'RUNNING',
        booking: {
          id: ids.booking,
          listingId: ids.listing,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 60_000),
        },
        machine: { id: ids.machine, ownerId: 'cm000000000000000000099' },
      }),
      update: async () => { writes.push('session.stop'); return {}; },
    },
    job: {
      updateMany: async () => { writes.push('job.cancel'); return { count: 1 }; },
    },
    $queryRaw: async () => [{ sequence: 2n }],
    $executeRaw: async (parts: TemplateStringsArray) => {
      const sql = parts.join('');
      writes.push(sql.includes('OutboxEvent') ? 'outbox' : sql.includes('MachineCommand') ? 'command' : 'sql');
      return 1;
    },
  };
  const db = { $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx) };

  const result = await stopRentalSession(db as never, ids.session, ids.renter);

  assert.equal(result.status, 'STOP_REQUESTED');
  assert.deepEqual(writes, ['session.stop', 'job.cancel', 'outbox', 'command']);
});
