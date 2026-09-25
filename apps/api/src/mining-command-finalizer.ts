import crypto from 'node:crypto';

import { MiningRuntimeState, Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import type { ClaimedMachineCommand } from './delivery-store.js';
import type { TerminalGatewayAck } from './control-command-dispatch.js';
import { releaseResourceLease } from './resource-lease.js';

type DurableMiningPayload = {
  lease: { resourceId: string; holderId: string; leaseId: string; fencingToken: string };
  payload: { resourceId: string; hardwareUuid: string; runtimeGeneration: string };
};

type MiningCommandIdentity = Pick<ClaimedMachineCommand, 'id' | 'machineId' | 'commandType' | 'payload'>;

type UncertainMiningCommand = MiningCommandIdentity & {
  status: 'PENDING' | 'LEASED' | 'DEAD' | 'EXPIRED';
  expiresAt: Date;
};

export type MiningDeliveryReconciliation = {
  scanned: number;
  updated: number;
  stale: number;
};

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}

function parseDurableMiningPayload(command: MiningCommandIdentity): DurableMiningPayload {
  if (command.commandType !== 'start_mining' && command.commandType !== 'stop_mining') {
    throw new Error('mining_terminal_command_type_invalid');
  }
  const lease = command.payload.lease;
  const payload = command.payload.payload;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error('mining_terminal_lease_missing');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mining_terminal_payload_missing');
  const l = lease as Record<string, unknown>;
  const p = payload as Record<string, unknown>;
  for (const key of ['resourceId','holderId','leaseId','fencingToken']) {
    if (typeof l[key] !== 'string' || !l[key]) throw new Error('mining_terminal_lease_invalid');
  }
  if (typeof p.resourceId !== 'string' || typeof p.hardwareUuid !== 'string' || typeof p.runtimeGeneration !== 'string') {
    throw new Error('mining_terminal_payload_invalid');
  }
  if (l.resourceId !== p.resourceId || l.fencingToken !== p.runtimeGeneration) {
    throw new Error('mining_terminal_fence_mismatch');
  }
  return {
    lease: {
      resourceId: String(l.resourceId),
      holderId: String(l.holderId),
      leaseId: String(l.leaseId),
      fencingToken: String(l.fencingToken),
    },
    payload: {
      resourceId: p.resourceId,
      hardwareUuid: p.hardwareUuid,
      runtimeGeneration: p.runtimeGeneration,
    },
  };
}

function terminalMapping(commandType: 'start_mining' | 'stop_mining', ack: TerminalGatewayAck) {
  const isStart = commandType === 'start_mining';
  if (isStart && ack.status === 'SUCCEEDED') {
    return { expected: MiningRuntimeState.STARTING, next: MiningRuntimeState.MINING, eventType: 'STARTED', quarantine: false, releaseLease: false } as const;
  }
  if (isStart && ack.status === 'REJECTED') {
    return { expected: MiningRuntimeState.STARTING, next: MiningRuntimeState.STOPPED, eventType: 'START_FAILED', quarantine: false, releaseLease: true } as const;
  }
  if (isStart) {
    return { expected: MiningRuntimeState.STARTING, next: MiningRuntimeState.QUARANTINED, eventType: 'START_FAILED', quarantine: true, releaseLease: true } as const;
  }
  if (ack.status === 'SUCCEEDED') {
    return { expected: MiningRuntimeState.VERIFYING_STOP, next: MiningRuntimeState.STOPPED, eventType: 'STOP_VERIFIED', quarantine: false, releaseLease: true } as const;
  }
  return { expected: MiningRuntimeState.VERIFYING_STOP, next: MiningRuntimeState.QUARANTINED, eventType: 'STOP_FAILED', quarantine: true, releaseLease: false } as const;
}


function uncertainDeliveryMapping(commandType: 'start_mining' | 'stop_mining') {
  return commandType === 'start_mining'
    ? { expected: MiningRuntimeState.STARTING, eventType: 'START_FAILED' as const }
    : { expected: MiningRuntimeState.VERIFYING_STOP, eventType: 'STOP_FAILED' as const };
}

