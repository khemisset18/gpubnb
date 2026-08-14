import { randomBytes } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const MACHINE_PRESENCE_PROTOCOL_VERSION = 1;
export const MACHINE_PRESENCE_DEFAULT_TTL_SECONDS = 60;
export const MACHINE_PRESENCE_MIN_TTL_SECONDS = 15;
export const MACHINE_PRESENCE_MAX_TTL_SECONDS = 300;

export type MachinePresencePhase =
  | 'AVAILABLE'
  | 'MINING'
  | 'RESERVED'
  | 'PREPARING'
  | 'RENTED'
  | 'DRAINING'
  | 'QUARANTINED';

export interface MachinePresenceSnapshot {
  protocolVersion: 1;
  machineId: string;
  connectionId: string;
  gatewayId: string;
  region: string;
  sequence: number;
  phase: MachinePresencePhase;
  lastSeenAtMs: number;
  ttlMs: number;
}

export interface MachinePresenceRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  pttl(key: string): Promise<number>;
}

export interface MachinePresenceClaim {
  machineId: string;
  gatewayId: string;
  region: string;
  phase?: MachinePresencePhase;
  ttlSeconds?: number;
  nowMs?: number;
}

export interface MachinePresenceTouch {
  machineId: string;
  connectionId: string;
  sequence: number;
  phase: MachinePresencePhase;
  ttlSeconds?: number;
  nowMs?: number;
}

export type PresenceTouchResult =
  | { accepted: true; sequence: number }
  | { accepted: false; reason: 'STALE_CONNECTION' | 'STALE_SEQUENCE' | 'MISSING'; sequence: number | null };

const CLAIM_SCRIPT = `
redis.call('HSET', KEYS[1],
  'connectionId', ARGV[1],
  'gatewayId', ARGV[2],
  'region', ARGV[3],
  'sequence', '-1',
  'phase', ARGV[4],
  'lastSeenAtMs', ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return 1
`;

const TOUCH_SCRIPT = `
local currentConnection = redis.call('HGET', KEYS[1], 'connectionId')
if not currentConnection then
  return {0, 'MISSING', ''}
end
if currentConnection ~= ARGV[1] then
  local currentSequence = redis.call('HGET', KEYS[1], 'sequence') or ''
  return {0, 'STALE_CONNECTION', currentSequence}
end
local currentSequence = tonumber(redis.call('HGET', KEYS[1], 'sequence') or '-1')
local nextSequence = tonumber(ARGV[2])
if not nextSequence or nextSequence <= currentSequence then
  return {0, 'STALE_SEQUENCE', tostring(currentSequence)}
end
redis.call('HSET', KEYS[1],
  'sequence', ARGV[2],
  'phase', ARGV[3],
  'lastSeenAtMs', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1, 'OK', ARGV[2]}
`;

