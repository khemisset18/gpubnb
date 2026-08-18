import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorOperationalStatus,
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MiningRuntimeState,
  ModerationStatus,
} from '@prisma/client';

import {
  OwnerListingLifecycleError,
  transitionOwnerExactGpuListing,
} from '../src/rental-listing-lifecycle.js';

const now = new Date('2026-08-18T05:00:00.000Z');
const recent = new Date('2026-08-18T04:59:30.000Z');

function listing(status: ListingStatus, overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing-1',
    machineId: 'machine-1',
    status,
    resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    machine: {
      connectivity: MachineConnectivity.ONLINE,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: recent,
    },
    accelerators: [{
      accelerator: {
        status: AcceleratorOperationalStatus.AVAILABLE,
        moderationStatus: ModerationStatus.CLEAR,
        isolationVerified: true,
        verifiedAt: recent,
        lastSeenAt: recent,
        miningResource: {
          enabled: true,
          quarantined: false,
          runtimeState: MiningRuntimeState.IDLE,
          lastSeenAt: recent,
        },
      },
    }],
    bookings: [],
    ...overrides,
  };
}

function fakeDb(row: ReturnType<typeof listing>) {
  const updates: unknown[] = [];
  let reads = 0;
  const tx = {
    gpuListing: {
      findFirst: async () => {
        reads += 1;
        return reads === 1 ? { id: row.id, machineId: row.machineId } : row;
      },
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    $executeRaw: async () => 1,
  };
  return {
    updates,
    db: {
      $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx),
    },
  };
}

test('pause hides new bookings without cancelling an existing committed booking', async () => {
  const row = listing(ListingStatus.ACTIVE, {
    bookings: [{
      id: 'booking-1',
      status: BookingStatus.ACTIVE,
      startsAt: new Date('2026-08-18T04:30:00.000Z'),
      endsAt: new Date('2026-08-18T05:30:00.000Z'),
    }],
  });
  const { db, updates } = fakeDb(row);

  const result = await transitionOwnerExactGpuListing(db as never, 'owner-1', row.id, 'pause', now, 90);

  assert.equal(result.previousStatus, ListingStatus.ACTIVE);
  assert.equal(result.status, ListingStatus.PAUSED);
  assert.equal(updates.length, 1);
});

test('resume requires both fresh machine presence and healthy exact GPU', async () => {
  const healthy = listing(ListingStatus.PAUSED);
  const healthyDb = fakeDb(healthy);
  const resumed = await transitionOwnerExactGpuListing(healthyDb.db as never, 'owner-1', healthy.id, 'resume', now, 90);
  assert.equal(resumed.status, ListingStatus.ACTIVE);

  const offline = listing(ListingStatus.PAUSED, {
    machine: {
      connectivity: MachineConnectivity.OFFLINE,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: recent,
    },
  });
  await assert.rejects(
    transitionOwnerExactGpuListing(fakeDb(offline).db as never, 'owner-1', offline.id, 'resume', now, 90),
    (error: unknown) => error instanceof OwnerListingLifecycleError && error.code === 'machine_not_ready',
  );

  const missingAuthority = listing(ListingStatus.PAUSED, {
    accelerators: [{ accelerator: {
      ...listing(ListingStatus.PAUSED).accelerators[0].accelerator,
      miningResource: null,
    } }],
  });
  await assert.rejects(
    transitionOwnerExactGpuListing(fakeDb(missingAuthority).db as never, 'owner-1', missingAuthority.id, 'resume', now, 90),
    (error: unknown) => error instanceof OwnerListingLifecycleError && error.code === 'accelerator_not_ready',
  );
});

test('archive is refused while a committed booking still exists', async () => {
  const row = listing(ListingStatus.PAUSED, {
    bookings: [{
      id: 'booking-live',
      status: BookingStatus.AWAITING_DEPOSIT,
      startsAt: new Date('2026-08-18T05:10:00.000Z'),
      endsAt: new Date('2026-08-18T06:10:00.000Z'),
    }],
  });

  await assert.rejects(
    transitionOwnerExactGpuListing(fakeDb(row).db as never, 'owner-1', row.id, 'archive', now, 90),
    (error: unknown) => error instanceof OwnerListingLifecycleError && error.code === 'listing_has_live_booking',
  );
});

test('archive releases the listing identity once no committed booking remains', async () => {
  const row = listing(ListingStatus.PAUSED);
  const { db } = fakeDb(row);

  const archived = await transitionOwnerExactGpuListing(db as never, 'owner-1', row.id, 'archive', now, 90);
  assert.equal(archived.status, ListingStatus.ARCHIVED);
});

test('security-suspended listing cannot be owner-resumed or owner-archived', async () => {
  const row = listing(ListingStatus.SUSPENDED);
  for (const action of ['resume', 'archive'] as const) {
    await assert.rejects(
      transitionOwnerExactGpuListing(fakeDb(row).db as never, 'owner-1', row.id, action, now, 90),
      (error: unknown) => error instanceof OwnerListingLifecycleError && error.code === 'invalid_listing_transition',
    );
  }
});
