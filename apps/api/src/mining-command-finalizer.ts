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


type TerminalMiningDeliveryRow = {
  id: string;
  machineId: string;
  commandType: 'start_mining' | 'stop_mining';
  payload: Record<string, unknown>;
  status: 'DEAD' | 'EXPIRED';
  sequence: bigint;
};

export type MiningTerminalReconciliation = {
  quarantined: number;
  superseded: number;
};

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}

function parseDurableMiningPayload(command: ClaimedMachineCommand): DurableMiningPayload {
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deliveryTerminalIdentity(command: TerminalMiningDeliveryRow): {
  resourceId: string;
  hardwareUuid: string | null;
  fenceValid: boolean;
} {
  const inner = plainObject(command.payload.payload) ? command.payload.payload : null;
  const lease = plainObject(command.payload.lease) ? command.payload.lease : null;
  const resourceId = typeof inner?.resourceId === 'string' ? inner.resourceId : '';
  if (!resourceId) throw new Error('mining_delivery_terminal_resource_missing');
  const hardwareUuid = typeof inner?.hardwareUuid === 'string' && inner.hardwareUuid
    ? inner.hardwareUuid
    : null;
  const runtimeGeneration = typeof inner?.runtimeGeneration === 'string' ? inner.runtimeGeneration : null;
  const fenceValid = lease !== null
    && typeof lease.resourceId === 'string'
    && lease.resourceId === resourceId
    && typeof lease.holderId === 'string'
    && lease.holderId.length > 0
    && typeof lease.leaseId === 'string'
    && lease.leaseId.length > 0
    && typeof lease.fencingToken === 'string'
    && lease.fencingToken.length > 0
    && lease.fencingToken === runtimeGeneration;
  return { resourceId, hardwareUuid, fenceValid };
}

async function finalizeMiningDeliveryTerminal(
  db: PrismaClient,
  command: TerminalMiningDeliveryRow,
): Promise<'QUARANTINED' | 'STALE_STATE'> {
  const identity = deliveryTerminalIdentity(command);
  const expected = command.commandType === 'start_mining'
    ? MiningRuntimeState.STARTING
    : MiningRuntimeState.VERIFYING_STOP;
  const eventType = command.commandType === 'start_mining' ? 'START_FAILED' : 'STOP_FAILED';
  const reason = command.status === 'EXPIRED'
    ? 'mining_command_expired_without_terminal_ack'
    : 'mining_command_dead_without_terminal_ack';

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      runtimeState: MiningRuntimeState;
      activeRentalId: string | null;
      hardwareUuid: string | null;
    }>>(Prisma.sql`
      SELECT r."runtimeState", r."activeRentalId", a."hardwareUuid"
        FROM "MiningResource" r
   LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
       WHERE r."id" = ${identity.resourceId} AND r."machineId" = ${command.machineId}
       FOR UPDATE OF r
    `);
    const current = rows[0];
    if (!current) throw new Error('mining_resource_not_found');

    const stateStillOwned = current.runtimeState === expected
      && (command.commandType !== 'start_mining' || current.activeRentalId === null);
    if (!stateStillOwned) return 'STALE_STATE' as const;

    const hardwareIdentityMatches = identity.hardwareUuid !== null
      && current.hardwareUuid === identity.hardwareUuid;
    const changed = await tx.miningResource.updateMany({
      where: {
        id: identity.resourceId,
        machineId: command.machineId,
        runtimeState: expected,
        ...(command.commandType === 'start_mining' ? { activeRentalId: null } : {}),
      },
      data: {
        runtimeState: MiningRuntimeState.QUARANTINED,
        quarantined: true,
      },
    });
    if (changed.count !== 1) throw new Error('mining_delivery_terminal_state_race');

    const eventIdempotency = `command-delivery-terminal:${command.id}:${command.status}`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningRuntimeEvent" (
        "id","resourceId","eventType","stateBefore","stateAfter",
        "idempotencyKey","agentCounter","payload","occurredAt","createdAt"
      ) VALUES (
        ${stableId('mre', command.id, command.status, eventType)}, ${identity.resourceId},
        ${eventType}::"MiningEventType", ${current.runtimeState}::"MiningRuntimeState",
        'QUARANTINED'::"MiningRuntimeState", ${eventIdempotency}, 0,
        ${JSON.stringify({
          commandId: command.id,
          deliveryStatus: command.status,
          detailCode: reason,
          fenceValid: identity.fenceValid,
          hardwareIdentityMatches,
        })}::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ) ON CONFLICT ("idempotencyKey") DO NOTHING
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningAuditLog" (
        "id","machineId","resourceId","actorType","actorId","action","nextValue","createdAt"
      ) VALUES (
        ${crypto.randomUUID()}, ${command.machineId}, ${identity.resourceId},
        'SYSTEM'::"MiningAuditActorType", 'delivery-worker',
        'mining_delivery_terminal_without_ack',
        ${JSON.stringify({
          commandId: command.id,
          deliveryStatus: command.status,
          state: MiningRuntimeState.QUARANTINED,
          detailCode: reason,
          fenceValid: identity.fenceValid,
          hardwareIdentityMatches,
        })}::jsonb,
        CURRENT_TIMESTAMP
      )
    `);
    return 'QUARANTINED' as const;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}

export async function reconcileTerminalMiningCommands(
  db: PrismaClient,
  requestedLimit = 32,
): Promise<MiningTerminalReconciliation> {
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 1;
  const commands = await db.$queryRaw<TerminalMiningDeliveryRow[]>(Prisma.sql`
    SELECT command."id", command."machineId", command."commandType",
           command."payload", command."status", command."sequence"
      FROM "MachineCommand" command
      JOIN "MiningResource" resource
        ON resource."id" = command."payload" -> 'payload' ->> 'resourceId'
       AND resource."machineId" = command."machineId"
     WHERE command."commandType" IN ('start_mining', 'stop_mining')
       AND command."status" IN ('DEAD', 'EXPIRED')
       AND jsonb_typeof(command."payload" -> 'payload') = 'object'
       AND (
         (
           command."commandType" = 'start_mining'
           AND resource."runtimeState" = 'STARTING'::"MiningRuntimeState"
           AND resource."activeRentalId" IS NULL
         )
         OR
         (
           command."commandType" = 'stop_mining'
           AND resource."runtimeState" = 'VERIFYING_STOP'::"MiningRuntimeState"
         )
       )
     ORDER BY command."sequence"
     LIMIT ${limit}
  `);

  let quarantined = 0;
  let superseded = 0;
  for (const command of commands) {
    const result = await finalizeMiningDeliveryTerminal(db, command);
    if (result === 'QUARANTINED') quarantined += 1;
    else superseded += 1;
  }
  return { quarantined, superseded };
}

