import { randomBytes } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,191}$/;

export const RESOURCE_LEASE_PROTOCOL_VERSION = 1;
export const RESOURCE_LEASE_DEFAULT_TTL_SECONDS = 45;
export const RESOURCE_LEASE_MIN_TTL_SECONDS = 15;
export const RESOURCE_LEASE_MAX_TTL_SECONDS = 300;

export interface ResourceLeaseRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  pttl(key: string): Promise<number>;
}

export interface ResourceLeaseSnapshot {
  protocolVersion: 1;
  resourceId: string;
  holderId: string;
  idempotencyKey: string;
  leaseId: string;
  fencingToken: string;
  ttlMs: number;
}

export type AcquireResourceLeaseResult =
  | { status: 'ACQUIRED' | 'EXISTING'; lease: ResourceLeaseSnapshot }
  | { status: 'BUSY'; leaseId: string; fencingToken: string; ttlMs: number };

export type LeaseMutationResult =
  | { accepted: true; ttlMs: number }
  | { accepted: false; reason: 'MISSING' | 'STALE_LEASE' };

const ACQUIRE_SCRIPT = `
local currentLeaseId = redis.call('HGET', KEYS[1], 'leaseId')
if currentLeaseId then
  local currentHolder = redis.call('HGET', KEYS[1], 'holderId') or ''
  local currentIdempotency = redis.call('HGET', KEYS[1], 'idempotencyKey') or ''
  local currentFence = redis.call('HGET', KEYS[1], 'fencingToken') or '0'
  if currentHolder == ARGV[1] and currentIdempotency == ARGV[2] then
    redis.call('PEXPIRE', KEYS[1], ARGV[4])
    return {2, currentLeaseId, currentFence, ARGV[4]}
  end
  return {0, currentLeaseId, currentFence, redis.call('PTTL', KEYS[1])}
end
redis.call('INCR', KEYS[2])
local fencingToken = redis.call('GET', KEYS[2])
redis.call('HSET', KEYS[1],
  'holderId', ARGV[1],
  'idempotencyKey', ARGV[2],
  'leaseId', ARGV[3],
  'fencingToken', fencingToken)
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return {1, ARGV[3], fencingToken, ARGV[4]}
`;

const RENEW_SCRIPT = `
local currentLeaseId = redis.call('HGET', KEYS[1], 'leaseId')
if not currentLeaseId then
  return {0, 'MISSING'}
end
local holder = redis.call('HGET', KEYS[1], 'holderId') or ''
local fence = redis.call('HGET', KEYS[1], 'fencingToken') or ''
if currentLeaseId ~= ARGV[1] or holder ~= ARGV[2] or fence ~= ARGV[3] then
  return {0, 'STALE_LEASE'}
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return {1, ARGV[4]}
`;

const RELEASE_SCRIPT = `
local currentLeaseId = redis.call('HGET', KEYS[1], 'leaseId')
if not currentLeaseId then
  return {0, 'MISSING'}
end
local holder = redis.call('HGET', KEYS[1], 'holderId') or ''
local fence = redis.call('HGET', KEYS[1], 'fencingToken') or ''
if currentLeaseId ~= ARGV[1] or holder ~= ARGV[2] or fence ~= ARGV[3] then
  return {0, 'STALE_LEASE'}
end
redis.call('DEL', KEYS[1])
return {1, '0'}
`;

export function resourceLeaseKey(resourceId: string): string {
  validateId(resourceId, 'resource_id');
  return `gpubnb:resource-lease:{${resourceId}}:v1`;
}

export function resourceFenceKey(resourceId: string): string {
  validateId(resourceId, 'resource_id');
  return `gpubnb:resource-fence:{${resourceId}}:v1`;
}

export function redisHashTag(key: string): string | null {
  const match = key.match(/\{([^{}]+)\}/);
  return match?.[1] ?? null;
}

export function normalizeResourceLeaseTtlSeconds(value = RESOURCE_LEASE_DEFAULT_TTL_SECONDS): number {
  if (!Number.isSafeInteger(value) || value < RESOURCE_LEASE_MIN_TTL_SECONDS || value > RESOURCE_LEASE_MAX_TTL_SECONDS) {
    throw new Error('resource_lease_ttl_invalid');
  }
  return value;
}

