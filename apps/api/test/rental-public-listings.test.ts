import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorOperationalStatus,
  MiningRuntimeState,
  ModerationStatus,
} from '@prisma/client';
import {
  isExactGpuPubliclyHealthy,
  type PublicExactGpuHealthInput,
} from '../src/rental-public-listings.js';

const now = new Date('2026-08-18T04:00:00.000Z');
const recent = new Date('2026-08-18T03:59:30.000Z');

function healthy(overrides: Partial<PublicExactGpuHealthInput> = {}): PublicExactGpuHealthInput {
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

test('verified exact GPU with fresh authority remains public', () => {
  assert.equal(isExactGpuPubliclyHealthy(healthy(), now, 90), true);
});

test('reserved and running GPUs may remain visible while availability is handled separately', () => {
  assert.equal(isExactGpuPubliclyHealthy(healthy({ status: AcceleratorOperationalStatus.RESERVED }), now, 90), true);
  assert.equal(isExactGpuPubliclyHealthy(healthy({ status: AcceleratorOperationalStatus.RUNNING }), now, 90), true);
});

test('stale, quarantined or unisolated GPU disappears from public marketplace', () => {
  assert.equal(isExactGpuPubliclyHealthy(healthy({ lastSeenAt: new Date('2026-08-18T03:40:00.000Z') }), now, 90), false);
  assert.equal(isExactGpuPubliclyHealthy(healthy({ moderationStatus: ModerationStatus.QUARANTINED }), now, 90), false);
  assert.equal(isExactGpuPubliclyHealthy(healthy({ isolationVerified: false }), now, 90), false);
});

test('missing, quarantined or unsafe MiningResource fails closed', () => {
  assert.equal(isExactGpuPubliclyHealthy(healthy({ miningResource: null }), now, 90), false);
  assert.equal(isExactGpuPubliclyHealthy(healthy({
    miningResource: {
      enabled: true,
      quarantined: true,
      runtimeState: MiningRuntimeState.IDLE,
      lastSeenAt: recent,
    },
  }), now, 90), false);
  assert.equal(isExactGpuPubliclyHealthy(healthy({
    miningResource: {
      enabled: true,
      quarantined: false,
      runtimeState: MiningRuntimeState.RENTAL_BLOCKED,
      lastSeenAt: recent,
    },
  }), now, 90), false);
});
