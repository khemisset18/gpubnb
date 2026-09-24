import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { enqueueMachineCommand } from './delivery-store.js';
import { buildFencedStartMining, buildFencedStopMining } from './mining-resource-control.js';
import { isMiningProfileApproved, normalizeMiningGpuVendor } from './mining-profile-catalog.js';
import { acquireResourceLease, releaseResourceLease, type ResourceLeaseSnapshot } from './resource-lease.js';
import type { MachineCommandEnvelope } from './reliable-delivery.js';

const MINING_LEASE_TTL_SECONDS = 90;
const MINING_COMMAND_TTL_MS = 60_000;

type MiningCommandKind = 'start_mining' | 'stop_mining';

type MiningCommandCandidate = {
  resourceId: string;
  machineId: string;
  machineModeration: string;
  machineLifecycle: string;
  kind: 'GPU' | 'CPU';
  enabled: boolean;
  quarantined: boolean;
  runtimeState: string;
  activeRentalId: string | null;
  hardwareUuid: string | null;
  gpuVendor: string | null;
  acceleratorModeration: string | null;
  acceleratorStatus: string | null;
  configurationId: string | null;
  mode: string | null;
  profileId: string | null;
  walletAddress: string | null;
  workerName: string | null;
  ownerPoolEndpoint: string | null;
  ownerPoolSecretRef: string | null;
  maximumTemperatureC: number | null;
  maximumPowerWatts: number | null;
  configurationVersion: number | null;
};

type SqlClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

