import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

const safeId = z.string().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const nullableFinite = (minimum: number, maximum: number) =>
  z.number().finite().min(minimum).max(maximum).nullable();

export const miningResourceTelemetrySchema = z.object({
  resourceId: safeId,
  hardwareUuid: safeId,
  state: z.enum(['MINING', 'STOPPED', 'QUARANTINED']),
  maximumTemperatureC: z.number().int().min(85).max(98),
  temperatureC: nullableFinite(0, 150),
  powerWatts: nullableFinite(0, 5000),
  utilizationPercent: z.number().int().min(0).max(100).nullable(),
  hashrate: nullableFinite(0, 1_000_000_000_000_000),
  hashrateUnit: z.enum(['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s']).nullable(),
  acceptedShares: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  staleShares: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  hardwareErrors: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  uptimeSeconds: z.number().int().min(0).max(315_360_000).nullable(),
  poolConnected: z.boolean(),
  sampledAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  lastStopReason: z.string().max(96).regex(/^[A-Za-z0-9_.:-]+$/).nullable(),
}).strict();

export const miningResourceTelemetryListSchema = z
  .array(miningResourceTelemetrySchema)
  .max(32);

export type MiningResourceTelemetry = z.infer<typeof miningResourceTelemetrySchema>;

type TelemetrySqlClient = Pick<PrismaClient, '$executeRaw'>;

export const sanitizeMiningResourceTelemetry = (input: unknown): MiningResourceTelemetry[] =>
  miningResourceTelemetryListSchema.parse(input);

export async function syncMiningResourceTelemetry(
  tx: TelemetrySqlClient,
  machineId: string,
  rawTelemetry: unknown,
  receivedAt = new Date(),
): Promise<{ accepted: number; ignored: number }> {
  const telemetry = sanitizeMiningResourceTelemetry(rawTelemetry);
  let accepted = 0;

  for (const item of telemetry) {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "MiningResource" AS r
         SET "lastMiningTelemetry" = ${JSON.stringify(item)}::jsonb,
             "lastMiningTelemetryAt" = ${receivedAt},
             "updatedAt" = CURRENT_TIMESTAMP
        FROM "Accelerator" AS a
       WHERE r."acceleratorId" = a."id"
         AND r."machineId" = ${machineId}
         AND r."id" = ${item.resourceId}
         AND a."machineId" = ${machineId}
         AND a."hardwareUuid" = ${item.hardwareUuid}
    `);
    if (Number(updated) > 0) accepted += 1;
  }

  return { accepted, ignored: telemetry.length - accepted };
}
