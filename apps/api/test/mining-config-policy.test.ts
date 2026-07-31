import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  gpuVendor: 'NVIDIA' as const,
  rentedResourceIds: new Set<string>(),
  machineExclusiveRental: false,
  resourceQuarantined: false,
  currentVersion: 2,
};

const throwsMessage = (fn: () => unknown, message: string) => {
  assert.throws(fn, (error: unknown) => error instanceof Error && error.message === message);
};

describe('mining configuration policy', () => {
  it('charges one percent only for the managed pool', () => {
    assert.equal(platformFeeBasisPoints('GPUBNB_MANAGED'), 100);
    assert.equal(platformFeeBasisPoints('OWNER_POOL'), 0);
    assert.equal(platformFeeBasisPoints('DISABLED'), 0);
  });

  it('accepts independently configured GPU and CPU resources', () => {
    assert.equal(miningConfigurationInputSchema.parse(validGpuInput).resourceKind, 'GPU');
    assert.equal(miningConfigurationInputSchema.parse(validCpuInput).resourceKind, 'CPU');
  });

  it('accepts supported secret-manager references for owner pools', () => {
    for (const ownerPoolSecretRef of [
      'vault://gpubnb/mining/owner-1/cpu-0',
      'secret://owner/pool/cpu-0',
      'aws-secretsmanager://prod/gpubnb/mining/cpu-0',
      'gcp-secretmanager://projects/gpubnb/secrets/cpu-0/versions/latest',
      'azure-keyvault://gpubnb-vault/secrets/cpu-0',
    ]) {
      assert.equal(
        miningConfigurationInputSchema.parse({ ...validCpuInput, ownerPoolSecretRef }).ownerPoolSecretRef,
        ownerPoolSecretRef,
      );
    }
  });

  it('rejects raw owner-pool passwords and unsupported secret references', () => {
    for (const ownerPoolSecretRef of [
      'super-secret-password',
      'password=miner123',
      'https://vault.example.com/secrets/cpu-0',
      'env://MINING_POOL_PASSWORD',
    ]) {
      assert.throws(() => miningConfigurationInputSchema.parse({ ...validCpuInput, ownerPoolSecretRef }));
    }
  });

  it('stops only the resource selected by a partial rental', () => {
    const rented = new Set(['gpu:machine_1:0']);
    assert.equal(resourceMustStopForRental({ resourceId: 'gpu:machine_1:0', rentedResourceIds: rented, machineExclusiveRental: false }), true);
    assert.equal(resourceMustStopForRental({ resourceId: 'cpu:machine_1:package_0', rentedResourceIds: rented, machineExclusiveRental: false }), false);
  });

  it('stops every miner for an exclusive-machine rental', () => {
    assert.equal(resourceMustStopForRental({ resourceId: 'cpu:machine_1:package_0', rentedResourceIds: new Set(), machineExclusiveRental: true }), true);
  });

  it('locks configuration changes for the rented resource', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(() => authorizeMiningConfigurationUpdate(input, { ...validContext, rentedResourceIds: new Set([validGpuInput.resourceId]) }), 'mining_configuration_locked_during_rental');
  });

  it('allows CPU configuration while only a GPU is rented', () => {
    const input = miningConfigurationInputSchema.parse(validCpuInput);
    assert.doesNotThrow(() => authorizeMiningConfigurationUpdate(input, {
      ...validContext,
      resourceKind: 'CPU',
      resourceId: validCpuInput.resourceId,
      gpuVendor: undefined,
      rentedResourceIds: new Set([validGpuInput.resourceId]),
    }));
  });

  it('requires the machine owner', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(() => authorizeMiningConfigurationUpdate(input, { ...validContext, ownerId: 'attacker' }), 'machine_owner_required');
  });

  it('uses optimistic concurrency', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(() => authorizeMiningConfigurationUpdate(input, { ...validContext, currentVersion: 3 }), 'mining_configuration_version_conflict');
  });

  it('rejects enabling mining on a quarantined resource', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(() => authorizeMiningConfigurationUpdate(input, { ...validContext, resourceQuarantined: true }), 'quarantined_resource_cannot_mine');
  });

  it('rejects an NVIDIA-only profile on AMD', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(() => authorizeMiningConfigurationUpdate(input, { ...validContext, gpuVendor: 'AMD' }), 'mining_profile_not_approved');
  });

  it('rejects GPU mining when the hardware vendor is unknown', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(() => authorizeMiningConfigurationUpdate(input, { ...validContext, gpuVendor: undefined }), 'mining_profile_not_approved');
  });

  it('accepts a dual-vendor profile on AMD', () => {
    const input = miningConfigurationInputSchema.parse({
      ...validGpuInput,
      profileId: 'lolminer_etc_etchash',
    });
    assert.doesNotThrow(() => authorizeMiningConfigurationUpdate(input, { ...validContext, gpuVendor: 'AMD' }));
  });

  it('requires CPU-specific limits', () => {
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validCpuInput, cpuThreadLimit: undefined }));
  });

  it('requires GPU intensity and rejects CPU controls on a GPU', () => {
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validGpuInput, gpuIntensityPercent: undefined, cpuThreadLimit: 4 }));
  });
});
