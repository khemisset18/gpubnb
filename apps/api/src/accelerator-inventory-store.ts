import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeAcceleratorTelemetry, type AcceleratorTelemetry } from './accelerator-telemetry.js';

type SqlClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export type InventorySyncResult = {
  added: number;
  updated: number;
  removed: number;
  securityChanges: number;
};

type ExistingAccelerator = {
  id: string;
  kind: string;
  vendor: string;
  deviceId: string;
  fingerprint: string;
  removedAt: Date | null;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

export const acceleratorFingerprint = (item: AcceleratorTelemetry): string => {
  const identity = {
    kind: item.kind,
    vendor: item.vendor,
    model: item.model,
    deviceId: item.deviceId,
    busAddress: item.busAddress ?? null,
    driverVersion: item.driverVersion ?? null,
    runtimeVersion: item.runtimeVersion ?? null,
    memoryTotalMiB: item.memoryTotalMiB ?? null,
    capabilities: item.capabilities,
  };
  return crypto.createHash('sha256').update(stableJson(identity)).digest('hex');
};

const idFor = (machineId: string, item: AcceleratorTelemetry): string => {
  const digest = crypto
    .createHash('sha256')
    .update(`${machineId}\u0000${item.kind}\u0000${item.vendor}\u0000${item.deviceId}`)
    .digest('hex');
  return `acc_${digest.slice(0, 24)}`;
};

const eventId = (): string => `ace_${crypto.randomBytes(16).toString('hex')}`;

export async function syncMachineAccelerators(
  db: SqlClient,
  machineId: string,
  rawAccelerators: unknown,
  now = new Date(),
): Promise<InventorySyncResult> {
  const accelerators = normalizeAcceleratorTelemetry(rawAccelerators);
  const existing = await db.$queryRaw<ExistingAccelerator[]>`
    SELECT "id", "kind", "vendor", "deviceId", "fingerprint", "removedAt"
    FROM "MachineAccelerator"
    WHERE "machineId" = ${machineId}
    FOR UPDATE
  `;

  const byKey = new Map(existing.map((row) => [`${row.kind}\u0000${row.vendor}\u0000${row.deviceId}`, row]));
  const seen = new Set<string>();
  const result: InventorySyncResult = { added: 0, updated: 0, removed: 0, securityChanges: 0 };

  for (const item of accelerators) {
    const key = `${item.kind}\u0000${item.vendor}\u0000${item.deviceId}`;
    const current = byKey.get(key);
    const fingerprint = acceleratorFingerprint(item);
    seen.add(key);

    if (!current) {
      const acceleratorId = idFor(machineId, item);
      await db.$executeRaw`
        INSERT INTO "MachineAccelerator" (
          "id", "machineId", "kind", "vendor", "model", "deviceId", "busAddress",
          "driverVersion", "runtimeVersion", "memoryTotalMiB", "memoryUsedMiB",
          "utilizationPercent", "temperatureC", "powerWatts", "available", "throttling",
          "capabilities", "metrics", "fingerprint", "firstSeenAt", "lastSeenAt", "removedAt"
        ) VALUES (
          ${acceleratorId}, ${machineId}, ${item.kind}, ${item.vendor}, ${item.model}, ${item.deviceId},
          ${item.busAddress ?? null}, ${item.driverVersion ?? null}, ${item.runtimeVersion ?? null},
          ${item.memoryTotalMiB ?? null}, ${item.memoryUsedMiB ?? null}, ${item.utilizationPercent ?? null},
          ${item.temperatureC ?? null}, ${item.powerWatts ?? null}, ${item.available}, ${item.throttling},
          ${JSON.stringify(item.capabilities)}::jsonb, ${JSON.stringify(item.metrics)}::jsonb,
          ${fingerprint}, ${now}, ${now}, NULL
        )
      `;
      await db.$executeRaw`
        INSERT INTO "MachineAcceleratorEvent" (
          "id", "machineId", "acceleratorId", "eventType", "currentFingerprint", "details", "createdAt"
        ) VALUES (${eventId()}, ${machineId}, ${acceleratorId}, 'ADDED', ${fingerprint}, '{}'::jsonb, ${now})
      `;
      result.added += 1;
      continue;
    }

    const identityChanged = current.fingerprint !== fingerprint;
    const eventType = current.removedAt ? 'REAPPEARED' : identityChanged ? 'SECURITY_CHANGE' : 'UPDATED';
    await db.$executeRaw`
      UPDATE "MachineAccelerator"
      SET "model" = ${item.model},
          "busAddress" = ${item.busAddress ?? null},
          "driverVersion" = ${item.driverVersion ?? null},
          "runtimeVersion" = ${item.runtimeVersion ?? null},
          "memoryTotalMiB" = ${item.memoryTotalMiB ?? null},
          "memoryUsedMiB" = ${item.memoryUsedMiB ?? null},
          "utilizationPercent" = ${item.utilizationPercent ?? null},
          "temperatureC" = ${item.temperatureC ?? null},
          "powerWatts" = ${item.powerWatts ?? null},
          "available" = ${item.available},
          "throttling" = ${item.throttling},
          "capabilities" = ${JSON.stringify(item.capabilities)}::jsonb,
          "metrics" = ${JSON.stringify(item.metrics)}::jsonb,
          "fingerprint" = ${fingerprint},
          "lastSeenAt" = ${now},
          "removedAt" = NULL
      WHERE "id" = ${current.id}
    `;

    if (identityChanged || current.removedAt) {
      await db.$executeRaw`
        INSERT INTO "MachineAcceleratorEvent" (
          "id", "machineId", "acceleratorId", "eventType", "previousFingerprint",
          "currentFingerprint", "details", "createdAt"
        ) VALUES (
          ${eventId()}, ${machineId}, ${current.id}, ${eventType}, ${current.fingerprint},
          ${fingerprint}, '{}'::jsonb, ${now}
        )
      `;
    }
    result.updated += 1;
    if (identityChanged) result.securityChanges += 1;
  }

  for (const row of existing) {
    const key = `${row.kind}\u0000${row.vendor}\u0000${row.deviceId}`;
    if (seen.has(key) || row.removedAt) continue;
    await db.$executeRaw`
      UPDATE "MachineAccelerator"
      SET "available" = false, "removedAt" = ${now}, "lastSeenAt" = ${now}
      WHERE "id" = ${row.id}
    `;
    await db.$executeRaw`
      INSERT INTO "MachineAcceleratorEvent" (
        "id", "machineId", "acceleratorId", "eventType", "previousFingerprint", "details", "createdAt"
      ) VALUES (${eventId()}, ${machineId}, ${row.id}, 'REMOVED', ${row.fingerprint}, '{}'::jsonb, ${now})
    `;
    result.removed += 1;
  }

  return result;
}

export async function syncMachineAcceleratorsTransactionally(
  db: PrismaClient,
  machineId: string,
  rawAccelerators: unknown,
): Promise<InventorySyncResult> {
  return db.$transaction(
    (tx: Prisma.TransactionClient) => syncMachineAccelerators(tx as unknown as SqlClient, machineId, rawAccelerators),
    { isolationLevel: 'Serializable' },
  );
}
