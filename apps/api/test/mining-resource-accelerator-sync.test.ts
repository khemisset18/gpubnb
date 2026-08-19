import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AcceleratorOperationalStatus,
  MachineOperational,
  ModerationStatus,
  type Prisma,
} from '@prisma/client';

import { gpuMiningResourceKey, syncGpuMiningResourcesFromAccelerators } from '../src/mining-resource-inventory.js';
import type { AcceleratorTelemetry } from '../src/accelerator-telemetry.js';

// Regression coverage for `rental_gpu_resource_mapping_missing`.
//
// The modern accelerator heartbeat path (`MachineAccelerator` telemetry) and the
// legacy rental resource authority (`Accelerator -> MiningResource`) used to be
// synchronized by two independent code paths. A host could report a healthy,
// online, publishable heartbeat while the rental authority still had no GPU
// resource mapping for that exact physical GPU, because nothing bridged the two
// inventories in the same transaction. `syncGpuMiningResourcesFromAccelerators`
// is that bridge; these tests exercise it directly, not just its downstream
// fail-closed/self-heal consumers.

const MACHINE_ID = 'machine_00000001';

function gpu(deviceId: string, overrides: Partial<AcceleratorTelemetry> = {}): AcceleratorTelemetry {
  return {
    schemaVersion: 1,
    kind: 'GPU',
    vendor: 'NVIDIA',
    model: 'NVIDIA Test GPU',
    deviceId,
    busAddress: null,
    driverVersion: '550.10',
    runtimeVersion: '12.4',
    memoryTotalMiB: 24_000,
    memoryUsedMiB: null,
    utilizationPercent: null,
    temperatureC: null,
    powerWatts: null,
    available: true,
    throttling: false,
    capabilities: {},
    metrics: {},
    ...overrides,
  };
}

type FakeAccelerator = { id: string; hardwareUuid: string; status: AcceleratorOperationalStatus };
type FakeResource = { id: string; acceleratorId: string; resourceKey: string; enabled: boolean; lastSeenAt: Date };

