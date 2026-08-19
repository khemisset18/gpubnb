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

function fullMachineBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.booking,
    status: 'AWAITING_DEPOSIT',
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
    ...overrides,
  };
}

function healthySelectedBooking(overrides: Record<string, unknown> = {}, bookingOverrides: Record<string, unknown> = {}) {
  const acceleratorId = 'cm000000000000000000009';
  const recent = new Date();
  return {
    acceleratorId,
    booking: {
      id: ids.booking,
      status: 'AWAITING_DEPOSIT',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3_600_000),
      machineAllocation: null,
      acceleratorAllocations: [],
      ...bookingOverrides,
      listing: {
        status: 'ACTIVE',
        resourceMode: 'SELECTED_ACCELERATORS',
        minimumAccelerators: null,
        maximumAccelerators: null,
        machineId: ids.machine,
        machine: {
          moderationStatus: 'CLEAR',
          accelerators: [{
            id: acceleratorId,
            status: 'AVAILABLE',
            moderationStatus: 'CLEAR',
            isolationVerified: true,
            verifiedAt: recent,
            lastSeenAt: recent,
            miningResource: {
              enabled: true,
              quarantined: false,
              runtimeState: 'IDLE',
              activeRentalId: null,
              lastSeenAt: recent,
            },
            ...overrides,
          }],
        },
        accelerators: [{ acceleratorId }],
      },
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

test('allocateBookingResources allocates the exact verified GPU linked to the listing', async () => {
  const { acceleratorId, booking } = healthySelectedBooking();
  const { db, writes } = fakeDb(booking);

  const result = await allocateBookingResources(db as never, {
    bookingId: ids.booking,
    buyerId: ids.buyer,
  });

  assert.equal(result.mode, 'SELECTED_ACCELERATORS');
  assert.deepEqual(result.acceleratorIds, [acceleratorId]);
  assert.deepEqual(writes, ['advisory_lock', 'acceleratorAllocation.createMany:1']);
});

test('allocateBookingResources rejects a selected accelerator that is not rentable', async () => {
  const { acceleratorId, booking } = healthySelectedBooking({ status: 'MAINTENANCE' });
  const { db } = fakeDb(booking);

  await assert.rejects(
    allocateBookingResources(db as never, { bookingId: ids.booking, buyerId: ids.buyer, acceleratorIds: [acceleratorId] }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'accelerator_not_rentable',
  );
});

test('allocation fails closed when the exact GPU MiningResource authority is missing', async () => {
  const { acceleratorId, booking } = healthySelectedBooking({ miningResource: null });
  const { db, writes } = fakeDb(booking);

  await assert.rejects(
    allocateBookingResources(db as never, { bookingId: ids.booking, buyerId: ids.buyer, acceleratorIds: [acceleratorId] }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'accelerator_not_rentable',
  );
  assert.deepEqual(writes, ['advisory_lock']);
});

test('allocation fails closed when exact GPU authority is stale or already bound to a rental', async () => {
  const stale = new Date(Date.now() - 3_600_000);
  const staleCase = healthySelectedBooking({ lastSeenAt: stale });
  const staleDb = fakeDb(staleCase.booking);
  await assert.rejects(
    allocateBookingResources(staleDb.db as never, { bookingId: ids.booking, buyerId: ids.buyer }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'accelerator_not_rentable',
  );

  const boundCase = healthySelectedBooking({
    miningResource: {
      enabled: true,
      quarantined: false,
      runtimeState: 'IDLE',
      activeRentalId: 'unexpected-existing-rental',
      lastSeenAt: new Date(),
    },
  });
  const boundDb = fakeDb(boundCase.booking);
  await assert.rejects(
    allocateBookingResources(boundDb.db as never, { bookingId: ids.booking, buyerId: ids.buyer }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'accelerator_not_rentable',
  );
});

// Regression: a stale/delayed allocation attempt racing a booking that has since moved
// on (most concretely, one the orphaned-deposit reconciler already cancelled for having
// no allocation - see dev-booking-reconciler.ts) must never be allowed to create a live
// resource lock for it. Covers both product paths since either could carry a
// late-arriving retry.
test('allocateBookingResources never allocates a resource for a booking that is no longer AWAITING_DEPOSIT', async () => {
  const { db: fullMachineDb, writes: fullMachineWrites } = fakeDb(fullMachineBooking({ status: 'CANCELLED' }));
  await assert.rejects(
    allocateBookingResources(fullMachineDb as never, { bookingId: ids.booking, buyerId: ids.buyer }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'booking_not_awaiting_deposit',
  );
  assert.deepEqual(fullMachineWrites, [], 'no advisory lock or allocation write may happen before the booking-state check');

  const { booking } = healthySelectedBooking({}, { status: 'CANCELLED' });
  const { db: selectedDb, writes: selectedWrites } = fakeDb(booking);
  await assert.rejects(
    allocateBookingResources(selectedDb as never, { bookingId: ids.booking, buyerId: ids.buyer }),
    (error: unknown) => error instanceof ResourceAllocationError && error.code === 'booking_not_awaiting_deposit',
  );
  assert.deepEqual(selectedWrites, []);
});
