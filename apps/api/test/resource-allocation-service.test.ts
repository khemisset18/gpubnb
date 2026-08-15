import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import { allocateBookingResources, ResourceAllocationError } from '../src/resource-allocation-service.js';
import { configureSchedulerPresence, resetSchedulerPresenceForTests } from '../src/scheduler-presence.js';

const ids = {
  booking: 'cm000000000000000000001',
  buyer: 'cm000000000000000000002',
  machine: 'cm000000000000000000003',
};

function fakeDb(booking: unknown) {
  const writes: string[] = [];
  const tx = {
    booking: { findFirst: async () => booking },
    $executeRaw: async () => { writes.push('advisory_lock'); return 1; },
    machineAllocation: {
      create: async (args: { data: Record<string, unknown> }) => { writes.push('machineAllocation.create'); return args.data; },
    },
    acceleratorAllocation: {
      createMany: async (args: { data: unknown[] }) => { writes.push(`acceleratorAllocation.createMany:${args.data.length}`); return { count: args.data.length }; },
    },
  };
  const db = { $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx) };
  return { db, writes };
}

function fullMachineBooking() {
  return {
    id: ids.booking,
    startsAt: new Date(),
    endsAt: new Date(Date.now() + 3_600_000),
    machineAllocation: null,
    acceleratorAllocations: [],
    listing: {
      status: 'ACTIVE',
      resourceMode: 'FULL_MACHINE',
      minimumAccelerators: null,
      maximumAccelerators: null,
      machineId: ids.machine,
      machine: { moderationStatus: 'CLEAR', accelerators: [] },
      accelerators: [],
    },
  };
}

test.afterEach(() => resetSchedulerPresenceForTests());

test('allocateBookingResources creates a MachineAllocation for a FULL_MACHINE listing', async () => {
  const { db, writes } = fakeDb(fullMachineBooking());

  const result = await allocateBookingResources(db as never, { bookingId: ids.booking, buyerId: ids.buyer });

  assert.equal(result.mode, 'FULL_MACHINE');
  assert.deepEqual(result.acceleratorIds, []);
  assert.deepEqual(writes, ['advisory_lock', 'machineAllocation.create']);
});

test('hot presence canary blocks the real allocation before any allocation write', async () => {
  const missingPresence = {
    hgetall: async () => ({}),
    pttl: async () => -2,
  } as unknown as Redis;
  configureSchedulerPresence(missingPresence, 'hot', {
    AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: '10000',
    SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS: '10000',
  });
  const { db, writes } = fakeDb(fullMachineBooking());

  await assert.rejects(
    allocateBookingResources(db as never, { bookingId: ids.booking, buyerId: ids.buyer }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'machine_not_online',
  );
  assert.deepEqual(writes, []);
});

test('allocateBookingResources refuses to double-allocate an already-allocated booking', async () => {
  const { db } = fakeDb({
    ...fullMachineBooking(),
    machineAllocation: { id: 'existing' },
  });

  await assert.rejects(
    allocateBookingResources(db as never, { bookingId: ids.booking, buyerId: ids.buyer }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'allocation_already_exists',
  );
});

test('allocateBookingResources rejects a selected accelerator that is not rentable', async () => {
  const acceleratorId = 'cm000000000000000000009';
  const { db } = fakeDb({
    id: ids.booking,
    startsAt: new Date(),
    endsAt: new Date(Date.now() + 3_600_000),
    machineAllocation: null,
    acceleratorAllocations: [],
    listing: {
      status: 'ACTIVE',
      resourceMode: 'SELECTED_ACCELERATORS',
      minimumAccelerators: null,
      maximumAccelerators: null,
      machineId: ids.machine,
      machine: {
        moderationStatus: 'CLEAR',
        accelerators: [{ id: acceleratorId, status: 'MAINTENANCE', moderationStatus: 'CLEAR', isolationVerified: true }],
      },
      accelerators: [{ acceleratorId }],
    },
  });

  await assert.rejects(
    allocateBookingResources(db as never, { bookingId: ids.booking, buyerId: ids.buyer, acceleratorIds: [acceleratorId] }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'accelerator_not_rentable',
  );
});
