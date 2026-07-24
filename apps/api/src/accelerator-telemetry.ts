import { z } from 'zod';

const safeKey = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const scalar = z.union([
  z.string().max(500),
  z.number().finite().min(-1e15).max(1e15),
  z.boolean(),
  z.null(),
]);

function boundedRecord(maxKeys: number) {
  return z.record(safeKey, scalar).superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > maxKeys) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `too_many_keys:${maxKeys}` });
    for (const key of keys) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unsafe_key' });
      }
    }
  });
}

export const acceleratorKindSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z][A-Z0-9_-]*$/)
  .transform((value) => value.toUpperCase());

export const acceleratorTelemetrySchema = z.object({
  schemaVersion: z.literal(1),
  kind: acceleratorKindSchema,
  vendor: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
  deviceId: z.string().trim().min(1).max(200),
  busAddress: z.string().trim().max(100).nullable().optional(),
  driverVersion: z.string().trim().max(100).nullable().optional(),
  runtimeVersion: z.string().trim().max(100).nullable().optional(),
  memoryTotalMiB: z.number().int().min(0).max(100_000_000).nullable().optional(),
  memoryUsedMiB: z.number().int().min(0).max(100_000_000).nullable().optional(),
  utilizationPercent: z.number().finite().min(0).max(100).nullable().optional(),
  temperatureC: z.number().finite().min(-273.15).max(300).nullable().optional(),
  powerWatts: z.number().finite().min(0).max(100_000).nullable().optional(),
  available: z.boolean(),
  throttling: z.boolean().default(false),
  capabilities: boundedRecord(64).default({}),
  metrics: boundedRecord(64).default({}),
}).strict().superRefine((value, ctx) => {
  if (value.memoryTotalMiB != null && value.memoryUsedMiB != null && value.memoryUsedMiB > value.memoryTotalMiB) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memoryUsedMiB'], message: 'memory_used_exceeds_total' });
  }
});

export const acceleratorListSchema = z
  .array(acceleratorTelemetrySchema)
  .max(256)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const key = `${item.kind}\u0000${item.vendor.toLowerCase()}\u0000${item.deviceId}`;
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'deviceId'], message: 'duplicate_accelerator' });
      seen.add(key);
    }
  });

export type AcceleratorTelemetry = z.infer<typeof acceleratorTelemetrySchema>;

export function sanitizeAccelerators(input: unknown): AcceleratorTelemetry[] {
  return acceleratorListSchema.parse(input);
}

export function primaryGpu(items: AcceleratorTelemetry[]): AcceleratorTelemetry | null {
  return items.find((item) => item.kind === 'GPU' && item.available) ?? items.find((item) => item.kind === 'GPU') ?? null;
}

export function acceleratorFingerprint(items: AcceleratorTelemetry[]): string {
  return items
    .map((item) => `${item.kind}:${item.vendor.toLowerCase()}:${item.deviceId}`)
    .sort()
    .join('|');
}
