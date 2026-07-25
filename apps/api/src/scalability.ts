import { createHash } from 'node:crypto';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_BATCH_SIZE = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const DEFAULT_SHARD_COUNT = 64;

export const RETENTION_DAYS = Object.freeze({
  heartbeatRaw: 14,
  workspaceMetricRaw: 30,
  usageSampleBilling: 400,
  auditEvent: 730,
});

export type CursorPage = Readonly<{
  limit: number;
  cursor?: string;
}>;

export function normalizeCursorPage(input: {
  limit?: number;
  cursor?: string;
}): CursorPage {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error('invalid_page_size');
  }

  const cursor = input.cursor?.trim();
  if (cursor && (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
    throw new Error('invalid_cursor');
  }

  return cursor ? { limit, cursor } : { limit };
}

export function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (
    key.length < 16 ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    throw new Error('invalid_idempotency_key');
  }
  return key;
}

export function boundedBatchSize(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('invalid_batch_size');
  }
  return Math.min(requested, MAX_BATCH_SIZE);
}

export function stableShardFor(
  tenantOrMachineId: string,
  shardCount = DEFAULT_SHARD_COUNT,
): number {
  if (!tenantOrMachineId || tenantOrMachineId.length > 160) {
    throw new Error('invalid_shard_key');
  }
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 4096) {
    throw new Error('invalid_shard_count');
  }

  const digest = createHash('sha256').update(tenantOrMachineId, 'utf8').digest();
  return digest.readUInt32BE(0) % shardCount;
}

export function assertRetentionPolicy(): void {
  if (
    RETENTION_DAYS.heartbeatRaw >= RETENTION_DAYS.usageSampleBilling ||
    RETENTION_DAYS.workspaceMetricRaw >= RETENTION_DAYS.usageSampleBilling
  ) {
    throw new Error('invalid_retention_policy');
  }
}