function fakeTransaction(machineOverrides: Record<string, unknown> = {}) {
  const acceleratorsByUuid = new Map<string, FakeAccelerator>();
  let acceleratorSequence = 0;
  const resourcesById = new Map<string, FakeResource>();
  const resourcesByAcceleratorId = new Map<string, string>();
  let resourceSequence = 0;
  const calls: string[] = [];

  const tx = {
    machine: {
      findUnique: async () => ({
        moderationStatus: ModerationStatus.CLEAR,
        operational: MachineOperational.AVAILABLE,
        nvidiaRuntimeAvailable: true,
        virtualizationAvailable: true,
        lastCudaProbeOk: true,
        verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
        ...machineOverrides,
      }),
    },
    accelerator: {
      upsert: async (args: any) => {
        const hardwareUuid = String(args.where.machineId_hardwareUuid.hardwareUuid);
        let accelerator = acceleratorsByUuid.get(hardwareUuid);
        if (!accelerator) {
          acceleratorSequence += 1;
          accelerator = {
            id: `accelerator_${acceleratorSequence.toString().padStart(8, '0')}`,
            hardwareUuid,
            status: args.create.status,
          };
          acceleratorsByUuid.set(hardwareUuid, accelerator);
          calls.push(`accelerator.create:${hardwareUuid}`);
        } else {
          accelerator.status = args.update.status;
          calls.push(`accelerator.update:${hardwareUuid}`);
        }
        return { id: accelerator.id };
      },
      updateMany: async (args: any) => {
        const excluded: string[] = args.where.id?.notIn ?? [];
        let count = 0;
        for (const accelerator of acceleratorsByUuid.values()) {
          if (excluded.includes(accelerator.id)) continue;
          if (accelerator.status === AcceleratorOperationalStatus.QUARANTINED) continue;
          accelerator.status = AcceleratorOperationalStatus.MISSING;
          count += 1;
          calls.push(`accelerator.markMissing:${accelerator.hardwareUuid}`);
        }
        return { count };
      },
    },
    miningResource: {
      findUnique: async (args: any) => {
        const acceleratorId = String(args.where.acceleratorId);
        const id = resourcesByAcceleratorId.get(acceleratorId);
        return id ? { id } : null;
      },
      update: async (args: any) => {
        const resource = resourcesById.get(String(args.where.id))!;
        resource.resourceKey = args.data.resourceKey ?? resource.resourceKey;
        resource.enabled = args.data.enabled ?? resource.enabled;
        resource.lastSeenAt = args.data.lastSeenAt ?? resource.lastSeenAt;
        calls.push(`resource.update:${resource.id}`);
        return { id: resource.id };
      },
      upsert: async (args: any) => {
        const acceleratorId = String(args.create.acceleratorId);
        const existingId = resourcesByAcceleratorId.get(acceleratorId);
        if (existingId) {
          const resource = resourcesById.get(existingId)!;
          resource.enabled = true;
          resource.lastSeenAt = args.update.lastSeenAt ?? resource.lastSeenAt;
          calls.push(`resource.upsert.update:${resource.id}`);
          return { id: resource.id };
        }
        resourceSequence += 1;
        const resource: FakeResource = {
          id: `resource_${resourceSequence.toString().padStart(8, '0')}`,
          acceleratorId,
          resourceKey: String(args.create.resourceKey),
          enabled: true,
          lastSeenAt: args.create.lastSeenAt,
        };
        resourcesById.set(resource.id, resource);
        resourcesByAcceleratorId.set(acceleratorId, resource.id);
        calls.push(`resource.upsert.create:${resource.id}`);
        return { id: resource.id };
      },
      updateMany: async (args: any) => {
        const notIn: string[] = args.where.resourceKey?.notIn ?? [];
        let count = 0;
        for (const resource of resourcesById.values()) {
          if (notIn.includes(resource.resourceKey)) continue;
          if (!resource.enabled) continue;
          resource.enabled = false;
          count += 1;
          calls.push(`resource.disable:${resource.id}`);
        }
        return { count };
      },
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    acceleratorsByUuid,
    resourcesById,
    resourcesByAcceleratorId,
    calls,
  };
}

test('a fresh heartbeat repairs a missing Accelerator -> MiningResource mapping', async () => {
  const fake = fakeTransaction();
  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa')]);

  const accelerator = fake.acceleratorsByUuid.get('GPU-aaaaaaaa');
  assert.ok(accelerator, 'accelerator row must be created from heartbeat telemetry');
  const resourceId = fake.resourcesByAcceleratorId.get(accelerator!.id);
  assert.ok(resourceId, 'MiningResource must exist for the accelerator (the rental_gpu_resource_mapping_missing regression)');
  const resource = fake.resourcesById.get(resourceId!)!;
  assert.equal(resource.enabled, true);
  assert.equal(resource.resourceKey, gpuMiningResourceKey(MACHINE_ID, 'GPU-aaaaaaaa'));
});

test('a slot/BIOS reorder keeps the same MiningResource identity per hardware UUID', async () => {
  const fake = fakeTransaction();
  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa'), gpu('GPU-bbbbbbbb')]);
  const acceleratorA = fake.acceleratorsByUuid.get('GPU-aaaaaaaa')!;
  const acceleratorB = fake.acceleratorsByUuid.get('GPU-bbbbbbbb')!;
  const resourceIdA = fake.resourcesByAcceleratorId.get(acceleratorA.id);
  const resourceIdB = fake.resourcesByAcceleratorId.get(acceleratorB.id);

  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-bbbbbbbb'), gpu('GPU-aaaaaaaa')]);

  assert.equal(fake.acceleratorsByUuid.get('GPU-aaaaaaaa')!.id, acceleratorA.id);
  assert.equal(fake.acceleratorsByUuid.get('GPU-bbbbbbbb')!.id, acceleratorB.id);
  assert.equal(fake.resourcesByAcceleratorId.get(acceleratorA.id), resourceIdA);
  assert.equal(fake.resourcesByAcceleratorId.get(acceleratorB.id), resourceIdB);
});

test('a GPU that stops reporting is disabled as a resource and marked missing, not left dangling', async () => {
  const fake = fakeTransaction();
  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa'), gpu('GPU-bbbbbbbb')]);
  const acceleratorB = fake.acceleratorsByUuid.get('GPU-bbbbbbbb')!;
  const resourceIdB = fake.resourcesByAcceleratorId.get(acceleratorB.id)!;

  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa')]);

  assert.equal(fake.acceleratorsByUuid.get('GPU-bbbbbbbb')!.status, AcceleratorOperationalStatus.MISSING);
  assert.equal(fake.resourcesById.get(resourceIdB)!.enabled, false);
});

test('a quarantined accelerator that stops reporting is never overwritten back to MISSING', async () => {
  const fake = fakeTransaction();
  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa'), gpu('GPU-bbbbbbbb')]);
  fake.acceleratorsByUuid.get('GPU-bbbbbbbb')!.status = AcceleratorOperationalStatus.QUARANTINED;

  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa')]);

  assert.equal(fake.acceleratorsByUuid.get('GPU-bbbbbbbb')!.status, AcceleratorOperationalStatus.QUARANTINED);
});

test('a machine-level quarantine overrides GPU availability when syncing accelerator status', async () => {
  const fake = fakeTransaction({ moderationStatus: ModerationStatus.QUARANTINED });
  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa', { available: true })]);

  assert.equal(fake.acceleratorsByUuid.get('GPU-aaaaaaaa')!.status, AcceleratorOperationalStatus.QUARANTINED);
});

test('a repeated heartbeat for the same GPU refreshes the existing resource instead of duplicating it', async () => {
  const fake = fakeTransaction();
  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa')]);
  const acceleratorA = fake.acceleratorsByUuid.get('GPU-aaaaaaaa')!;
  const firstResourceId = fake.resourcesByAcceleratorId.get(acceleratorA.id);

  await syncGpuMiningResourcesFromAccelerators(fake.tx, MACHINE_ID, [gpu('GPU-aaaaaaaa')]);

  assert.equal(fake.resourcesByAcceleratorId.get(acceleratorA.id), firstResourceId);
  assert.equal(fake.resourcesById.size, 1);
  assert.equal(fake.resourcesById.get(firstResourceId!)!.enabled, true);
});
