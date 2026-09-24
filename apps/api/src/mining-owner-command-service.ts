import crypto from 'node:crypto';

import {
  MiningRuntimeState,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { Redis } from 'ioredis';

import { enqueueMachineCommand } from './delivery-store.js';
import { isMiningProfileApproved } from './mining-profile-catalog.js';
import {
  buildFencedStartMining,
  buildFencedStopMining,
} from './mining-resource-control.js';
import {
  acquireResourceLease,
  readResourceLease,
  releaseResourceLease,
  renewResourceLease,
  type ResourceLeaseSnapshot,
} from './resource-lease.js';

const MINING_LEASE_TTL_SECONDS = 300;
const COMMAND_TTL_MS = 120_000;

type RuntimeAction = 'start' | 'stop';

export type MiningOwnerCommandResult = {
  commandId: string | null;
  action: RuntimeAction;
  state: MiningRuntimeState;
  alreadySatisfied: boolean;
};

type ResourceContext = {
  id: string;
  machineId: string;
  ownerId: string;
  kind: 'CPU' | 'GPU';
  enabled: boolean;
  quarantined: boolean;
  runtimeState: MiningRuntimeState;
  activeRentalId: string | null;
  updatedAt: Date;
  hardwareUuid: string | null;
  gpuVendor: string | null;
  configuration: {
    id: string;
    mode: 'DISABLED' | 'GPUBNB_MANAGED' | 'OWNER_POOL';
    profileId: string | null;
    walletAddress: string | null;
    workerName: string;
    ownerPoolEndpoint: string | null;
    ownerPoolSecretRef: string | null;
    maximumTemperatureC: number | null;
    maximumPowerWatts: number | null;
    autoResumeAfterRental: boolean;
    version: number;
  } | null;
};

function stableId(prefix: string, ...parts: string[]): string {
  const digest = crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function miningHolder(resourceId: string): string {
  return `mining:${resourceId}`;
}

function leaseIdempotency(action: RuntimeAction, resource: ResourceContext): string {
  const suffix = action === 'start'
    ? `v${resource.configuration?.version ?? 0}`
    : `u${resource.updatedAt.getTime()}`;
  return `mining:${action}:${resource.id}:${suffix}`;
}

async function loadResource(
  db: PrismaClient,
  machineId: string,
  resourceId: string,
  ownerId?: string,
): Promise<ResourceContext> {
  const resource = await db.miningResource.findFirst({
    where: {
      id: resourceId,
      machineId,
      ...(ownerId ? { machine: { ownerId } } : {}),
    },
    select: {
      id: true,
      machineId: true,
      kind: true,
      enabled: true,
      quarantined: true,
      runtimeState: true,
      activeRentalId: true,
      updatedAt: true,
      machine: { select: { ownerId: true } },
      accelerator: { select: { hardwareUuid: true, vendor: true } },
      configuration: {
        select: {
          id: true,
          mode: true,
          profileId: true,
          walletAddress: true,
          workerName: true,
          ownerPoolEndpoint: true,
          ownerPoolSecretRef: true,
          maximumTemperatureC: true,
          maximumPowerWatts: true,
          autoResumeAfterRental: true,
          version: true,
        },
      },
    },
  });
  if (!resource) throw new Error('mining_resource_not_found');
  return {
    id: resource.id,
    machineId: resource.machineId,
    ownerId: resource.machine.ownerId,
    kind: resource.kind,
    enabled: resource.enabled,
    quarantined: resource.quarantined,
    runtimeState: resource.runtimeState,
    activeRentalId: resource.activeRentalId,
    updatedAt: resource.updatedAt,
    hardwareUuid: resource.accelerator?.hardwareUuid ?? null,
    gpuVendor: resource.accelerator?.vendor ?? null,
    configuration: resource.configuration,
  };
}

function validateStartable(resource: ResourceContext): asserts resource is ResourceContext & {
  hardwareUuid: string;
  configuration: NonNullable<ResourceContext['configuration']>;
} {
  if (resource.kind !== 'GPU') throw new Error('mining_cpu_runtime_not_operational');
  if (!resource.enabled) throw new Error('mining_resource_disabled');
  if (resource.quarantined) throw new Error('mining_resource_quarantined');
  if (resource.activeRentalId) throw new Error('mining_resource_rental_active');
  if (
    resource.runtimeState !== MiningRuntimeState.IDLE
    && resource.runtimeState !== MiningRuntimeState.STOPPED
  ) {
    throw new Error('mining_resource_not_startable');
  }
  if (!resource.hardwareUuid) throw new Error('mining_hardware_uuid_missing');
  if (resource.gpuVendor?.toUpperCase() !== 'NVIDIA') throw new Error('mining_gpu_vendor_not_operational');
  const configuration = resource.configuration;
  if (!configuration) throw new Error('mining_configuration_missing');
  if (configuration.mode !== 'OWNER_POOL') throw new Error('mining_owner_pool_required');
  if (!configuration.profileId || !isMiningProfileApproved(configuration.profileId, 'GPU', 'NVIDIA')) {
    throw new Error('mining_profile_not_approved');
  }
  if (!configuration.walletAddress) throw new Error('mining_wallet_required');
  if (!configuration.ownerPoolEndpoint) throw new Error('owner_pool_endpoint_required');
  if (configuration.ownerPoolSecretRef) {
    // The DPAPI broker exists separately, but no approved miner secret-delivery
    // path may place plaintext in argv. Keep runtime execution dark for secrets.
    throw new Error('mining_pool_secret_runtime_unavailable');
  }
  if (
    !Number.isInteger(configuration.maximumTemperatureC)
    || configuration.maximumTemperatureC! < 85
    || configuration.maximumTemperatureC! > 98
  ) {
    throw new Error('mining_maximum_temperature_invalid');
  }
  if (
    !Number.isInteger(configuration.maximumPowerWatts)
    || configuration.maximumPowerWatts! < 5
    || configuration.maximumPowerWatts! > 1500
  ) {
    throw new Error('mining_maximum_power_invalid');
  }
}

async function reserveSequence(tx: Prisma.TransactionClient, machineId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>(
    Prisma.sql`SELECT reserve_machine_sequence(${machineId}) AS "sequence"`,
  );
  const sequence = rows[0]?.sequence;
  if (sequence === undefined || sequence < 1n) throw new Error('machine_sequence_reservation_failed');
  return sequence;
}

async function acquireMiningLease(
  redis: Redis,
  resource: ResourceContext,
  action: RuntimeAction,
): Promise<{ lease: ResourceLeaseSnapshot; acquired: boolean }> {
  const result = await acquireResourceLease(redis, {
    resourceId: resource.id,
    holderId: miningHolder(resource.id),
    idempotencyKey: leaseIdempotency(action, resource),
    ttlSeconds: MINING_LEASE_TTL_SECONDS,
  });
  if (result.status === 'BUSY') throw new Error('mining_resource_lease_busy');
  return { lease: result.lease, acquired: result.status === 'ACQUIRED' };
}

async function currentOrFreshStopLease(
  redis: Redis,
  resource: ResourceContext,
): Promise<{ lease: ResourceLeaseSnapshot; acquired: boolean }> {
  const current = await readResourceLease(redis, resource.id);
  if (current) {
    if (current.holderId !== miningHolder(resource.id)) {
      throw new Error('mining_resource_lease_owned_by_rental');
    }
    const renewed = await renewResourceLease(redis, {
      resourceId: current.resourceId,
      holderId: current.holderId,
      leaseId: current.leaseId,
      fencingToken: current.fencingToken,
      ttlSeconds: MINING_LEASE_TTL_SECONDS,
    });
    if (!renewed.accepted) throw new Error('mining_resource_lease_stale');
    return { lease: { ...current, ttlMs: renewed.ttlMs }, acquired: false };
  }
  return acquireMiningLease(redis, resource, 'stop');
}

async function recordRequestedCommand(
  db: PrismaClient,
  resource: ResourceContext,
  actor: { type: 'OWNER' | 'SYSTEM'; id: string },
  requestId: string,
  action: RuntimeAction,
  lease: ResourceLeaseSnapshot,
  durablePayload: Record<string, unknown>,
  now: Date,
  requestedEventType: 'START_REQUESTED' | 'STOP_REQUESTED' | 'AUTO_RESUME_REQUESTED' = action === 'start' ? 'START_REQUESTED' : 'STOP_REQUESTED',
): Promise<MiningOwnerCommandResult> {
  const commandId = stableId('cmd', resource.machineId, resource.id, action, lease.leaseId);
  const idempotencyKey = `mining:${action}:${resource.id}:${lease.leaseId}`;
  const eventType = requestedEventType;
  const targetState = action === 'start' ? MiningRuntimeState.STARTING : MiningRuntimeState.VERIFYING_STOP;
  const allowedStates = action === 'start'
    ? [MiningRuntimeState.IDLE, MiningRuntimeState.STOPPED]
    : [MiningRuntimeState.STARTING, MiningRuntimeState.MINING];

  await db.$transaction(async (tx) => {
    const changed = await tx.miningResource.updateMany({
      where: {
        id: resource.id,
        machineId: resource.machineId,
        runtimeState: { in: allowedStates },
        activeRentalId: null,
        quarantined: false,
        enabled: true,
      },
      data: { runtimeState: targetState },
    });
    if (changed.count !== 1) throw new Error(`mining_resource_not_${action}able`);

    const sequence = await reserveSequence(tx, resource.machineId);
    await enqueueMachineCommand(tx, {
      id: commandId,
      machineId: resource.machineId,
      commandType: action === 'start' ? 'start_mining' : 'stop_mining',
      sequence,
      idempotencyKey,
      expiresAt: new Date(now.getTime() + COMMAND_TTL_MS),
      payload: durablePayload,
    });

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningRuntimeEvent" (
        "id", "resourceId", "eventType", "stateBefore", "stateAfter",
        "idempotencyKey", "payload", "occurredAt", "createdAt"
      ) VALUES (
        ${stableId('mre', commandId, eventType)}, ${resource.id}, ${eventType}::"MiningEventType",
        ${resource.runtimeState}::"MiningRuntimeState", ${targetState}::"MiningRuntimeState",
        ${`owner-command:${commandId}:${eventType}`}, ${JSON.stringify({ commandId })}::jsonb,
        ${now}, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("idempotencyKey") DO NOTHING
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningAuditLog" (
        "id", "machineId", "resourceId", "configurationId", "actorType", "actorId",
        "action", "requestId", "nextValue", "createdAt"
      ) VALUES (
        ${crypto.randomUUID()}, ${resource.machineId}, ${resource.id},
        ${resource.configuration?.id ?? null}, 'OWNER'::"MiningAuditActorType", ${ownerId},
        ${action === 'start' ? 'mining_start_requested' : 'mining_stop_requested'},
        ${requestId}, ${JSON.stringify({ commandId, targetState })}::jsonb, CURRENT_TIMESTAMP
      )
    `);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });

  return { commandId, action, state: targetState, alreadySatisfied: false };
}

export async function requestOwnerMiningStart(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; ownerId: string; requestId: string; now?: Date },
): Promise<MiningOwnerCommandResult> {
  const now = input.now ?? new Date();
  const resource = await loadResource(db, input.machineId, input.resourceId, input.ownerId);
  validateStartable(resource);

  const leaseResult = await acquireMiningLease(redis, resource, 'start');
  try {
    const configuration = resource.configuration;
    const fenced = buildFencedStartMining({
      machineId: resource.machineId,
      resourceId: resource.id,
      hardwareUuid: resource.hardwareUuid,
      profileId: configuration.profileId!,
      poolUrl: configuration.ownerPoolEndpoint!,
      walletAddress: configuration.walletAddress!,
      workerName: configuration.workerName,
      performanceMode: 'FULL',
      maximumTemperatureC: configuration.maximumTemperatureC!,
      maximumPowerWatts: configuration.maximumPowerWatts!,
    }, leaseResult.lease);
    return await recordRequestedCommand(
      db,
      resource,
      { type: 'OWNER', id: input.ownerId },
      input.requestId,
      'start',
      leaseResult.lease,
      fenced,
      now,
    );
  } catch (error) {
    if (leaseResult.acquired) {
      await releaseResourceLease(redis, leaseResult.lease).catch(() => undefined);
    }
    throw error;
  }
}

export async function requestOwnerMiningStop(
  db: PrismaClient,
  redis: Redis,
  input: { machineId: string; resourceId: string; ownerId: string; requestId: string; now?: Date },
): Promise<MiningOwnerCommandResult> {
  const now = input.now ?? new Date();
  const resource = await loadResource(db, input.machineId, input.resourceId, input.ownerId);
  if (
    resource.runtimeState === MiningRuntimeState.IDLE
    || resource.runtimeState === MiningRuntimeState.STOPPED
  ) {
    return { commandId: null, action: 'stop', state: resource.runtimeState, alreadySatisfied: true };
  }
  if (resource.activeRentalId) throw new Error('mining_resource_rental_active');
  if (
    resource.runtimeState !== MiningRuntimeState.STARTING
    && resource.runtimeState !== MiningRuntimeState.MINING
  ) {
    throw new Error('mining_resource_not_stoppable');
  }
  if (resource.kind !== 'GPU' || !resource.hardwareUuid) throw new Error('mining_gpu_runtime_identity_missing');

  const leaseResult = await currentOrFreshStopLease(redis, resource);
  try {
    const fenced = buildFencedStopMining({
      machineId: resource.machineId,
      resourceId: resource.id,
      hardwareUuid: resource.hardwareUuid,
    }, leaseResult.lease);
    return await recordRequestedCommand(
      db,
      resource,
      { type: 'OWNER', id: input.ownerId },
      input.requestId,
      'stop',
      leaseResult.lease,
      fenced,
      now,
    );
  } catch (error) {
    if (leaseResult.acquired) {
      await releaseResourceLease(redis, leaseResult.lease).catch(() => undefined);
    }
    throw error;
  }
}
