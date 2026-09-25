import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { enqueueMachineCommand } from './delivery-store.js';
import { buildFencedStartMining, buildFencedStopMining, type MiningPerformanceMode } from './mining-resource-control.js';
import { isMiningProfileApproved, normalizeMiningGpuVendor } from './mining-profile-catalog.js';
import { acquireResourceLease, readResourceLease, releaseResourceLease, type ResourceLeaseSnapshot } from './resource-lease.js';
import type { MachineCommandEnvelope } from './reliable-delivery.js';

const COMMAND_TTL_MS = 240_000;
const LEASE_TTL_SECONDS = 300;

type SqlClient = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>;

type ResourceForCommand = {
  resourceId: string;
  machineId: string;
  ownerId: string;
  kind: 'CPU' | 'GPU';
  enabled: boolean;
  quarantined: boolean;
  runtimeState: string;
  activeRentalId: string | null;
  hardwareUuid: string | null;
  gpuVendor: string | null;
  mode: 'DISABLED' | 'GPUBNB_MANAGED' | 'OWNER_POOL' | null;
  profileId: string | null;
  walletAddress: string | null;
  workerName: string | null;
  ownerPoolEndpoint: string | null;
  ownerPoolSecretRef: string | null;
  maximumTemperatureC: number | null;
  maximumPowerWatts: number | null;
  version: number | null;
};

export type MiningCommandRequestResult = {
  commandId: string;
  sequence: bigint;
  lease: ResourceLeaseSnapshot;
};

function digest(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${digest(...parts).slice(0, 32)}`;
}

function stableKey(namespace: string, ...parts: string[]): string {
  return `${namespace}:${digest(namespace, ...parts).slice(0, 48)}`;
}

async function reserveSequence(tx: SqlClient, machineId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>(Prisma.sql`
    SELECT reserve_machine_sequence(${machineId}) AS "sequence"
  `);
  const sequence = rows[0]?.sequence;
  if (sequence === undefined || sequence < 1n) throw new Error('machine_sequence_reservation_failed');
  return sequence;
}

async function loadResourceForCommand(
  tx: SqlClient,
  machineId: string,
  resourceId: string,
): Promise<ResourceForCommand> {
  const rows = await tx.$queryRaw<ResourceForCommand[]>(Prisma.sql`
    SELECT r."id" AS "resourceId", r."machineId", m."ownerId", r."kind",
           r."enabled", r."quarantined", r."runtimeState"::text AS "runtimeState", r."activeRentalId",
           a."hardwareUuid", a."vendor" AS "gpuVendor", c."mode", c."profileId", c."walletAddress", c."workerName",
           c."ownerPoolEndpoint", c."ownerPoolSecretRef", c."maximumTemperatureC",
           c."maximumPowerWatts", c."version"
      FROM "MiningResource" r
      JOIN "Machine" m ON m."id" = r."machineId"
 LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
 LEFT JOIN "MiningConfiguration" c ON c."resourceId" = r."id"
     WHERE r."id" = ${resourceId} AND r."machineId" = ${machineId}
     FOR UPDATE OF r
  `);
  const row = rows[0];
  if (!row) throw new Error('mining_resource_not_found');
  return row;
}

function validateOwner(row: ResourceForCommand, ownerId: string): void {
  if (row.ownerId !== ownerId) throw new Error('mining_machine_owner_required');
  if (row.kind !== 'GPU') throw new Error('mining_gpu_runtime_required');
  if (!row.enabled) throw new Error('mining_resource_disabled');
  if (row.quarantined) throw new Error('mining_resource_quarantined');
  if (normalizeMiningGpuVendor(row.gpuVendor) !== 'NVIDIA') throw new Error('mining_gpu_vendor_not_qualified');
  if (row.activeRentalId) throw new Error('mining_resource_rented');
  if (!row.hardwareUuid) throw new Error('mining_hardware_uuid_missing');
}

function startInput(row: ResourceForCommand) {
  if (row.mode !== 'OWNER_POOL') throw new Error('mining_owner_pool_required');
  if (!row.profileId || !row.walletAddress || !row.workerName || !row.ownerPoolEndpoint) {
    throw new Error('mining_configuration_incomplete');
  }
  if (!isMiningProfileApproved(row.profileId, 'GPU', 'NVIDIA')) {
    throw new Error('mining_profile_not_approved');
  }
  if (row.ownerPoolSecretRef) throw new Error('miner_secret_resolution_required');
  if (row.maximumTemperatureC === null || row.maximumPowerWatts === null) {
    throw new Error('mining_limits_missing');
  }
  return {
    machineId: row.machineId,
    resourceId: row.resourceId,
    hardwareUuid: row.hardwareUuid!,
    profileId: row.profileId,
    poolUrl: row.ownerPoolEndpoint,
    walletAddress: row.walletAddress,
    workerName: row.workerName,
    performanceMode: 'FULL' as MiningPerformanceMode,
    maximumTemperatureC: row.maximumTemperatureC,
    maximumPowerWatts: row.maximumPowerWatts,
  };
}

async function enqueue(
  tx: SqlClient,
  row: ResourceForCommand,
  commandType: 'start_mining' | 'stop_mining',
  idempotencySeed: string,
  payload: Record<string, unknown>,
): Promise<{ commandId: string; sequence: bigint }> {
  const sequence = await reserveSequence(tx, row.machineId);
  const commandId = stableId('cmd', row.machineId, row.resourceId, commandType, idempotencySeed);
  const command: MachineCommandEnvelope = {
    id: commandId,
    machineId: row.machineId,
    commandType,
    sequence,
    idempotencyKey: stableKey('mining-command', row.machineId, row.resourceId, commandType, idempotencySeed),
    expiresAt: new Date(Date.now() + COMMAND_TTL_MS),
    payload,
  };
  await enqueueMachineCommand(tx, command);
  return { commandId, sequence };
}

export async function requestMiningStart(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; ownerId: string },
): Promise<MiningCommandRequestResult> {
  const preview = await db.$transaction((tx) => loadResourceForCommand(tx, input.machineId, input.resourceId));
  validateOwner(preview, input.ownerId);
  if (preview.runtimeState === 'MINING' || preview.runtimeState === 'STARTING') {
    throw new Error('mining_resource_already_active');
  }
  const configVersion = preview.version;
  if (configVersion === null || configVersion < 1) throw new Error('mining_configuration_missing');
  const leaseIdempotency = stableKey('mining-lease-start', preview.resourceId, String(configVersion));
  const holderId = `mining:${preview.resourceId}`;
  const acquired = await acquireResourceLease(redis, {
    resourceId: preview.resourceId,
    holderId,
    idempotencyKey: leaseIdempotency,
    ttlSeconds: LEASE_TTL_SECONDS,
  });
  if (acquired.status === 'BUSY') throw new Error('mining_resource_lease_busy');

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await loadResourceForCommand(tx, input.machineId, input.resourceId);
      validateOwner(current, input.ownerId);
      if (current.version !== configVersion) throw new Error('mining_configuration_changed_during_start');
      const fenced = buildFencedStartMining(startInput(current), acquired.lease);
      const queued = await enqueue(tx, current, 'start_mining', String(configVersion), fenced as unknown as Record<string, unknown>);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MiningResource"
           SET "runtimeState" = 'STARTING'::"MiningRuntimeState", "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ${current.resourceId} AND "machineId" = ${current.machineId}
      `);
      return queued;
    });
    return { ...result, lease: acquired.lease };
  } catch (error) {
    await releaseResourceLease(redis, acquired.lease).catch(() => undefined);
    throw error;
  }
}

