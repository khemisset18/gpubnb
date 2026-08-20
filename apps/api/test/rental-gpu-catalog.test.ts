import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorOperationalStatus,
  MiningResourceKind,
  MiningRuntimeState,
  ModerationStatus,
} from '@prisma/client';
import {
  computeRentalGpuReadiness,
  listOwnerRentalGpus,
  type RentalGpuReadinessInput,
} from '../src/rental-gpu-catalog.js';

const now = new Date('2026-08-18T03:00:00.000Z');
const fresh = new Date('2026-08-18T02:59:30.000Z');

function readyGpu(overrides: Partial<RentalGpuReadinessInput> = {}): RentalGpuReadinessInput {
  return {
    status: AcceleratorOperationalStatus.AVAILABLE,
    moderationStatus: ModerationStatus.CLEAR,
    isolationVerified: true,
    verifiedAt: fresh,
    lastSeenAt: fresh,
    miningResource: {
      kind: MiningResourceKind.GPU,
      enabled: true,
      quarantined: false,
      runtimeState: MiningRuntimeState.IDLE,
      activeRentalId: null,
      lastSeenAt: fresh,
    },
    hasLiveAllocation: false,
    hasReservableListing: false,
    hasFullMachineListing: false,
    ...overrides,
  };
}

test('exact GPU is publishable only with fresh verified resource authority', () => {
  const result = computeRentalGpuReadiness(readyGpu(), now, 90);
  assert.deepEqual(result, { publishable: true, blockingReason: null });
});

test('missing Accelerator to MiningResource authority blocks publication before booking', () => {
  const result = computeRentalGpuReadiness(readyGpu({ miningResource: null }), now, 90);
  assert.deepEqual(result, {
    publishable: false,
    blockingReason: 'RESOURCE_AUTHORITY_MISSING',
  });
});

test('quarantine, missing isolation and stale evidence fail closed', () => {
  assert.equal(
    computeRentalGpuReadiness(readyGpu({ moderationStatus: ModerationStatus.QUARANTINED }), now, 90).blockingReason,
    'ACCELERATOR_QUARANTINED',
  );
  assert.equal(
    computeRentalGpuReadiness(readyGpu({ isolationVerified: false }), now, 90).blockingReason,
    'ISOLATION_NOT_VERIFIED',
  );
  assert.equal(
    computeRentalGpuReadiness(
      readyGpu({ lastSeenAt: new Date('2026-08-18T02:50:00.000Z') }),
      now,
      90,
    ).blockingReason,
    'ACCELERATOR_STALE',
  );
});

test('resource authority quarantine and unsafe runtime block publication', () => {
  assert.equal(
    computeRentalGpuReadiness(readyGpu({
      miningResource: {
        ...readyGpu().miningResource!,
        quarantined: true,
      },
    }), now, 90).blockingReason,
    'RESOURCE_AUTHORITY_QUARANTINED',
  );
  assert.equal(
    computeRentalGpuReadiness(readyGpu({
      miningResource: {
        ...readyGpu().miningResource!,
        runtimeState: MiningRuntimeState.RENTAL_BLOCKED,
      },
    }), now, 90).blockingReason,
    'RESOURCE_RUNTIME_UNSAFE',
  );
});

test('live allocation or another reservable listing blocks duplicate publication', () => {
  assert.equal(
    computeRentalGpuReadiness(readyGpu({ hasLiveAllocation: true }), now, 90).blockingReason,
    'ACCELERATOR_ALLOCATED',
  );
  assert.equal(
    computeRentalGpuReadiness(readyGpu({ hasReservableListing: true }), now, 90).blockingReason,
    'ACCELERATOR_ALREADY_LISTED',
  );
  assert.equal(
    computeRentalGpuReadiness(readyGpu({ hasFullMachineListing: true }), now, 90).blockingReason,
    'FULL_MACHINE_LISTING_ACTIVE',
  );
});

test('listOwnerRentalGpus surfaces the blocking legacy listing id so the owner can archive it', async () => {
  const fakeDb = {
    machine: {
      findFirst: async () => ({
        id: 'machine-1',
        listings: [{ id: 'legacy-listing-1' }],
        accelerators: [{
          id: 'gpu-1',
          hardwareUuid: 'GPU-UUID-1',
          slotIndex: 0,
          vendor: 'NVIDIA',
          model: 'GeForce GTX 1650',
          vramMiB: 4096,
          driverVersion: '592.82',
          cudaVersion: '13.1',
          status: AcceleratorOperationalStatus.AVAILABLE,
          moderationStatus: ModerationStatus.CLEAR,
          isolationVerified: true,
          verifiedAt: fresh,
          lastSeenAt: fresh,
          miningResource: {
            kind: MiningResourceKind.GPU,
            enabled: true,
            quarantined: false,
            runtimeState: MiningRuntimeState.IDLE,
            activeRentalId: null,
            lastSeenAt: fresh,
          },
          allocations: [],
          listings: [],
        }],
      }),
    },
  };

  const gpus = await listOwnerRentalGpus(fakeDb as never, 'machine-1', 'owner-1', now, 90);
  assert.equal(gpus?.length, 1);
  assert.deepEqual(gpus?.[0], {
    id: 'gpu-1',
    hardwareUuid: 'GPU-UUID-1',
    slotIndex: 0,
    vendor: 'NVIDIA',
    model: 'GeForce GTX 1650',
    vramMiB: 4096,
    driverVersion: '592.82',
    cudaVersion: '13.1',
    verifiedAt: fresh,
    lastSeenAt: fresh,
    publishable: false,
    blockingReason: 'FULL_MACHINE_LISTING_ACTIVE',
    blockingListingId: 'legacy-listing-1',
  });
});

test('listOwnerRentalGpus never sets blockingListingId when the GPU is publishable', async () => {
  const fakeDb = {
    machine: {
      findFirst: async () => ({
        id: 'machine-1',
        listings: [],
        accelerators: [{
          id: 'gpu-1',
          hardwareUuid: 'GPU-UUID-1',
          slotIndex: 0,
          vendor: 'NVIDIA',
          model: 'GeForce GTX 1650',
          vramMiB: 4096,
          driverVersion: '592.82',
          cudaVersion: '13.1',
          status: AcceleratorOperationalStatus.AVAILABLE,
          moderationStatus: ModerationStatus.CLEAR,
          isolationVerified: true,
          verifiedAt: fresh,
          lastSeenAt: fresh,
          miningResource: {
            kind: MiningResourceKind.GPU,
            enabled: true,
            quarantined: false,
            runtimeState: MiningRuntimeState.IDLE,
            activeRentalId: null,
            lastSeenAt: fresh,
          },
          allocations: [],
          listings: [],
        }],
      }),
    },
  };

  const gpus = await listOwnerRentalGpus(fakeDb as never, 'machine-1', 'owner-1', now, 90);
  assert.equal(gpus?.[0]?.publishable, true);
  assert.equal('blockingListingId' in (gpus?.[0] ?? {}), false);
});
