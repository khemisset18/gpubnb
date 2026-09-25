import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { enqueueMachineCommand } from './delivery-store.js';
import { buildFencedStartMining, buildFencedStopMining, type MiningPerformanceMode } from './mining-resource-control.js';
import { isMiningProfileApproved, normalizeMiningGpuVendor } from './mining-profile-catalog.js';
import { acquireResourceLease, readResourceLease, releaseResourceLease, renewResourceLease, type ResourceLeaseSnapshot } from './resource-lease.js';
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
  resumeAfterRentalPending: boolean;
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
  autoResumeAfterRental: boolean | null;
  version: number | null;
};

export type MiningCommandRequestResult = {
  commandId: string | null;
  sequence: bigint | null;
  lease: ResourceLeaseSnapshot | null;
  alreadySatisfied: boolean;
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
           r."resumeAfterRentalPending",
           a."hardwareUuid", a."vendor" AS "gpuVendor", c."mode", c."profileId", c."walletAddress", c."workerName",
           c."ownerPoolEndpoint", c."ownerPoolSecretRef", c."maximumTemperatureC",
           c."maximumPowerWatts", c."autoResumeAfterRental", c."version"
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
  now: Date,
): Promise<{ commandId: string; sequence: bigint }> {
  const sequence = await reserveSequence(tx, row.machineId);
  const commandId = stableId('cmd', row.machineId, row.resourceId, commandType, idempotencySeed);
  const command: MachineCommandEnvelope = {
    id: commandId,
    machineId: row.machineId,
    commandType,
    sequence,
    idempotencyKey: stableKey('mining-command', row.machineId, row.resourceId, commandType, idempotencySeed),
    expiresAt: new Date(now.getTime() + COMMAND_TTL_MS),
    payload,
  };
  await enqueueMachineCommand(tx, command);
  return { commandId, sequence };
}

export async function requestMiningStart(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; ownerId: string; requestId?: string; now?: Date },
): Promise<MiningCommandRequestResult> {
  const now = input.now ?? new Date();
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
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "MiningResource"
           SET "runtimeState" = 'STARTING'::"MiningRuntimeState",
               "resumeAfterRentalPending" = false,
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ${current.resourceId} AND "machineId" = ${current.machineId}
           AND "runtimeState" IN ('IDLE'::"MiningRuntimeState",'STOPPED'::"MiningRuntimeState")
           AND "activeRentalId" IS NULL AND "quarantined" = false AND "enabled" = true
      `);
      if (changed !== 1) throw new Error('mining_resource_not_startable');
      const queued = await enqueue(
        tx,
        current,
        'start_mining',
        `${configVersion}:${acquired.lease.fencingToken}`,
        fenced as unknown as Record<string, unknown>,
        now,
      );
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningRuntimeEvent" (
          "id","resourceId","eventType","stateBefore","stateAfter","idempotencyKey",
          "agentCounter","payload","occurredAt","createdAt"
        ) VALUES (
          ${stableId('mre', queued.commandId, 'START_REQUESTED')}, ${current.resourceId},
          'START_REQUESTED'::"MiningEventType", ${current.runtimeState}::"MiningRuntimeState",
          'STARTING'::"MiningRuntimeState", ${stableKey('mining-event', queued.commandId, 'START_REQUESTED')},
          0, ${JSON.stringify({commandId: queued.commandId})}::jsonb, ${now}, CURRENT_TIMESTAMP
        ) ON CONFLICT ("idempotencyKey") DO NOTHING
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningAuditLog" (
          "id","machineId","resourceId","configurationId","actorType","actorId","action",
          "requestId","nextValue","createdAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${current.machineId}, ${current.resourceId}, NULL,
          'OWNER'::"MiningAuditActorType", ${input.ownerId}, 'mining_start_requested',
          ${input.requestId ?? null}, ${JSON.stringify({commandId: queued.commandId})}::jsonb, CURRENT_TIMESTAMP
        )
      `);
      return queued;
    });
    return { ...result, lease: acquired.lease, alreadySatisfied: false };
  } catch (error) {
    await releaseResourceLease(redis, acquired.lease).catch(() => undefined);
    throw error;
  }
}