async function finalizeUncertainMiningDelivery(
  db: PrismaClient,
  command: UncertainMiningCommand,
  now: Date,
): Promise<'UPDATED' | 'STALE_STATE'> {
  if (command.commandType !== 'start_mining' && command.commandType !== 'stop_mining') {
    throw new Error('mining_terminal_command_type_invalid');
  }
  const durable = parseDurableMiningPayload(command);
  const mapping = uncertainDeliveryMapping(command.commandType);
  const deliveryStatus = command.status === 'DEAD' ? 'DEAD' : 'EXPIRED';
  const detailCode = deliveryStatus === 'DEAD'
    ? 'durable_command_dead_without_terminal_ack'
    : 'durable_command_expired_without_terminal_ack';

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      runtimeState: MiningRuntimeState;
      activeRentalId: string | null;
      hardwareUuid: string | null;
    }>>(Prisma.sql`
      SELECT r."runtimeState", r."activeRentalId", a."hardwareUuid"
        FROM "MiningResource" r
   LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
       WHERE r."id" = ${durable.lease.resourceId} AND r."machineId" = ${command.machineId}
       FOR UPDATE OF r
    `);
    const current = rows[0];
    if (!current) throw new Error('mining_resource_not_found');
    if (current.hardwareUuid !== durable.payload.hardwareUuid) {
      throw new Error('mining_terminal_hardware_identity_conflict');
    }
    if (current.runtimeState !== mapping.expected || current.activeRentalId !== null) {
      return 'STALE_STATE' as const;
    }

    const terminalized = await tx.$executeRaw(Prisma.sql`
      UPDATE "MachineCommand"
         SET "status" = CASE
               WHEN "status" IN ('PENDING', 'LEASED') THEN 'EXPIRED'
               ELSE "status"
             END,
             "leaseOwner" = NULL,
             "leaseExpiresAt" = NULL,
             "lastError" = CASE
               WHEN "status" IN ('PENDING', 'LEASED') THEN ${detailCode}
               ELSE "lastError"
             END
       WHERE "id" = ${command.id}
         AND "machineId" = ${command.machineId}
         AND "commandType" = ${command.commandType}
         AND (
           "status" IN ('DEAD', 'EXPIRED')
           OR ("status" IN ('PENDING', 'LEASED') AND "expiresAt" <= ${now})
         )
    `);
    if (terminalized !== 1) return 'STALE_STATE' as const;

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningRuntimeEvent" (
        "id","resourceId","eventType","stateBefore","stateAfter",
        "idempotencyKey","agentCounter","payload","occurredAt","createdAt"
      ) VALUES (
        ${stableId('mre', command.id, 'DELIVERY_UNCERTAIN')}, ${durable.lease.resourceId},
        ${mapping.eventType}::"MiningEventType", ${current.runtimeState}::"MiningRuntimeState",
        'QUARANTINED'::"MiningRuntimeState", ${`command-delivery-uncertain:${command.id}`}, 0,
        ${JSON.stringify({ commandId: command.id, deliveryStatus, detailCode })}::jsonb,
        ${now}, CURRENT_TIMESTAMP
      ) ON CONFLICT ("idempotencyKey") DO NOTHING
    `);

    const changed = await tx.miningResource.updateMany({
      where: {
        id: durable.lease.resourceId,
        machineId: command.machineId,
        runtimeState: mapping.expected,
        activeRentalId: null,
      },
      data: { runtimeState: MiningRuntimeState.QUARANTINED, quarantined: true },
    });
    if (changed.count !== 1) throw new Error('mining_terminal_state_race');

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningAuditLog" (
        "id","machineId","resourceId","actorType","actorId","action","nextValue","createdAt"
      ) VALUES (
        ${crypto.randomUUID()}, ${command.machineId}, ${durable.lease.resourceId},
        'SYSTEM'::"MiningAuditActorType", 'delivery-worker',
        'mining_delivery_uncertain_quarantined',
        ${JSON.stringify({
          commandId: command.id,
          deliveryStatus,
          state: MiningRuntimeState.QUARANTINED,
          detailCode,
        })}::jsonb,
        CURRENT_TIMESTAMP
      )
    `);
    return 'UPDATED' as const;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}

export async function reconcileUncertainMiningDelivery(
  db: PrismaClient,
  now = new Date(),
  requestedLimit = 64,
): Promise<MiningDeliveryReconciliation> {
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 1;
  const commands = await db.$queryRaw<UncertainMiningCommand[]>(Prisma.sql`
    SELECT command."id", command."machineId", command."commandType",
           command."payload", command."status", command."expiresAt"
      FROM "MachineCommand" command
      JOIN "MiningResource" resource
        ON resource."id" = command."payload" -> 'lease' ->> 'resourceId'
       AND resource."machineId" = command."machineId"
     WHERE command."commandType" IN ('start_mining', 'stop_mining')
       AND jsonb_typeof(command."payload" -> 'lease') = 'object'
       AND jsonb_typeof(command."payload" -> 'payload') = 'object'
       AND command."payload" -> 'lease' ->> 'resourceId'
           = command."payload" -> 'payload' ->> 'resourceId'
       AND command."payload" -> 'lease' ->> 'fencingToken'
           = command."payload" -> 'payload' ->> 'runtimeGeneration'
       AND COALESCE(command."payload" -> 'payload' ->> 'hardwareUuid', '') <> ''
       AND resource."activeRentalId" IS NULL
       AND (
         (command."commandType" = 'start_mining' AND resource."runtimeState" = 'STARTING'::"MiningRuntimeState")
         OR
         (command."commandType" = 'stop_mining' AND resource."runtimeState" = 'VERIFYING_STOP'::"MiningRuntimeState")
       )
       AND (
         command."status" IN ('DEAD', 'EXPIRED')
         OR (
           command."status" IN ('PENDING', 'LEASED')
           AND command."expiresAt" <= ${now}
         )
       )
     ORDER BY command."expiresAt", command."sequence"
     LIMIT ${limit}
  `);

  let updated = 0;
  let stale = 0;
  for (const command of commands) {
    const outcome = await finalizeUncertainMiningDelivery(db, command, now);
    if (outcome === 'UPDATED') updated += 1;
    else stale += 1;
  }
  return { scanned: commands.length, updated, stale };
}