const RELEASE_SCRIPT = `
local currentConnection = redis.call('HGET', KEYS[1], 'connectionId')
if not currentConnection or currentConnection ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

export function machinePresenceKey(machineId: string): string {
  validateId(machineId, 'machine_id');
  return `gpubnb:machine-presence:{${machineId}}:v1`;
}

export function normalizePresenceTtlSeconds(value = MACHINE_PRESENCE_DEFAULT_TTL_SECONDS): number {
  if (!Number.isSafeInteger(value) || value < MACHINE_PRESENCE_MIN_TTL_SECONDS || value > MACHINE_PRESENCE_MAX_TTL_SECONDS) {
    throw new Error('machine_presence_ttl_invalid');
  }
  return value;
}

export async function claimMachinePresence(
  redis: MachinePresenceRedis,
  input: MachinePresenceClaim,
): Promise<MachinePresenceSnapshot> {
  validateId(input.machineId, 'machine_id');
  validateId(input.gatewayId, 'gateway_id');
  validateRegion(input.region);
  const ttlSeconds = normalizePresenceTtlSeconds(input.ttlSeconds);
  const nowMs = normalizeTimestamp(input.nowMs ?? Date.now());
  const phase = input.phase ?? 'AVAILABLE';
  validatePhase(phase);
  const connectionId = `conn_${randomBytes(18).toString('base64url')}`;

  await redis.eval(
    CLAIM_SCRIPT,
    1,
    machinePresenceKey(input.machineId),
    connectionId,
    input.gatewayId,
    input.region,
    phase,
    String(nowMs),
    String(ttlSeconds * 1000),
  );

  return {
    protocolVersion: MACHINE_PRESENCE_PROTOCOL_VERSION,
    machineId: input.machineId,
    connectionId,
    gatewayId: input.gatewayId,
    region: input.region,
    sequence: -1,
    phase,
    lastSeenAtMs: nowMs,
    ttlMs: ttlSeconds * 1000,
  };
}

export async function touchMachinePresence(
  redis: MachinePresenceRedis,
  input: MachinePresenceTouch,
): Promise<PresenceTouchResult> {
  validateId(input.machineId, 'machine_id');
  validateId(input.connectionId, 'connection_id');
  validatePhase(input.phase);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error('machine_presence_sequence_invalid');
  }
  const ttlSeconds = normalizePresenceTtlSeconds(input.ttlSeconds);
  const nowMs = normalizeTimestamp(input.nowMs ?? Date.now());
  const result = await redis.eval(
    TOUCH_SCRIPT,
    1,
    machinePresenceKey(input.machineId),
    input.connectionId,
    String(input.sequence),
    input.phase,
    String(nowMs),
    String(ttlSeconds * 1000),
  );
  return decodeTouchResult(result);
}

export async function releaseMachinePresence(
  redis: MachinePresenceRedis,
  machineId: string,
  connectionId: string,
): Promise<boolean> {
  validateId(machineId, 'machine_id');
  validateId(connectionId, 'connection_id');
  const result = await redis.eval(RELEASE_SCRIPT, 1, machinePresenceKey(machineId), connectionId);
  return Number(result) === 1;
}

export async function readMachinePresence(
  redis: MachinePresenceRedis,
  machineId: string,
): Promise<MachinePresenceSnapshot | null> {
  const key = machinePresenceKey(machineId);
  const [fields, ttlMs] = await Promise.all([redis.hgetall(key), redis.pttl(key)]);
  if (!fields.connectionId || ttlMs <= 0) return null;

  const gatewayId = requireField(fields, 'gatewayId');
  const region = requireField(fields, 'region');
  const sequence = parseSafeInteger(requireField(fields, 'sequence'), 'machine_presence_sequence_invalid', -1);
  const phase = requireField(fields, 'phase') as MachinePresencePhase;
  const lastSeenAtMs = parseSafeInteger(requireField(fields, 'lastSeenAtMs'), 'machine_presence_timestamp_invalid', 0);
  validateId(fields.connectionId, 'connection_id');
  validateId(gatewayId, 'gateway_id');
  validateRegion(region);
  validatePhase(phase);

  return {
    protocolVersion: MACHINE_PRESENCE_PROTOCOL_VERSION,
    machineId,
    connectionId: fields.connectionId,
    gatewayId,
    region,
    sequence,
    phase,
    lastSeenAtMs,
    ttlMs,
  };
}

function decodeTouchResult(value: unknown): PresenceTouchResult {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('machine_presence_redis_result_invalid');
  }
  const accepted = Number(value[0]) === 1;
  const sequenceText = String(value[2] ?? '');
  const sequence = sequenceText === '' ? null : Number(sequenceText);
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < -1)) {
    throw new Error('machine_presence_redis_sequence_invalid');
  }
  if (accepted) {
    if (sequence === null || sequence < 0) throw new Error('machine_presence_redis_sequence_invalid');
    return { accepted: true, sequence };
  }
  const reason = String(value[1]);
  if (reason !== 'STALE_CONNECTION' && reason !== 'STALE_SEQUENCE' && reason !== 'MISSING') {
    throw new Error('machine_presence_redis_reason_invalid');
  }
  return { accepted: false, reason, sequence };
}

function validateId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field}_invalid`);
}

function validateRegion(value: string): void {
  if (!SAFE_REGION.test(value)) throw new Error('machine_presence_region_invalid');
}

function validatePhase(value: string): asserts value is MachinePresencePhase {
  if (!['AVAILABLE', 'MINING', 'RESERVED', 'PREPARING', 'RENTED', 'DRAINING', 'QUARANTINED'].includes(value)) {
    throw new Error('machine_presence_phase_invalid');
  }
}

function normalizeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('machine_presence_timestamp_invalid');
  return value;
}

function parseSafeInteger(value: string, error: string, minimum: number): number {
  if (!/^-?\d+$/.test(value)) throw new Error(error);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(error);
  return parsed;
}

function requireField(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`machine_presence_${name}_missing`);
  return value;
}
