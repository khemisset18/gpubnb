import type { Redis } from 'ioredis';

import { WINDOWS_NATIVE_GPU_UUID_RE } from './windows-native-capability.js';
import { validateWindowsNativeCapability } from './windows-native-capability.js';

export const CONSOLE_PROOF_TTL_SECONDS = 90;
const MAX_MEASUREMENT_AGE_MS = 60_000;
const ALLOWED_FUTURE_SKEW_MS = 5_000;

export type SignedConsoleProof = {
  schemaVersion: 1;
  captureBackend: 'console-dedicated';
  available: boolean;
  gpuUuid: string | null;
  agentCommit: string;
  helperVersion: string | null;
  hardwareEncoder: 'nvenc' | null;
  measuredAt: string;
};

/**
 * No trust is assigned to this JSON until the caller has verified the v2
 * signature over the entire raw heartbeat body and the one-use challenge.
 */
export function verifiedConsoleProof(
  proof: SignedConsoleProof | undefined,
  context: {
    approvedCommit: string | null;
    operatingSystem: string | null | undefined;
    primaryGpuUuid: string;
    accelerators: unknown;
    nowMs?: number;
  },
): { gpuUuid: string; agentCommit: string } | null {
  const now = context.nowMs ?? Date.now();
  if (!proof || context.approvedCommit === null || proof.available !== true) return null;
  if (
    proof.schemaVersion !== 1
    || proof.captureBackend !== 'console-dedicated'
    || proof.agentCommit !== context.approvedCommit
    || proof.hardwareEncoder !== 'nvenc'
    || typeof proof.helperVersion !== 'string'
    || proof.helperVersion.length < 1
    || !proof.gpuUuid
    || !WINDOWS_NATIVE_GPU_UUID_RE.test(proof.gpuUuid)
    || proof.gpuUuid.toLowerCase() !== context.primaryGpuUuid.toLowerCase()
    || !Number.isFinite(Date.parse(proof.measuredAt))
  ) return null;
  const age = now - Date.parse(proof.measuredAt);
  if (age < -ALLOWED_FUTURE_SKEW_MS || age > MAX_MEASUREMENT_AGE_MS) return null;
  const capability = validateWindowsNativeCapability({
    operatingSystem: context.operatingSystem,
    available: true,
    gpuUuid: proof.gpuUuid,
    rawAccelerators: context.accelerators,
  });
  if (!capability.ok || !capability.available) return null;
  return { gpuUuid: capability.gpuUuid, agentCommit: proof.agentCommit };
}

function proofKey(machineId: string): string {
  return `private-console-proof:v1:${machineId}`;
}

/** Store only a fresh validated claim; never resurrect a revoked or failed one. */
export async function replaceConsoleProof(
  redis: Redis,
  machineId: string,
  proof: { gpuUuid: string; agentCommit: string } | null,
): Promise<void> {
  if (proof === null) {
    await redis.del(proofKey(machineId));
    return;
  }
  await redis.set(proofKey(machineId), JSON.stringify(proof), 'EX', CONSOLE_PROOF_TTL_SECONDS);
}

/** An old claim from a different release or GPU is never usable. */
export async function readConsoleProof(
  redis: Redis,
  machineId: string,
  approvedCommit: string | null,
): Promise<{ gpuUuid: string; agentCommit: string } | null> {
  if (approvedCommit === null) return null;
  const raw = await redis.get(proofKey(machineId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const x = parsed as Record<string, unknown>;
    if (
      x.agentCommit !== approvedCommit
      || typeof x.gpuUuid !== 'string'
      || !WINDOWS_NATIVE_GPU_UUID_RE.test(x.gpuUuid)
    ) return null;
    return { agentCommit: approvedCommit, gpuUuid: x.gpuUuid };
  } catch {
    return null;
  }
}

/** Prefer the distinct signed console claim; never forge the legacy IddCx boolean. */
export async function qualificationNativeSource(
  redis: Redis,
  machineId: string,
  approvedCommit: string | null,
  legacyAvailable: boolean,
  legacyGpuUuid: string | null,
): Promise<{ gpuUuid: string; captureBackend: 'console-dedicated' | 'iddcx' } | null> {
  const console = await readConsoleProof(redis, machineId, approvedCommit);
  if (console) return { gpuUuid: console.gpuUuid, captureBackend: 'console-dedicated' };
  if (legacyAvailable && legacyGpuUuid && WINDOWS_NATIVE_GPU_UUID_RE.test(legacyGpuUuid)) {
    return { gpuUuid: legacyGpuUuid, captureBackend: 'iddcx' };
  }
  return null;
}
