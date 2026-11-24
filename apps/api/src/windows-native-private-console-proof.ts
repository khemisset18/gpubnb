import type { Redis } from 'ioredis';
import { z } from 'zod';

import { WINDOWS_NATIVE_GPU_UUID_RE } from './windows-native-capability.js';
import { validateWindowsNativeCapability } from './windows-native-capability.js';

export const CONSOLE_PROOF_TTL_SECONDS = 90;
const MAX_MEASUREMENT_AGE_MS = 60_000;
const ALLOWED_FUTURE_SKEW_MS = 5_000;

type ConsoleProofFields = {
  captureBackend: 'console-dedicated';
  available: boolean;
  gpuUuid: string | null;
  agentCommit: string;
  helperVersion: string | null;
  hardwareEncoder: 'nvenc' | null;
  measuredAt: string;
};

export type SignedConsoleProof =
  | (ConsoleProofFields & { schemaVersion: 1 })
  | (ConsoleProofFields & { schemaVersion: 2; workspaceSlug: 'gaming' });

export type ConsoleProofWorkspaceSlug = 'cloud-desktop' | 'gaming';
type StoredConsoleProofScope = ConsoleProofWorkspaceSlug | 'legacy';

const consoleProofSchemaFields = {
  captureBackend: z.literal('console-dedicated'),
  available: z.boolean(),
  gpuUuid: z.string().regex(WINDOWS_NATIVE_GPU_UUID_RE).nullable(),
  agentCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  helperVersion: z.string().min(1).max(100).nullable(),
  hardwareEncoder: z.enum(['nvenc']).nullable(),
  measuredAt: z.string().datetime(),
};

export const signedConsoleProofSchema = z.union([
  z.object({ schemaVersion: z.literal(1), ...consoleProofSchemaFields }),
  z.object({
    schemaVersion: z.literal(2),
    workspaceSlug: z.literal('gaming'),
    ...consoleProofSchemaFields,
  }),
]);

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
): { gpuUuid: string; agentCommit: string; workspaceSlug: StoredConsoleProofScope } | null {
  const now = context.nowMs ?? Date.now();
  if (!proof || context.approvedCommit === null || proof.available !== true) return null;
  if (
    !(proof.schemaVersion === 1 || proof.schemaVersion === 2)
    || (proof.schemaVersion === 2 && proof.workspaceSlug !== 'gaming')
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
  return {
    gpuUuid: capability.gpuUuid,
    agentCommit: proof.agentCommit,
    workspaceSlug: proof.schemaVersion === 2 ? 'gaming' : 'legacy',
  };
}

function proofKey(machineId: string): string {
  return `private-console-proof:v1:${machineId}`;
}

/** Store only a fresh validated claim; never resurrect a revoked or failed one. */
export async function replaceConsoleProof(
  redis: Redis,
  machineId: string,
  proof: {
    gpuUuid: string;
    agentCommit: string;
    workspaceSlug?: StoredConsoleProofScope;
  } | null,
  acceptedCounter: string,
): Promise<void> {
  if (proof === null) {
    await redis.del(proofKey(machineId));
    return;
  }
  await redis.set(proofKey(machineId), JSON.stringify({
    ...proof,
    workspaceSlug: proof.workspaceSlug ?? 'legacy',
    acceptedCounter,
  }), 'EX', CONSOLE_PROOF_TTL_SECONDS);
}

/** An old claim from a different release or GPU is never usable. */
export async function readConsoleProof(
  redis: Redis,
  machineId: string,
  approvedCommit: string | null,
  latestAcceptedCounter: string,
  workspaceSlug: ConsoleProofWorkspaceSlug = 'cloud-desktop',
): Promise<{ gpuUuid: string; agentCommit: string; workspaceSlug: ConsoleProofWorkspaceSlug } | null> {
  if (approvedCommit === null) return null;
  const raw = await redis.get(proofKey(machineId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const x = parsed as Record<string, unknown>;
    if (
      x.agentCommit !== approvedCommit
      || x.acceptedCounter !== latestAcceptedCounter
      || typeof x.gpuUuid !== 'string'
      || !WINDOWS_NATIVE_GPU_UUID_RE.test(x.gpuUuid)
    ) return null;
    // Old operator/CI proofs are unscoped, so preserve them only for their
    // original Cloud Desktop path. They must never authorize Gaming, whose
    // local owner consent is represented by the workspace-scoped schema v2.
    const provedWorkspace = x.workspaceSlug ?? 'legacy';
    if (provedWorkspace !== 'legacy' && provedWorkspace !== 'cloud-desktop' && provedWorkspace !== 'gaming') return null;
    if (provedWorkspace === 'legacy' && workspaceSlug !== 'cloud-desktop') return null;
    if (provedWorkspace !== 'legacy' && provedWorkspace !== workspaceSlug) return null;
    return { agentCommit: approvedCommit, gpuUuid: x.gpuUuid, workspaceSlug };
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
  latestAcceptedCounter: bigint | undefined,
  workspaceSlug: ConsoleProofWorkspaceSlug = 'cloud-desktop',
): Promise<{
  gpuUuid: string;
  captureBackend: 'console-dedicated' | 'iddcx';
  workspaceSlug: ConsoleProofWorkspaceSlug;
} | null> {
  const console = await readConsoleProof(
    redis, machineId, approvedCommit, String(latestAcceptedCounter), workspaceSlug,
  );
  if (console) return { gpuUuid: console.gpuUuid, captureBackend: 'console-dedicated', workspaceSlug };
  if (legacyAvailable && legacyGpuUuid && WINDOWS_NATIVE_GPU_UUID_RE.test(legacyGpuUuid)) {
    return { gpuUuid: legacyGpuUuid, captureBackend: 'iddcx', workspaceSlug: 'cloud-desktop' };
  }
  return null;
}
