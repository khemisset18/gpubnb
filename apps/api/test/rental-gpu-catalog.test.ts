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