export async function requestMiningStop(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; ownerId: string; requestId?: string; now?: Date },
): Promise<MiningCommandRequestResult> {
  const now = input.now ?? new Date();
  const preview = await db.$transaction((tx) => loadResourceForCommand(tx, input.machineId, input.resourceId));
  validateOwner(preview, input.ownerId);
  if (preview.runtimeState === 'IDLE' || preview.runtimeState === 'STOPPED') {
    return { commandId: null, sequence: null, lease: null, alreadySatisfied: true };
  }
  if (preview.runtimeState !== 'STARTING' && preview.runtimeState !== 'MINING') {
    throw new Error('mining_resource_not_stoppable');
  }

  const holderId = `mining:${preview.resourceId}`;
  const currentLease = await readResourceLease(redis, preview.resourceId);
  let lease: ResourceLeaseSnapshot;
  let acquiredForStop = false;
  if (currentLease) {
    if (currentLease.holderId !== holderId) throw new Error('mining_resource_lease_busy');
    const renewed = await renewResourceLease(redis, {
      resourceId: currentLease.resourceId,
      holderId: currentLease.holderId,
      leaseId: currentLease.leaseId,
      fencingToken: currentLease.fencingToken,
      ttlSeconds: LEASE_TTL_SECONDS,
    });
    if (!renewed.accepted) throw new Error('mining_resource_lease_stale');
    lease = { ...currentLease, ttlMs: renewed.ttlMs };
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
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "MiningResource"
           SET "runtimeState" = 'VERIFYING_STOP'::"MiningRuntimeState", "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ${current.resourceId} AND "machineId" = ${current.machineId}
           AND "runtimeState" IN ('STARTING'::"MiningRuntimeState",'MINING'::"MiningRuntimeState")
           AND "activeRentalId" IS NULL
      `);
      if (changed !== 1) throw new Error('mining_resource_not_stoppable');
      const queued = await enqueue(tx, current, 'stop_mining', lease.fencingToken, fenced as unknown as Record<string, unknown>, now);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningRuntimeEvent" (
          "id","resourceId","eventType","stateBefore","stateAfter","idempotencyKey",
          "agentCounter","payload","occurredAt","createdAt"
        ) VALUES (
          ${stableId('mre', queued.commandId, 'STOP_REQUESTED')}, ${current.resourceId},
          'STOP_REQUESTED'::"MiningEventType", ${current.runtimeState}::"MiningRuntimeState",
          'VERIFYING_STOP'::"MiningRuntimeState", ${stableKey('mining-event', queued.commandId, 'STOP_REQUESTED')},
          0, ${JSON.stringify({commandId: queued.commandId})}::jsonb, ${now}, CURRENT_TIMESTAMP
        ) ON CONFLICT ("idempotencyKey") DO NOTHING
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningAuditLog" (
          "id","machineId","resourceId","configurationId","actorType","actorId","action",
          "requestId","nextValue","createdAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${current.machineId}, ${current.resourceId}, NULL,
          'OWNER'::"MiningAuditActorType", ${input.ownerId}, 'mining_stop_requested',
          ${input.requestId ?? null}, ${JSON.stringify({commandId: queued.commandId})}::jsonb, CURRENT_TIMESTAMP
        )
      `);
      return queued;
    });
    return { ...result, lease, alreadySatisfied: false };
  } catch (error) {
    if (acquiredForStop) await releaseResourceLease(redis, lease).catch(() => undefined);
    throw error;
  }
}

