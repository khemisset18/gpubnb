import { describe, expect, it } from 'vitest';
import {
  authorizeMiningConfigurationUpdate,
  miningConfigurationInputSchema,
  platformFeeBasisPoints,
} from '../src/mining-config-policy.js';

const validInput = {
  mode: 'GPUBNB_MANAGED' as const,
  acceleratorId: 'ckx1234567890abcdefghijkl',
  profileId: 'trex_rvn_kawpow',
  walletAddress: 'RExamplePublicAddress123456',
  workerName: 'host_gpu_0',
  autoResumeAfterRental: true,
  maximumTemperatureC: 80,
  maximumPowerWatts: 350,
  expectedVersion: 2,
};

const validContext = {
  ownerId: 'owner_1',
  machineOwnerId: 'owner_1',
  acceleratorMachineId: 'machine_1',
  requestedMachineId: 'machine_1',
  activeRental: false,
  acceleratorQuarantined: false,
  currentVersion: 2,
  profileApproved: true,
};

describe('mining configuration policy', () => {
  it('charges one percent only for the managed pool', () => {
    expect(platformFeeBasisPoints('GPUBNB_MANAGED')).toBe(100);
    expect(platformFeeBasisPoints('OWNER_POOL')).toBe(0);
    expect(platformFeeBasisPoints('DISABLED')).toBe(0);
  });

  it('locks changes while a rental is active', () => {
    const input = miningConfigurationInputSchema.parse(validInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, { ...validContext, activeRental: true }),
    ).toThrow('mining_configuration_locked_during_rental');
  });

  it('requires the machine owner', () => {
    const input = miningConfigurationInputSchema.parse(validInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, {
        ...validContext,
        ownerId: 'attacker',
      }),
    ).toThrow('machine_owner_required');
  });

  it('uses optimistic concurrency', () => {
    const input = miningConfigurationInputSchema.parse(validInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, { ...validContext, currentVersion: 3 }),
    ).toThrow('mining_configuration_version_conflict');
  });

  it('rejects enabling mining on a quarantined accelerator', () => {
    const input = miningConfigurationInputSchema.parse(validInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, {
        ...validContext,
        acceleratorQuarantined: true,
      }),
    ).toThrow('quarantined_accelerator_cannot_mine');
  });

  it('requires an approved profile', () => {
    const input = miningConfigurationInputSchema.parse(validInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, { ...validContext, profileApproved: false }),
    ).toThrow('mining_profile_not_approved');
  });

  it('requires an owner endpoint for owner-pool mode', () => {
    expect(() =>
      miningConfigurationInputSchema.parse({ ...validInput, mode: 'OWNER_POOL' }),
    ).toThrow();
  });

  it('rejects owner endpoints in managed-pool mode', () => {
    expect(() =>
      miningConfigurationInputSchema.parse({
        ...validInput,
        ownerPoolEndpoint: 'stratum+ssl://pool.example.com:443',
      }),
    ).toThrow();
  });
});
