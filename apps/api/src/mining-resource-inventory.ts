import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AcceleratorTelemetry } from './accelerator-telemetry.js';

export type MiningInventory = {
  system: {
    cpu: string;
    cpuCount?: number | null;
  };
  gpus: Array<{
    gpuUuid: string;
    gpuModel: string;
    vramMiB: number;
    driverVersion: string;
    cudaVersion?: string | null;
    gpuVendor?: string | null;
  }>;
};

type TransactionClient = Prisma.TransactionClient;

/**
 * Slot indexes are observation metadata, not identity. A driver/BIOS/PCI reorder
 * must never move an owner's MiningConfiguration from one physical GPU to another.
 */
export const gpuMiningResourceKey = (machineId: string, hardwareUuid: string): string =>
  `gpu:${machineId}:uuid:${hardwareUuid}`;

export const syncGpuMiningResourcesFromAccelerators = async (
  tx: TransactionClient,
  machineId: string,
  accelerators: readonly AcceleratorTelemetry[],
): Promise<void> => {
  const activeKeys: string[] = [];
  const gpus = accelerators.filter((item) => item.kind === 'GPU');

  for (const [index, gpu] of gpus.entries()) {
    const accelerator = await tx.accelerator.upsert({
      where: { machineId_hardwareUuid: { machineId, hardwareUuid: gpu.deviceId } },
      create: {
        machineId,
        hardwareUuid: gpu.deviceId,
        slotIndex: index,
        vendor: gpu.vendor,
        model: gpu.model,
        vramMiB: gpu.memoryTotalMiB ?? 0,
        driverVersion: gpu.driverVersion ?? '',
        cudaVersion: gpu.runtimeVersion ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        slotIndex: index,
        vendor: gpu.vendor,
        model: gpu.model,
        vramMiB: gpu.memoryTotalMiB ?? 0,
        driverVersion: gpu.driverVersion ?? '',
        cudaVersion: gpu.runtimeVersion ?? null,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    const resourceKey = gpuMiningResourceKey(machineId, gpu.deviceId);
    activeKeys.push(resourceKey);

    const existing = await tx.miningResource.findUnique({
      where: { acceleratorId: accelerator.id },
      select: { id: true },
    });

    if (existing) {
      await tx.miningResource.update({
        where: { id: existing.id },
        data: {
          resourceKey,
          displayName: gpu.model,
          acceleratorId: accelerator.id,
          enabled: true,
          lastSeenAt: new Date(),
        },
      });
    } else {
      await tx.miningResource.upsert({
        where: { machineId_resourceKey: { machineId, resourceKey } },
        create: {
          id: crypto.randomUUID(),
          machineId,
          kind: 'GPU',
          resourceKey,
          displayName: gpu.model,
          acceleratorId: accelerator.id,
          enabled: true,
          quarantined: false,
          lastSeenAt: new Date(),
        },
        update: {
          displayName: gpu.model,
          acceleratorId: accelerator.id,
          enabled: true,
          lastSeenAt: new Date(),
        },
      });
    }
  }

  await tx.miningResource.updateMany({
    where: {
      machineId,
      kind: 'GPU',
      ...(activeKeys.length ? { resourceKey: { notIn: activeKeys } } : {}),
    },
    data: { enabled: false },
  });
};

const syncWithTransaction = async (
  tx: TransactionClient,
  machineId: string,
  inventory: MiningInventory,
): Promise<void> => {
  const activeKeys: string[] = [];

  if ((inventory.system.cpuCount ?? 0) > 0) {
    const resourceKey = `cpu:${machineId}:package_0`;
    activeKeys.push(resourceKey);
    await tx.miningResource.upsert({
      where: { machineId_resourceKey: { machineId, resourceKey } },
      create: {
        id: crypto.randomUUID(),
        machineId,
        kind: 'CPU',
        resourceKey,
        displayName: inventory.system.cpu || 'CPU package 0',
        cpuPackageIndex: 0,
        cpuLogicalCores: inventory.system.cpuCount ?? null,
        enabled: true,
        quarantined: false,
        lastSeenAt: new Date(),
      },
      update: {
        displayName: inventory.system.cpu || 'CPU package 0',
        cpuLogicalCores: inventory.system.cpuCount ?? null,
        enabled: true,
        lastSeenAt: new Date(),
      },
    });
  }

  for (const [index, gpu] of inventory.gpus.entries()) {
    const accelerator = await tx.accelerator.upsert({
      where: { machineId_hardwareUuid: { machineId, hardwareUuid: gpu.gpuUuid } },
      create: {
        machineId,
        hardwareUuid: gpu.gpuUuid,
        slotIndex: index,
        vendor: gpu.gpuVendor ?? null,
        model: gpu.gpuModel,
        vramMiB: gpu.vramMiB,
        driverVersion: gpu.driverVersion,
        cudaVersion: gpu.cudaVersion ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        slotIndex: index,
        vendor: gpu.gpuVendor ?? null,
        model: gpu.gpuModel,
        vramMiB: gpu.vramMiB,
        driverVersion: gpu.driverVersion,
        cudaVersion: gpu.cudaVersion ?? null,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    const resourceKey = gpuMiningResourceKey(machineId, gpu.gpuUuid);
    activeKeys.push(resourceKey);

    // `acceleratorId` is unique. Prefer it over the historical slot-based key so
    // an existing resource keeps its primary key, configuration, events and audit
    // history while its key is migrated to stable hardware identity.
    const existing = await tx.miningResource.findUnique({
      where: { acceleratorId: accelerator.id },
      select: { id: true },
    });
    if (existing) {
      await tx.miningResource.update({
        where: { id: existing.id },
        data: {
          resourceKey,
          displayName: gpu.gpuModel,
          acceleratorId: accelerator.id,
          enabled: true,
          lastSeenAt: new Date(),
        },
      });
    } else {
      await tx.miningResource.upsert({
        where: { machineId_resourceKey: { machineId, resourceKey } },
        create: {
          id: crypto.randomUUID(),
          machineId,
          kind: 'GPU',
          resourceKey,
          displayName: gpu.gpuModel,
          acceleratorId: accelerator.id,
          enabled: true,
          quarantined: false,
          lastSeenAt: new Date(),
        },
        update: {
          displayName: gpu.gpuModel,
          acceleratorId: accelerator.id,
          enabled: true,
          lastSeenAt: new Date(),
        },
      });
    }
  }

  await tx.miningResource.updateMany({
    where: {
      machineId,
      ...(activeKeys.length ? { resourceKey: { notIn: activeKeys } } : {}),
    },
    data: { enabled: false },
  });
};

export const syncMiningResourcesFromInventory = async (
  db: PrismaClient,
  machineId: string,
  inventory: MiningInventory,
): Promise<void> => {
  await db.$transaction((tx) => syncWithTransaction(tx, machineId, inventory));
};