export async function requestSystemMiningAutoResume(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; requestId: string; now?: Date },
): Promise<MiningCommandRequestResult> {
  const now = input.now ?? new Date();
  const preview = await db.$transaction((tx) => loadResourceForCommand(tx, input.machineId, input.resourceId));
  if (!preview.resumeAfterRentalPending || preview.autoResumeAfterRental !== true) {
    return { commandId: null, sequence: null, lease: null, alreadySatisfied: true };
  }
  validateOwner(preview, preview.ownerId);
  if (preview.runtimeState !== 'STOPPED' || preview.activeRentalId) {
    throw new Error('mining_auto_resume_not_ready');
  }
  const configVersion = preview.version;
  if (configVersion === null || configVersion < 1) throw new Error('mining_configuration_missing');

  const acquired = await acquireResourceLease(redis, {
    resourceId: preview.resourceId,
    holderId: `mining:${preview.resourceId}`,
    idempotencyKey: stableKey('mining-auto-resume', preview.resourceId, String(configVersion), input.requestId),
    ttlSeconds: LEASE_TTL_SECONDS,
  });
  if (acquired.status === 'BUSY') throw new Error('mining_resource_lease_busy');

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await loadResourceForCommand(tx, input.machineId, input.resourceId);
      if (!current.resumeAfterRentalPending || current.autoResumeAfterRental !== true) {
        throw new Error('mining_auto_resume_intent_missing');
      }
      validateOwner(current, current.ownerId);
      if (current.runtimeState !== 'STOPPED' || current.activeRentalId) {
        throw new Error('mining_auto_resume_not_ready');
      }
      if (current.version !== configVersion) throw new Error('mining_configuration_changed_during_start');

      const fenced = buildFencedStartMining(startInput(current), acquired.lease);
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "MiningResource"
           SET "runtimeState" = 'STARTING'::"MiningRuntimeState",
               "resumeAfterRentalPending" = false,
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = ${current.resourceId} AND "machineId" = ${current.machineId}
           AND "runtimeState" = 'STOPPED'::"MiningRuntimeState"
           AND "activeRentalId" IS NULL
           AND "resumeAfterRentalPending" = true
           AND "quarantined" = false AND "enabled" = true
      `);
      if (changed !== 1) throw new Error('mining_auto_resume_state_race');

      const queued = await enqueue(
        tx,
        current,
        'start_mining',
        `auto-resume:${input.requestId}:${acquired.lease.fencingToken}`,
        fenced as unknown as Record<string, unknown>,
        now,
      );
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningRuntimeEvent" (
          "id","resourceId","eventType","stateBefore","stateAfter","idempotencyKey",
          "agentCounter","payload","occurredAt","createdAt"
        ) VALUES (
          ${stableId('mre', queued.commandId, 'AUTO_RESUME_REQUESTED')}, ${current.resourceId},
          'AUTO_RESUME_REQUESTED'::"MiningEventType", 'STOPPED'::"MiningRuntimeState",
          'STARTING'::"MiningRuntimeState", ${stableKey('mining-event', queued.commandId, 'AUTO_RESUME_REQUESTED')},
          0, ${JSON.stringify({ commandId: queued.commandId, source: 'rental-cleanup' })}::jsonb,
          ${now}, CURRENT_TIMESTAMP
        ) ON CONFLICT ("idempotencyKey") DO NOTHING
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningAuditLog" (
          "id","machineId","resourceId","actorType","actorId","action",
          "requestId","nextValue","createdAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${current.machineId}, ${current.resourceId},
          'SYSTEM'::"MiningAuditActorType", 'rental-cleanup-auto-resume',
          'mining_auto_resume_requested', ${input.requestId},
          ${JSON.stringify({ commandId: queued.commandId })}::jsonb, CURRENT_TIMESTAMP
        )
      `);
      return queued;
    });
    return { ...result, lease: acquired.lease, alreadySatisfied: false };
  } catch (error) {
    await releaseResourceLease(redis, acquired.lease).catch(() => undefined);
    throw error;
  }
}
