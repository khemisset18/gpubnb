import type { PrismaClient } from '@prisma/client';

const PUBLIC_METRIC_KEYS = new Set([
  'computeUnits',
  'coreCount',
  'tensorCoreCount',
  'memoryBandwidthGBps',
  'clockMHz',
]);

const PUBLIC_CAPABILITY_KEYS = new Set([
  'cuda',
  'rocm',
  'opencl',
  'vulkan',
  'directml',
  'metal',
  'fp16',
  'bf16',
  'fp8',
  'int8',
  'virtualization',
]);

function filterRecord(value: unknown, allowed: Set<string>): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      output[key] = item;
    }
  }
  return output;
}

export type PublicAccelerator = {
  kind: string;
  vendor: string;
  model: string;
  memoryTotalMiB: number | null;
  driverVersion: string | null;
  runtimeVersion: string | null;
  available: boolean;
  throttling: boolean;
  utilizationPercent: number | null;
  memoryUsedMiB: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  capabilities: Record<string, string | number | boolean | null>;
  metrics: Record<string, string | number | boolean | null>;
  lastSeenAt: Date;
};

export async function listPublicMachineAccelerators(
  db: PrismaClient,
  machineId: string,
): Promise<PublicAccelerator[]> {
  const rows = await db.$queryRaw<Array<{
    kind: string;
    vendor: string;
    model: string;
    memoryTotalMiB: number | null;
    driverVersion: string | null;
    runtimeVersion: string | null;
    available: boolean;
    throttling: boolean;
    utilizationPercent: number | null;
    memoryUsedMiB: number | null;
    temperatureC: number | null;
    powerWatts: number | null;
    capabilities: unknown;
    metrics: unknown;
    lastSeenAt: Date;
  }>>`
    SELECT
      a."kind", a."vendor", a."model", a."memoryTotalMiB", a."driverVersion",
      a."runtimeVersion", a."available", a."throttling", a."utilizationPercent",
      a."memoryUsedMiB", a."temperatureC", a."powerWatts", a."capabilities",
      a."metrics", a."lastSeenAt"
    FROM "MachineAccelerator" a
    INNER JOIN "Machine" m ON m."id" = a."machineId"
    WHERE a."machineId" = ${machineId}
      AND a."removedAt" IS NULL
      AND m."moderationStatus" = 'CLEAR'
    ORDER BY a."kind" ASC, a."vendor" ASC, a."model" ASC
  `;

  return rows.map((row) => ({
    ...row,
    capabilities: filterRecord(row.capabilities, PUBLIC_CAPABILITY_KEYS),
    metrics: filterRecord(row.metrics, PUBLIC_METRIC_KEYS),
  }));
}

export async function listOwnerMachineAccelerators(
  db: PrismaClient,
  machineId: string,
  ownerId: string,
) {
  return db.$queryRaw<Array<{
    id: string;
    kind: string;
    vendor: string;
    model: string;
    deviceId: string;
    busAddress: string | null;
    driverVersion: string | null;
    runtimeVersion: string | null;
    memoryTotalMiB: number | null;
    memoryUsedMiB: number | null;
    utilizationPercent: number | null;
    temperatureC: number | null;
    powerWatts: number | null;
    available: boolean;
    throttling: boolean;
    capabilities: unknown;
    metrics: unknown;
    firstSeenAt: Date;
    lastSeenAt: Date;
    removedAt: Date | null;
  }>>`
    SELECT
      a."id", a."kind", a."vendor", a."model", a."deviceId", a."busAddress",
      a."driverVersion", a."runtimeVersion", a."memoryTotalMiB", a."memoryUsedMiB",
      a."utilizationPercent", a."temperatureC", a."powerWatts", a."available",
      a."throttling", a."capabilities", a."metrics", a."firstSeenAt",
      a."lastSeenAt", a."removedAt"
    FROM "MachineAccelerator" a
    INNER JOIN "Machine" m ON m."id" = a."machineId"
    WHERE a."machineId" = ${machineId}
      AND m."ownerId" = ${ownerId}
    ORDER BY a."removedAt" NULLS FIRST, a."kind" ASC, a."vendor" ASC, a."model" ASC
  `;
}