function digest(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function stableCommandId(kind: MiningCommandKind, resourceId: string, fence: string): string {
  return `cmd_${digest('mining', kind, resourceId, fence).slice(0, 32)}`;
}

function stableIdempotencyKey(kind: MiningCommandKind, resourceId: string, fence: string): string {
  return `mining:${kind}:${digest(kind, resourceId, fence).slice(0, 40)}`;
}

async function reserveSequence(tx: SqlClient, machineId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>(Prisma.sql`
    SELECT reserve_machine_sequence(${machineId}) AS "sequence"
  `);
  const sequence = rows[0]?.sequence;
  if (sequence === undefined || sequence < 1n) throw new Error('machine_sequence_reservation_failed');
  return sequence;
}

async function loadCandidate(db: PrismaClient, machineId: string, resourceId: string): Promise<MiningCommandCandidate> {
  const rows = await db.$queryRaw<MiningCommandCandidate[]>(Prisma.sql`
    SELECT r."id" AS "resourceId", r."machineId",
           m."moderationStatus"::text AS "machineModeration",
           m."lifecycleStatus"::text AS "machineLifecycle",
           r."kind"::text AS "kind",
           r."enabled", r."quarantined", r."runtimeState"::text AS "runtimeState",
           r."activeRentalId", a."hardwareUuid", a."vendor" AS "gpuVendor",
           a."moderationStatus"::text AS "acceleratorModeration",
           a."status"::text AS "acceleratorStatus",
           c."id" AS "configurationId", c."mode"::text AS "mode", c."profileId",
           c."walletAddress", c."workerName", c."ownerPoolEndpoint", c."ownerPoolSecretRef",
           c."maximumTemperatureC", c."maximumPowerWatts", c."version" AS "configurationVersion"
      FROM "MiningResource" r
      JOIN "Machine" m ON m."id" = r."machineId"
 LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
 LEFT JOIN "MiningConfiguration" c ON c."resourceId" = r."id"
     WHERE r."id" = ${resourceId} AND r."machineId" = ${machineId}
  `);
  const candidate = rows[0];
  if (!candidate) throw new Error('mining_resource_not_found');
  return candidate;
}

function assertStartCandidate(candidate: MiningCommandCandidate): asserts candidate is MiningCommandCandidate & {
  hardwareUuid: string;
  profileId: string;
  walletAddress: string;
  workerName: string;
  ownerPoolEndpoint: string;
  maximumTemperatureC: number;
  maximumPowerWatts: number;
} {
  if (candidate.kind !== 'GPU') throw new Error('mining_start_gpu_only_v1');
  if (candidate.machineModeration !== 'CLEAR') throw new Error('mining_machine_not_clear');
  if (candidate.machineLifecycle !== 'ACTIVE') throw new Error('mining_machine_not_active');
  if (!candidate.enabled) throw new Error('mining_resource_disabled');
  if (candidate.quarantined) throw new Error('mining_resource_quarantined');
  if (candidate.activeRentalId) throw new Error('mining_resource_rented');
  if (!['IDLE', 'STOPPED'].includes(candidate.runtimeState)) throw new Error('mining_resource_not_startable');
  if (candidate.gpuVendor?.trim().toUpperCase() !== 'NVIDIA') throw new Error('mining_gpu_vendor_not_qualified');
  if (candidate.acceleratorModeration !== 'CLEAR') throw new Error('mining_accelerator_not_clear');
  if (!['AVAILABLE', 'RESERVED'].includes(candidate.acceleratorStatus ?? '')) throw new Error('mining_accelerator_not_available');
  if (candidate.mode !== 'OWNER_POOL') throw new Error('mining_owner_pool_required');
  if (candidate.ownerPoolSecretRef) throw new Error('miner_secret_resolution_required');
  if (!candidate.hardwareUuid || !candidate.profileId || !candidate.walletAddress || !candidate.workerName || !candidate.ownerPoolEndpoint) {
    throw new Error('mining_configuration_incomplete');
  }
  const vendor = normalizeMiningGpuVendor(candidate.gpuVendor);
  if (!isMiningProfileApproved(candidate.profileId, 'GPU', vendor)) {
    throw new Error('mining_profile_not_approved');
  }
  if (candidate.maximumTemperatureC === null || candidate.maximumPowerWatts === null) {
    throw new Error('mining_configuration_limits_missing');
  }
}

function miningLeaseIdentity(resourceId: string): { holderId: string; idempotencyKey: string } {
  const suffix = digest('mining-holder', resourceId).slice(0, 24);
  return {
    holderId: `mining_${suffix}`,
    idempotencyKey: `mining:lease:${suffix}`,
  };
}

async function acquireMiningLease(redis: Redis, resourceId: string): Promise<ResourceLeaseSnapshot> {
  const identity = miningLeaseIdentity(resourceId);
  const result = await acquireResourceLease(redis, {
    resourceId,
    ...identity,
    ttlSeconds: MINING_LEASE_TTL_SECONDS,
  });
  if (result.status === 'BUSY') throw new Error('mining_resource_lease_busy');
  return result.lease;
}

async function persistCommand(
  db: PrismaClient,
  candidate: MiningCommandCandidate,
  lease: ResourceLeaseSnapshot,
  kind: MiningCommandKind,
  inner: { lease: Record<string, string>; payload: Record<string, unknown> },
): Promise<{ commandId: string; sequence: bigint; lease: ResourceLeaseSnapshot }> {
  const commandId = stableCommandId(kind, candidate.resourceId, lease.fencingToken);
  const idempotencyKey = stableIdempotencyKey(kind, candidate.resourceId, lease.fencingToken);
  const expiresAt = new Date(Date.now() + MINING_COMMAND_TTL_MS);
  const sequence = await db.$transaction(async (tx) => {
    const current = await tx.$queryRaw<MiningCommandCandidate[]>(Prisma.sql`
      SELECT r."id" AS "resourceId", r."machineId",
           m."moderationStatus"::text AS "machineModeration",
           m."lifecycleStatus"::text AS "machineLifecycle",
           r."kind"::text AS "kind",
             r."enabled", r."quarantined", r."runtimeState"::text AS "runtimeState",
             r."activeRentalId", a."hardwareUuid", a."vendor" AS "gpuVendor",
             a."moderationStatus"::text AS "acceleratorModeration",
             a."status"::text AS "acceleratorStatus",
             c."id" AS "configurationId", c."mode"::text AS "mode", c."profileId",
             c."walletAddress", c."workerName", c."ownerPoolEndpoint", c."ownerPoolSecretRef",
             c."maximumTemperatureC", c."maximumPowerWatts", c."version" AS "configurationVersion"
        FROM "MiningResource" r
   LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
   LEFT JOIN "MiningConfiguration" c ON c."resourceId" = r."id"
       WHERE r."id" = ${candidate.resourceId} AND r."machineId" = ${candidate.machineId}
       FOR UPDATE OF r
    `);
    const refreshed = current[0];
    if (!refreshed) throw new Error('mining_resource_not_found');
    if (kind === 'start_mining') {
      assertStartCandidate(refreshed);
      if (refreshed.configurationVersion !== candidate.configurationVersion) throw new Error('mining_configuration_changed');
      if (refreshed.hardwareUuid !== candidate.hardwareUuid) throw new Error('mining_hardware_identity_changed');
    } else {
      if (refreshed.quarantined) throw new Error('mining_resource_quarantined');
      if (refreshed.hardwareUuid !== candidate.hardwareUuid) throw new Error('mining_hardware_identity_changed');
    }
    const reserved = await reserveSequence(tx, candidate.machineId);
    const envelope: MachineCommandEnvelope = {
      id: commandId,
      machineId: candidate.machineId,
      commandType: kind,
      sequence: reserved,
      idempotencyKey,
      expiresAt,
      payload: { lease: inner.lease, payload: inner.payload },
    };
    await enqueueMachineCommand(tx, envelope);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MiningResource"
         SET "runtimeState" = ${kind === 'start_mining' ? 'STARTING' : 'VERIFYING_STOP'}::"MiningRuntimeState",
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${candidate.resourceId}
    `);
    return reserved;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
  return { commandId, sequence, lease };
}

export async function requestMiningStart(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  resourceId: string,
): Promise<{ commandId: string; sequence: bigint; lease: ResourceLeaseSnapshot }> {
  const candidate = await loadCandidate(db, machineId, resourceId);
  assertStartCandidate(candidate);
  const lease = await acquireMiningLease(redis, resourceId);
  try {
    const fenced = buildFencedStartMining({
      machineId,
      resourceId,
      hardwareUuid: candidate.hardwareUuid,
      profileId: candidate.profileId,
      poolUrl: candidate.ownerPoolEndpoint,
      walletAddress: candidate.walletAddress,
      workerName: candidate.workerName,
      performanceMode: 'FULL',
      maximumTemperatureC: candidate.maximumTemperatureC,
      maximumPowerWatts: candidate.maximumPowerWatts,
    }, lease);
    return await persistCommand(db, candidate, lease, 'start_mining', fenced);
  } catch (error) {
    await releaseResourceLease(redis, lease).catch(() => undefined);
    throw error;
  }
}

export async function requestMiningStop(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  resourceId: string,
): Promise<{ commandId: string; sequence: bigint; lease: ResourceLeaseSnapshot }> {
  const candidate = await loadCandidate(db, machineId, resourceId);
  if (!candidate.hardwareUuid) throw new Error('mining_hardware_identity_missing');
  if (!['MINING', 'STARTING', 'PREEMPTING', 'VERIFYING_STOP'].includes(candidate.runtimeState)) {
    throw new Error('mining_resource_not_stoppable');
  }
  const lease = await acquireMiningLease(redis, resourceId);
  try {
    const fenced = buildFencedStopMining({ machineId, resourceId, hardwareUuid: candidate.hardwareUuid }, lease);
    return await persistCommand(db, candidate, lease, 'stop_mining', fenced);
  } catch (error) {
    await releaseResourceLease(redis, lease).catch(() => undefined);
    throw error;
  }
}