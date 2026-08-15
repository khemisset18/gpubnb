import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';

import { gpuMiningResourceKey, syncMiningResourcesFromInventory } from '../src/mining-resource-inventory.js';

test('GPU resource key is based on stable hardware UUID, never slot index', () => {
  assert.equal(
    gpuMiningResourceKey('machine_00000001', 'GPU-aaaaaaaa'),
    'gpu:machine_00000001:uuid:GPU-aaaaaaaa',
  );
});

test('inventory reorder updates the same MiningResource ids', async () => {
  const acceleratorIds = new Map<string, string>();
  const resourceByAccelerator = new Map<string, { id: string; resourceKey: string }>();
  const updates: Array<{ id: string; resourceKey: string }> = [];
  let resourceSequence = 0;

  const tx = {
    accelerator: {
      upsert: async (args: any) => {
        const uuid = String(args.where.machineId_hardwareUuid.hardwareUuid);
        const id = acceleratorIds.get(uuid) ?? `accelerator_${uuid.slice(-8)}`;
        acceleratorIds.set(uuid, id);
        return { id };
      },
    },
    miningResource: {
      findUnique: async (args: any) => resourceByAccelerator.get(String(args.where.acceleratorId)) ?? null,
      update: async (args: any) => {
        const id = String(args.where.id);
        const resourceKey = String(args.data.resourceKey);
        updates.push({ id, resourceKey });
        for (const [acceleratorId, value] of resourceByAccelerator) {
          if (value.id === id) resourceByAccelerator.set(acceleratorId, { id, resourceKey });
        }
        return { id };
      },
      upsert: async (args: any) => {
        const acceleratorId = String(args.create.acceleratorId);
        const existing = resourceByAccelerator.get(acceleratorId);
        if (existing) return existing;
        resourceSequence += 1;
        const value = { id: `resource_${resourceSequence.toString().padStart(8, '0')}`, resourceKey: String(args.create.resourceKey) };
        resourceByAccelerator.set(acceleratorId, value);
        return value;
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const db = {
    $transaction: async (callback: (client: typeof tx) => Promise<void>) => callback(tx),
  } as unknown as PrismaClient;

  const gpuA = { gpuUuid: 'GPU-aaaaaaaa', gpuModel: 'A', vramMiB: 24000, driverVersion: '1', gpuVendor: 'NVIDIA' };
  const gpuB = { gpuUuid: 'GPU-bbbbbbbb', gpuModel: 'B', vramMiB: 24000, driverVersion: '1', gpuVendor: 'NVIDIA' };

  await syncMiningResourcesFromInventory(db, 'machine_00000001', { system: { cpu: '', cpuCount: 0 }, gpus: [gpuA, gpuB] });
  const firstA = resourceByAccelerator.get('accelerator_aaaaaaaa')!;
  const firstB = resourceByAccelerator.get('accelerator_bbbbbbbb')!;

  await syncMiningResourcesFromInventory(db, 'machine_00000001', { system: { cpu: '', cpuCount: 0 }, gpus: [gpuB, gpuA] });

  assert.equal(resourceByAccelerator.get('accelerator_aaaaaaaa')!.id, firstA.id);
  assert.equal(resourceByAccelerator.get('accelerator_bbbbbbbb')!.id, firstB.id);
  assert.equal(resourceByAccelerator.get('accelerator_aaaaaaaa')!.resourceKey, 'gpu:machine_00000001:uuid:GPU-aaaaaaaa');
  assert.equal(resourceByAccelerator.get('accelerator_bbbbbbbb')!.resourceKey, 'gpu:machine_00000001:uuid:GPU-bbbbbbbb');
  assert.equal(updates.length, 2);
});
