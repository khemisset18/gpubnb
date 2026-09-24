import crypto from 'node:crypto';

import { MiningRuntimeState, Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import type { ClaimedMachineCommand } from './delivery-store.js';
import type { TerminalGatewayAck } from './control-command-dispatch.js';
import { releaseResourceLease } from './resource-lease.js';

type DurableMiningPayload = {
  lease: { resourceId: string; holderId: string; leaseId: string; fencingToken: string };
  payload: Record<string, unknown>;
};

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}

function parseDurableMiningPayload(command: ClaimedMachineCommand): DurableMiningPayload {
  const outer = command.payload as Record<string, unknown>;
  const lease = outer.lease;
  const payload = outer.payload;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error('mining_command_lease_invalid');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('mining_command_payload_invalid');
  const l = lease as Record<string, unknown>;
  const p = payload as Record<string, unknown>;
  for (const key of ['resourceId', 'holderId', 'leaseId', 'fencingToken']) {
    if (typeof l[key] !== 'string' || !l[key]) throw new Error('mining_command_lease_invalid');
  }
  if (typeof p.resourceId !== 'string' || p.resourceId !== l.resourceId) throw new Error('mining_command_fence_mismatch');
  if (typeof p.runtimeGeneration !== 'string' || p.runtimeGeneration !== l.fencingToken) throw new Error('mining_command_fence_mismatch');
  return {
    lease: {
      resourceId: String(l.resourceId),
      holderId: String(l.holderId),
      leaseId: String(l.leaseId),
      fencingToken: String(l.fencingToken),
    },
    payload: p,
  };
}

export async function finalizeMiningTerminalAck(
  db: PrismaClient,
  redis: Redis,
  command: ClaimedMachineCommand,
  ack: TerminalGatewayAck,
): Promise<void> {
  if (command.commandType !== 'start_mining' && command.commandType !== 'stop_mining') return;
  const durable = parseDurableMiningPayload(command);
  const isStart = command.commandType === 'start_mining';
  const succeeded = ack.status === 'SUCCEEDED';
  const nextState = succeeded
    ? (isStart ? MiningRuntimeState.MINING : MiningRuntimeState.STOPPED)
    : (isStart ? MiningRuntimeState.STOPPED : MiningRuntimeState.QUARANTINED);
  const eventType = succeeded
    ? (isStart ? 'STARTED' : 'STOP_VERIFIED')
    : (isStart ? 'START_FAILED' : 'STOP_FAILED');
  const eventIdempotency = `command-terminal:${command.id}:${eventType}`;

  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ runtimeState: MiningRuntimeState; activeRentalId: string | null }>>(Prisma.sql`
      SELECT "runtimeState", "activeRentalId" FROM "MiningResource"
       WHERE "id" = ${durable.lease.resourceId} AND "machineId" = ${command.machineId}
       FOR UPDATE
    `);
    const current = rows[0];
    if (!current) throw new Error('mining_resource_not_found');
    const expectedState = isStart ? MiningRuntimeState.STARTING : MiningRuntimeState.VERIFYING_STOP;
    const stateStillOwned = current.runtimeState === expectedState
      && (!isStart || current.activeRentalId === null);

    if (!stateStillOwned) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningAuditLog" (
          "id", "machineId", "resourceId", "actorType", "actorId",
          "action", "nextValue", "createdAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${command.machineId}, ${durable.lease.resourceId},
          'SYSTEM'::"MiningAuditActorType", 'delivery-worker',
          'mining_terminal_ack_superseded',
          ${JSON.stringify({
            commandId: command.id,
            ackStatus: ack.status,
            detailCode: ack.detailCode ?? null,
            currentState: current.runtimeState,
            activeRental: current.activeRentalId !== null,
          })}::jsonb,
          CURRENT_TIMESTAMP
        )
      `);
      return;
    }

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningRuntimeEvent" (
        "id", "resourceId", "eventType", "stateBefore", "stateAfter",
        "idempotencyKey", "payload", "occurredAt", "createdAt"
      ) VALUES (
        ${stableId('mre', command.id, eventType)}, ${durable.lease.resourceId}, ${eventType}::"MiningEventType",
        ${current.runtimeState}::"MiningRuntimeState", ${nextState}::"MiningRuntimeState",
        ${eventIdempotency},
        ${JSON.stringify({ commandId: command.id, ackStatus: ack.status, detailCode: ack.detailCode ?? null })}::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("idempotencyKey") DO NOTHING
    `);

    const changed = await tx.miningResource.updateMany({
      where: {
        id: durable.lease.resourceId,
        machineId: command.machineId,
        runtimeState: expectedState,
        ...(isStart ? { activeRentalId: null } : {}),
      },
      data: { runtimeState: nextState },
    });
    if (changed.count !== 1) throw new Error('mining_terminal_state_race');

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MiningAuditLog" (
        "id", "machineId", "resourceId", "actorType", "actorId",
        "action", "nextValue", "createdAt"
      ) VALUES (
        ${crypto.randomUUID()}, ${command.machineId}, ${durable.lease.resourceId},
        'SYSTEM'::"MiningAuditActorType", 'delivery-worker',
        ${succeeded
          ? (isStart ? 'mining_start_verified' : 'mining_stop_verified')
          : (isStart ? 'mining_start_failed' : 'mining_stop_failed')},
        ${JSON.stringify({ commandId: command.id, state: nextState, detailCode: ack.detailCode ?? null })}::jsonb,
        CURRENT_TIMESTAMP
      )
    `);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });

  if ((isStart && !succeeded) || (!isStart && succeeded)) {
    const released = await releaseResourceLease(redis, durable.lease);
    if (!released.accepted && released.reason !== 'MISSING' && released.reason !== 'STALE_LEASE') {
      throw new Error('mining_resource_lease_release_failed');
    }
  }
}