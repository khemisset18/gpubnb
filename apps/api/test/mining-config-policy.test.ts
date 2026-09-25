import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authorizeMiningConfigurationUpdate,
  miningConfigurationInputSchema,
  platformFeeBasisPoints,
  resourceMustStopForRental,
} from '../src/mining-config-policy.js';

const validGpuInput = {
  mode: 'OWNER_POOL' as const,
  resourceKind: 'GPU' as const,
  resourceId: 'gpu:machine_1:0',
  profileId: 'lolminer_etchash',
  walletAddress: 'RExamplePublicAddress123456',
  workerName: 'host_gpu_0',
  ownerPoolEndpoint: 'stratum+tcp://pool.example.com:4444',
  autoResumeAfterRental: true,
  maximumTemperatureC: 85,
  maximumPowerWatts: 350,
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
  ownerPoolSecretRef: 'secret://local/mining/cpu-0',
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

  it('rejects the managed pool until its runtime is implemented', () => {
    assert.throws(() => miningConfigurationInputSchema.parse({
      ...validGpuInput,
      mode: 'GPUBNB_MANAGED',
      ownerPoolEndpoint: undefined,
    }));
  });

  it('accepts independently configured GPU and CPU resources', () => {
    assert.equal(miningConfigurationInputSchema.parse(validGpuInput).resourceKind, 'GPU');
    assert.equal(miningConfigurationInputSchema.parse(validCpuInput).resourceKind, 'CPU');
  });

  it('accepts only the qualified local mining secret reference shape', () => {
    for (const ownerPoolSecretRef of [
      'secret://local/mining/pool-main',
      'secret://local/mining/cpu-0',
      'secret://local/mining/owner_pool.01',
    ]) {
      assert.equal(
        miningConfigurationInputSchema.parse({ ...validCpuInput, ownerPoolSecretRef }).ownerPoolSecretRef,
        ownerPoolSecretRef,
      );
    }
  });


  it('rejects ambiguous owner-pool endpoints before they can become durable commands', () => {
    for (const ownerPoolEndpoint of [
      'stratum+tcp://pool.example.com',
      'stratum+tcp://user:secret@pool.example.com:4444',
      'stratum+tls://pool.example.com:4444/path',
      'stratum+tls://pool.example.com:4444?region=eu',
      'stratum+ssl://pool.example.com:4444#fragment',
      'https://pool.example.com:4444',
    ]) {
      assert.throws(() => miningConfigurationInputSchema.parse({ ...validGpuInput, ownerPoolEndpoint }));
    }
    assert.equal(
      miningConfigurationInputSchema.parse({
        ...validGpuInput,
        ownerPoolEndpoint: 'stratum+tls://pool.example.com:4444/',
      }).ownerPoolEndpoint,
      'stratum+tls://pool.example.com:4444/',
    );
  });

  it('rejects raw owner-pool passwords and unsupported secret references', () => {
    for (const ownerPoolSecretRef of [
      'super-secret-password',
      'password=miner123',
      'https://vault.example.com/secrets/cpu-0',
      'env://MINING_POOL_PASSWORD',
      'vault://gpubnb/mining/owner-1/cpu-0',
      'secret://owner/pool/cpu-0',
      'aws-secretsmanager://prod/gpubnb/mining/cpu-0',
      'gcp-secretmanager://projects/gpubnb/secrets/cpu-0/versions/latest',
      'azure-keyvault://gpubnb-vault/secrets/cpu-0',
      'secret://local/mining/x',
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

  it('rejects lolMiner GPU execution on AMD until an AMD resource adapter is qualified', () => {
    const input = miningConfigurationInputSchema.parse(validGpuInput);
    throwsMessage(
      () => authorizeMiningConfigurationUpdate(input, { ...validContext, gpuVendor: 'AMD' }),
      'mining_profile_not_approved',
    );
  });

  it('requires CPU-specific limits', () => {
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validCpuInput, cpuThreadLimit: undefined }));
  });

  it('allows CPU thermal configuration from the database minimum through 98 C', () => {
    assert.equal(miningConfigurationInputSchema.parse({ ...validCpuInput, maximumTemperatureC: 50 }).maximumTemperatureC, 50);
    assert.equal(miningConfigurationInputSchema.parse({ ...validCpuInput, maximumTemperatureC: 98 }).maximumTemperatureC, 98);
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validCpuInput, maximumTemperatureC: 49 }));
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validCpuInput, maximumTemperatureC: 99 }));
  });

  it('allows GPU owners to choose 85 through 98 C but not outside that range', () => {
    assert.equal(miningConfigurationInputSchema.parse({ ...validGpuInput, maximumTemperatureC: 85 }).maximumTemperatureC, 85);
    assert.equal(miningConfigurationInputSchema.parse({ ...validGpuInput, maximumTemperatureC: 98 }).maximumTemperatureC, 98);
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validGpuInput, maximumTemperatureC: 84 }));
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validGpuInput, maximumTemperatureC: 99 }));
  });

  it('rejects unenforced GPU intensity for every resource kind', () => {
    assert.equal(miningConfigurationInputSchema.parse(validGpuInput).gpuIntensityPercent, undefined);
    assert.throws(
      () => miningConfigurationInputSchema.parse({ ...validGpuInput, gpuIntensityPercent: 80 }),
      /gpu_intensity_not_supported/,
    );
    assert.throws(
      () => miningConfigurationInputSchema.parse({ ...validCpuInput, gpuIntensityPercent: 80 }),
      /gpu_intensity_not_supported/,
    );
    assert.throws(() => miningConfigurationInputSchema.parse({ ...validGpuInput, cpuThreadLimit: 4 }));
  });
});
