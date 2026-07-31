import { describe, expect, it } from 'vitest';
import {
  authorizeMiningConfigurationUpdate,
  miningConfigurationInputSchema,
  platformFeeBasisPoints,
  resourceMustStopForRental,
} from '../src/mining-config-policy.js';

const validGpuInput = {
  mode: 'GPUBNB_MANAGED' as const,
  resourceKind: 'GPU' as const,
  resourceId: 'gpu:machine_1:0',
  profileId: 'trex_rvn_kawpow',
  walletAddress: 'RExamplePublicAddress123456',
  workerName: 'host_gpu_0',
  autoResumeAfterRental: true,
  maximumTemperatureC: 80,
  maximumPowerWatts: 350,
  gpuIntensityPercent: 90,
  expectedVersion: 2,
};

const validCpuInput = {
  mode: 'OWNER_POOL' as const,
  resourceKind: 'CPU' as const,
  resourceId: 'cpu:machine_1:package_0',
  profileId: 'xmrig_randomx',
  walletAddress: '4ExamplePublicAddress123456',
  workerName: 'host_cpu_0',
  ownerPoolEndpoint: 'stratum+ssl://pool.example.com:443',
  ownerPoolSecretRef: 'secret://owner/pool/cpu-0',
  autoResumeAfterRental: true,
  maximumTemperatureC: 85,
  maximumPowerWatts: 180,
  cpuThreadLimit: 8,
  cpuUtilizationLimitPercent: 60,
  expectedVersion: 2,
};

const validContext = {
  ownerId: 'owner_1',
  machineOwnerId: 'owner_1',
  resourceMachineId: 'machine_1',
  requestedMachineId: 'machine_1',
  resourceKind: 'GPU' as const,
  resourceId: 'gpu:machine_1:0',
  rentedResourceIds: new Set<string>(),
  machineExclusiveRental: false,
  resourceQuarantined: false,
  currentVersion: 2,
  profileApproved: true,
};

describe('mining configuration policy', () => {
  it('charges one percent only for the managed pool', () => {
    expect(platformFeeBasisPoints('GPUBNB_MANAGED')).toBe(100);
    expect(platformFeeBasisPoints('OWNER_POOL')).toBe(0);
    expect(platformFeeBasisPoints('DISABLED')).toBe(0);
  });

  it('accepts independently configured GPU and CPU resources', () => {
    expect(miningConfigurationInputSchema.parse(validGpuInput).resourceKind).toBe('GPU');
    expect(miningConfigurationInputSchema.parse(validCpuInput).resourceKind).toBe('CPU');
  });

  it('stops only the resource selected by a partial rental', () => {
    const rented = new Set(['gpu:machine_1:0']);
    expect(
      resourceMustStopForRental({
        resourceId: 'gpu:machine_1:0',
        rentedResourceIds: rented,
        machineExclusiveRental: false,
      }),
    ).toBe(true);
    expect(
      resourceMustStopForRental({
        resourceId: 'cpu:machine_1:package_0',
        rentedResourceIds: rented,
        machineExclusiveRental: false,
      }),
    ).toBe(false);
  });

  it('stops every miner for an exclusive-machine rental', () => {
    expect(
      resourceMustStopForRental({
        resourceId: 'cpu:machine_1:package_0',
        rentedResourceIds: new Set(),
        machineExclusiveRental: true,
      }),
    ).toBe(true);
  });

  it('locks configuration changes for the rented resource', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, {
        ...validContext,
        rentedResourceIds: new Set([validGpuInput.resourceId]),
      }),
    ).toThrow('mining_configuration_locked_during_rental');
  });

  it('allows CPU configuration while only a GPU is rented', () => {
    const input = miningConfigurationInputSchema.parse(validCpuInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, {
        ...validContext,
        resourceKind: 'CPU',
        resourceId: validCpuInput.resourceId,
        rentedResourceIds: new Set([validGpuInput.resourceId]),
      }),
    ).not.toThrow();
  });

  it('requires the machine owner', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, { ...validContext, ownerId: 'attacker' }),
    ).toThrow('machine_owner_required');
  });

  it('uses optimistic concurrency', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, { ...validContext, currentVersion: 3 }),
    ).toThrow('mining_configuration_version_conflict');
  });

  it('rejects enabling mining on a quarantined resource', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, {
        ...validContext,
        resourceQuarantined: true,
      }),
    ).toThrow('quarantined_resource_cannot_mine');
  });

  it('requires an approved profile', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    expect(() =>
      authorizeMiningConfigurationUpdate(input, { ...validContext, profileApproved: false }),
    ).toThrow('mining_profile_not_approved');
  });

  it('requires CPU-specific limits', () => {
    expect(() =>
      miningConfigurationInputSchema.parse({ ...validCpuInput, cpuThreadLimit: undefined }),
    ).toThrow();
  });

  it('requires GPU intensity and rejects CPU controls on a GPU', () => {
    expect(() =>
      miningConfigurationInputSchema.parse({
        ...validGpuInput,
        gpuIntensityPercent: undefined,
        cpuThreadLimit: 4,
      }),
    ).toThrow();
  });
});