export async function requestMiningStop(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; ownerId: string },
): Promise<MiningCommandRequestResult> {
  const preview = await db.$transaction((tx) => loadResourceForCommand(tx, input.machineId, input.resourceId));
  validateOwner(preview, input.ownerId);
  if (preview.runtimeState === 'IDLE' || preview.runtimeState === 'STOPPED') {
    throw new Error('mining_resource_already_stopped');
  }

  const holderId = `mining:${preview.resourceId}`;
  const currentLease = await readResourceLease(redis, preview.resourceId);
  let lease: ResourceLeaseSnapshot;
  let acquiredForStop = false;
  if (currentLease) {
    if (currentLease.holderId !== holderId) throw new Error('mining_resource_lease_busy');
    lease = currentLease;
  } else {
    const acquired = await acquireResourceLease(redis, {
      resourceId: preview.resourceId,
      holderId,
      idempotencyKey: stableKey('mining-lease-stop', preview.resourceId, preview.runtimeState),
      ttlSeconds: LEASE_TTL_SECONDS,
    });
    if (acquired.status === 'BUSY') throw new Error('mining_resource_lease_busy');
    lease = acquired.lease;
    acquiredForStop = true;
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await loadResourceForCommand(tx, input.machineId, input.resourceId);
      validateOwner(current, input.ownerId);
      const fenced = buildFencedStopMining({
        machineId: current.machineId,
        resourceId: current.resourceId,
        hardwareUuid: current.hardwareUuid!,
      }, lease);
      const queued = await enqueue(tx, current, 'stop_mining', lease.fencingToken, fenced as unknown as Record<string, unknown>);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MiningResource"
           SET "runtimeState" = 'VERIFYING_STOP'::"MiningRuntimeState", "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ${current.resourceId} AND "machineId" = ${current.machineId}
      `);
      return queued;
    });
    return { ...result, lease };
  } catch (error) {
    if (acquiredForStop) await releaseResourceLease(redis, lease).catch(() => undefined);
    throw error;
  }
}