export async function finalizeMiningTerminalAck(
  db: PrismaClient,
  redis: Redis,
  command: ClaimedMachineCommand,
  ack: TerminalGatewayAck,
): Promise<'UPDATED' | 'STALE_STATE'> {
  if (command.commandType !== 'start_mining' && command.commandType !== 'stop_mining') {
    throw new Error('mining_terminal_command_type_invalid');
  }
  const durable = parseDurableMiningPayload(command);
  const mapping = terminalMapping(command.commandType, ack);
  const result = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ runtimeState: MiningRuntimeState; activeRentalId: string | null; hardwareUuid: string | null }>>(Prisma.sql`
      SELECT r."runtimeState", r."activeRentalId", a."hardwareUuid"
        FROM "MiningResource" r
   LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
       WHERE r."id" = ${durable.lease.resourceId} AND r."machineId" = ${command.machineId}
       FOR UPDATE OF r
    `);
    const current = rows[0];
    if (!current) throw new Error('mining_resource_not_found');
    if (current.hardwareUuid !== durable.payload.hardwareUuid) throw new Error('mining_terminal_hardware_identity_conflict');

    const stateStillOwned = current.runtimeState === mapping.expected
      && (command.commandType !== 'start_mining' || current.activeRentalId === null);
    if (!stateStillOwned) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningAuditLog" (
          "id","machineId","resourceId","actorType","actorId","action","nextValue","createdAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${command.machineId}, ${durable.lease.resourceId},
          'SYSTEM'::"MiningAuditActorType", 'delivery-worker', 'mining_terminal_ack_superseded',
          ${JSON.stringify({
            commandId: command.id,
            ackStatus: ack.status,
            detailCode: ack.detailCode ?? null,
            currentState: current.runtimeState,
            activeRental: current.activeRentalId !== null,
          })}::jsonb, CURRENT_TIMESTAMP
        )
      `);
      return 'STALE_STATE' as const;
    }

    const eventIdempotency = `command-terminal:${command.id}:${mapping.eventType}`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningRuntimeEvent" (
        "id","resourceId","eventType","stateBefore","stateAfter",
        "idempotencyKey","agentCounter","payload","occurredAt","createdAt"
      ) VALUES (
        ${stableId('mre', command.id, mapping.eventType)}, ${durable.lease.resourceId},
        ${mapping.eventType}::"MiningEventType", ${current.runtimeState}::"MiningRuntimeState",
        ${mapping.next}::"MiningRuntimeState", ${eventIdempotency}, 0,
        ${JSON.stringify({ commandId: command.id, ackStatus: ack.status, detailCode: ack.detailCode ?? null })}::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ) ON CONFLICT ("idempotencyKey") DO NOTHING
    `);

    const changed = await tx.miningResource.updateMany({
      where: {
        id: durable.lease.resourceId,
        machineId: command.machineId,
        runtimeState: mapping.expected,
        ...(command.commandType === 'start_mining' ? { activeRentalId: null } : {}),
      },
      data: { runtimeState: mapping.next, ...(mapping.quarantine ? { quarantined: true } : {}) },
    });
    if (changed.count !== 1) throw new Error('mining_terminal_state_race');

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningAuditLog" (
        "id","machineId","resourceId","actorType","actorId","action","nextValue","createdAt"
      ) VALUES (
        ${crypto.randomUUID()}, ${command.machineId}, ${durable.lease.resourceId},
        'SYSTEM'::"MiningAuditActorType", 'delivery-worker',
        ${ack.status === 'SUCCEEDED'
          ? (command.commandType === 'start_mining' ? 'mining_start_verified' : 'mining_stop_verified')
          : (command.commandType === 'start_mining' ? 'mining_start_failed' : 'mining_stop_failed')},
        ${JSON.stringify({ commandId: command.id, state: mapping.next, detailCode: ack.detailCode ?? null })}::jsonb,
        CURRENT_TIMESTAMP
      )
    `);
    return 'UPDATED' as const;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });

  if (mapping.releaseLease && result === 'UPDATED') {
    const released = await releaseResourceLease(redis, durable.lease);
    if (!released.accepted && released.reason !== 'MISSING' && released.reason !== 'STALE_LEASE') {
      throw new Error('mining_terminal_lease_release_failed');
    }
  }
  return result;
}