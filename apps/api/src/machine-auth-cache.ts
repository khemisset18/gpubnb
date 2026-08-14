import type { Redis } from 'ioredis';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/;
const AGENT_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export const MACHINE_AUTH_CACHE_VERSION = 1;

export function machineAuthCacheKey(machineId: string): string {
  validateId(machineId);
  return `gpubnb:machine-auth:{${machineId}}:v1`;
}

export async function syncMachineAuthCache(
  redis: Redis,
  input: {
    machineId: string;
    agentPublicKey: string;
    keyVersion?: number;
    nowMs?: number;
  },
): Promise<void> {
  validateId(input.machineId);
  validatePublicKey(input.agentPublicKey);
  const keyVersion = input.keyVersion ?? MACHINE_AUTH_CACHE_VERSION;
  if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0 || keyVersion > 2_147_483_647) {
    throw new Error('machine_auth_key_version_invalid');
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('machine_auth_timestamp_invalid');

  await redis.hset(
    machineAuthCacheKey(input.machineId),
    'agentPublicKey', input.agentPublicKey,
    'keyVersion', String(keyVersion),
    'status', 'ACTIVE',
    'updatedAtMs', String(nowMs),
  );
}

export async function revokeMachineAuthCache(
  redis: Redis,
  machineId: string,
  nowMs = Date.now(),
): Promise<void> {
  validateId(machineId);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('machine_auth_timestamp_invalid');
  await redis.hset(
    machineAuthCacheKey(machineId),
    'status', 'REVOKED',
    'updatedAtMs', String(nowMs),
  );
}

function validateId(machineId: string): void {
  if (!SAFE_ID.test(machineId)) throw new Error('machine_auth_machine_id_invalid');
}

function validatePublicKey(publicKey: string): void {
  if (!AGENT_PUBLIC_KEY.test(publicKey)) throw new Error('machine_auth_public_key_invalid');
}
