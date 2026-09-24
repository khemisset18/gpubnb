import { z } from 'zod';

export const MINING_TELEMETRY_LIVE_TTL_SECONDS = 90;
export const MINING_TELEMETRY_DEDUPE_TTL_SECONDS = 300;
export const MINING_TELEMETRY_HISTORY_INTERVAL_MS = 5 * 60 * 1000;
export const MINING_TELEMETRY_HISTORY_HOURS = 24;
const MAX_SIGNED_I64 = 9_223_372_036_854_775_807n;

const fencingTokenSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).superRefine((value, context) => {
  if (BigInt(value) > MAX_SIGNED_I64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'mining_telemetry_runtime_generation_out_of_range',
    });
  }
});

export const miningTelemetrySchema = z.object({
  resourceId: z.string().min(3).max(128),
  hardwareUuid: z.string().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
  runtimeGeneration: fencingTokenSchema,
  profileId: z.string().min(3).max(96).regex(/^[A-Za-z0-9_.:-]+$/).nullable(),
  processPid: z.number().int().positive().max(2_147_483_647).nullable(),
  temperatureC: z.number().finite().min(0).max(150),
  powerWatts: z.number().finite().min(0).max(5000).nullable(),
  gpuUtilizationPercent: z.number().finite().min(0).max(100).nullable(),
  memoryUsedMiB: z.number().finite().min(0).max(1_000_000).nullable(),
  deviceName: z.string().max(200).nullable(),
  thermalStopCelsius: z.number().int().min(85).max(98),
  hashrate: z.number().finite().min(0).max(1e18).nullable(),
  hashrateUnit: z.string().min(1).max(16).regex(/^[A-Za-z0-9/._-]+$/).nullable(),
  acceptedShares: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  staleShares: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  hardwareErrors: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  uptimeSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  poolConnected: z.boolean(),
}).strict();

export const miningTelemetryEnvelopeSchema = z.object({
  machineId: z.string().cuid(),
  resourceId: z.string().min(3).max(128),
  idempotencyKey: z.string().min(16).max(160),
  agentCounter: z.coerce.bigint().positive().max(MAX_SIGNED_I64),
  capturedAt: z.string().datetime(),
  telemetry: miningTelemetrySchema,
}).strict().superRefine((value, context) => {
  if (value.telemetry.resourceId !== value.resourceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['telemetry', 'resourceId'],
      message: 'mining_telemetry_resource_mismatch',
    });
  }
});

export const miningTelemetryLatestKey = (resourceId: string): string =>
  `mining:telemetry:latest:${resourceId}`;

export function validateMiningTelemetryAuthority(
  runtimeState: string,
  leaseFencingToken: string | null,
  runtimeGeneration: string,
): void {
  if (runtimeState !== 'MINING') {
    throw new Error('mining_resource_not_mining');
  }
  if (!leaseFencingToken) {
    throw new Error('mining_resource_lease_missing');
  }
  if (leaseFencingToken !== runtimeGeneration) {
    throw new Error('mining_runtime_generation_stale');
  }
}