export async function acquireResourceLease(
  redis: ResourceLeaseRedis,
  input: {
    resourceId: string;
    holderId: string;
    idempotencyKey: string;
    ttlSeconds?: number;
  },
): Promise<AcquireResourceLeaseResult> {
  validateId(input.resourceId, 'resource_id');
  validateId(input.holderId, 'holder_id');
  validateId(input.idempotencyKey, 'idempotency_key');
  const ttlMs = normalizeResourceLeaseTtlSeconds(input.ttlSeconds) * 1000;
  const leaseId = `lease_${randomBytes(18).toString('base64url')}`;
  const leaseKey = resourceLeaseKey(input.resourceId);
  const fenceKey = resourceFenceKey(input.resourceId);
  if (redisHashTag(leaseKey) !== redisHashTag(fenceKey)) throw new Error('resource_lease_cross_slot_keys');

  const raw = await redis.eval(
    ACQUIRE_SCRIPT,
    2,
    leaseKey,
    fenceKey,
    input.holderId,
    input.idempotencyKey,
    leaseId,
    String(ttlMs),
  );
  const result = decodeArray(raw, 4, 'resource_lease_acquire_result_invalid');
  const code = Number(result[0]);
  const returnedLeaseId = String(result[1] ?? '');
  const fencingToken = normalizeFencingToken(String(result[2] ?? ''));
  const returnedTtlMs = normalizeTtlMs(result[3]);

  if (code === 0) {
    return { status: 'BUSY', leaseId: returnedLeaseId, fencingToken, ttlMs: returnedTtlMs };
  }
  if (code !== 1 && code !== 2) throw new Error('resource_lease_acquire_code_invalid');
  validateId(returnedLeaseId, 'lease_id');
  return {
    status: code === 1 ? 'ACQUIRED' : 'EXISTING',
    lease: {
      protocolVersion: RESOURCE_LEASE_PROTOCOL_VERSION,
      resourceId: input.resourceId,
      holderId: input.holderId,
      idempotencyKey: input.idempotencyKey,
      leaseId: returnedLeaseId,
      fencingToken,
      ttlMs: returnedTtlMs,
    },
  };
}

export async function renewResourceLease(
  redis: ResourceLeaseRedis,
  input: {
    resourceId: string;
    holderId: string;
    leaseId: string;
    fencingToken: string;
    ttlSeconds?: number;
  },
): Promise<LeaseMutationResult> {
  validateLeaseIdentity(input);
  const ttlMs = normalizeResourceLeaseTtlSeconds(input.ttlSeconds) * 1000;
  const raw = await redis.eval(
    RENEW_SCRIPT,
    1,
    resourceLeaseKey(input.resourceId),
    input.leaseId,
    input.holderId,
    normalizeFencingToken(input.fencingToken),
    String(ttlMs),
  );
  return decodeMutation(raw, ttlMs);
}

export async function releaseResourceLease(
  redis: ResourceLeaseRedis,
  input: {
    resourceId: string;
    holderId: string;
    leaseId: string;
    fencingToken: string;
  },
): Promise<LeaseMutationResult> {
  validateLeaseIdentity(input);
  const raw = await redis.eval(
    RELEASE_SCRIPT,
    1,
    resourceLeaseKey(input.resourceId),
    input.leaseId,
    input.holderId,
    normalizeFencingToken(input.fencingToken),
  );
  return decodeMutation(raw, 0);
}

export async function readResourceLease(
  redis: ResourceLeaseRedis,
  resourceId: string,
): Promise<ResourceLeaseSnapshot | null> {
  const key = resourceLeaseKey(resourceId);
  const [fields, ttlMs] = await Promise.all([redis.hgetall(key), redis.pttl(key)]);
  if (!fields.leaseId || ttlMs <= 0) return null;
  const holderId = requireField(fields, 'holderId');
  const idempotencyKey = requireField(fields, 'idempotencyKey');
  const fencingToken = normalizeFencingToken(requireField(fields, 'fencingToken'));
  validateId(fields.leaseId, 'lease_id');
  validateId(holderId, 'holder_id');
  validateId(idempotencyKey, 'idempotency_key');
  return {
    protocolVersion: RESOURCE_LEASE_PROTOCOL_VERSION,
    resourceId,
    holderId,
    idempotencyKey,
    leaseId: fields.leaseId,
    fencingToken,
    ttlMs,
  };
}

function validateLeaseIdentity(input: {
  resourceId: string;
  holderId: string;
  leaseId: string;
  fencingToken: string;
}): void {
  validateId(input.resourceId, 'resource_id');
  validateId(input.holderId, 'holder_id');
  validateId(input.leaseId, 'lease_id');
  normalizeFencingToken(input.fencingToken);
}

function decodeMutation(raw: unknown, acceptedTtlMs: number): LeaseMutationResult {
  const result = decodeArray(raw, 2, 'resource_lease_mutation_result_invalid');
  if (Number(result[0]) === 1) return { accepted: true, ttlMs: acceptedTtlMs };
  const reason = String(result[1]);
  if (reason !== 'MISSING' && reason !== 'STALE_LEASE') {
    throw new Error('resource_lease_mutation_reason_invalid');
  }
  return { accepted: false, reason };
}

function normalizeFencingToken(value: string): string {
  if (!/^[1-9]\d{0,18}$/.test(value)) throw new Error('resource_lease_fencing_token_invalid');
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new Error('resource_lease_fencing_token_invalid');
  return value;
}

function normalizeTtlMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > RESOURCE_LEASE_MAX_TTL_SECONDS * 1000) {
    throw new Error('resource_lease_returned_ttl_invalid');
  }
  return parsed;
}

function validateId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field}_invalid`);
}

function decodeArray(value: unknown, minimumLength: number, error: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimumLength) throw new Error(error);
  return value;
}

function requireField(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`resource_lease_${name}_missing`);
  return value;
}
