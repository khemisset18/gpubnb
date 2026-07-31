import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

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

    const resourceKey = `gpu:${machineId}:${index}`;
    activeKeys.push(resourceKey);
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
