import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorOperationalStatus,
  MiningRuntimeState,
  ModerationStatus,
} from '@prisma/client';

import { reactivateHealthyOfflineListings } from '../src/rental-listing-recovery.js';

const now = new Date('2026-08-18T04:30:00.000Z');
const recent = new Date('2026-08-18T04:29:30.000Z');

function accelerator(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function fakeTx(listings: unknown[]) {
  const updates: unknown[] = [];
  return {
    updates,
    tx: {
      gpuListing: {
        findMany: async () => listings,
        updateMany: async (args: unknown) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    },
  };
}

test('healthy exact GPU restores HIDDEN_OFFLINE listing', async () => {
  const { tx, updates } = fakeTx([{
    id: 'listing-1',
    accelerators: [{ accelerator: accelerator() }],
  }]);

  const recovered = await reactivateHealthyOfflineListings(tx as never, 'machine-1', now, 90);

  assert.deepEqual(recovered, ['listing-1']);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    where: { id: 'listing-1', status: 'HIDDEN_OFFLINE' },
    data: { status: 'ACTIVE' },
  });
});

test('stale or quarantined exact GPU never reactivates listing', async () => {
  for (const gpu of [
    accelerator({ lastSeenAt: new Date('2026-08-18T04:10:00.000Z') }),
    accelerator({ moderationStatus: ModerationStatus.QUARANTINED }),
    accelerator({ miningResource: null }),
  ]) {
    const { tx, updates } = fakeTx([{
      id: 'listing-blocked',
      accelerators: [{ accelerator: gpu }],
    }]);
    const recovered = await reactivateHealthyOfflineListings(tx as never, 'machine-1', now, 90);
    assert.deepEqual(recovered, []);
    assert.equal(updates.length, 0);
  }
});

test('listing with zero or multiple accelerator links never auto-recovers', async () => {
  const { tx, updates } = fakeTx([
    { id: 'none', accelerators: [] },
    {
      id: 'multiple',
      accelerators: [
        { accelerator: accelerator() },
        { accelerator: accelerator() },
      ],
    },
  ]);

  const recovered = await reactivateHealthyOfflineListings(tx as never, 'machine-1', now, 90);
  assert.deepEqual(recovered, []);
  assert.equal(updates.length, 0);
});
