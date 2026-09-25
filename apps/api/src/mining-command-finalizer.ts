import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import type { TerminalGatewayAck } from './control-command-dispatch.js';
import type { ClaimedMachineCommand } from './delivery-store.js';
import { releaseResourceLease } from './resource-lease.js';

type MiningCommandType = 'start_mining' | 'stop_mining';

type DurableMiningPayload = {
  lease: { resourceId: string; holderId: string; leaseId: string; fencingToken: string };
  payload: { resourceId: string; hardwareUuid: string; runtimeGeneration: string };
};

function parseDurableMiningPayload(command: ClaimedMachineCommand): DurableMiningPayload {
  if (command.commandType !== 'start_mining' && command.commandType !== 'stop_mining') {
    throw new Error('mining_terminal_command_type_invalid');
  }
  const outer = command.payload;
  const lease = outer.lease;
  const payload = outer.payload;
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
      resourceId: l.resourceId as string,
      holderId: l.holderId as string,
      leaseId: l.leaseId as string,
      fencingToken: l.fencingToken as string,
    },
    payload: {
      resourceId: p.resourceId,
      hardwareUuid: p.hardwareUuid,
      runtimeGeneration: p.runtimeGeneration,
    },
  };
}

function targetState(commandType: MiningCommandType, ack: TerminalGatewayAck): {
  expected: 'STARTING' | 'VERIFYING_STOP';
  next: 'MINING' | 'STOPPED' | 'QUARANTINED';
  quarantine: boolean;
} {
  if (commandType === 'start_mining') {
    if (ack.status === 'SUCCEEDED') return { expected: 'STARTING', next: 'MINING', quarantine: false };
    if (ack.status === 'REJECTED') return { expected: 'STARTING', next: 'STOPPED', quarantine: false };
    return { expected: 'STARTING', next: 'QUARANTINED', quarantine: true };
  }
  if (ack.status === 'SUCCEEDED') return { expected: 'VERIFYING_STOP', next: 'STOPPED', quarantine: false };
  return { expected: 'VERIFYING_STOP', next: 'QUARANTINED', quarantine: true };
}

export async function finalizeMiningTerminalAck(
  db: PrismaClient,
  redis: Redis,
  command: ClaimedMachineCommand,
  ack: TerminalGatewayAck,
): Promise<'UPDATED' | 'STALE_STATE'> {
  const commandType = command.commandType as MiningCommandType;
  const durable = parseDurableMiningPayload(command);
  const target = targetState(commandType, ack);
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "MiningResource" AS r
       SET "runtimeState" = ${target.next}::"MiningRuntimeState",
           "quarantined" = CASE WHEN ${target.quarantine} THEN true ELSE r."quarantined" END,
           "updatedAt" = CURRENT_TIMESTAMP
      FROM "Accelerator" AS a
     WHERE r."acceleratorId" = a."id"
       AND r."id" = ${durable.payload.resourceId}
       AND r."machineId" = ${command.machineId}
       AND a."hardwareUuid" = ${durable.payload.hardwareUuid}
       AND r."runtimeState" = ${target.expected}::"MiningRuntimeState"
    RETURNING r."id"
  `);

  const release = await releaseResourceLease(redis, durable.lease).catch(() => null);
  if (release && !release.accepted && release.reason !== 'MISSING' && release.reason !== 'STALE_LEASE') {
    throw new Error('mining_terminal_lease_release_failed');
  }
  return rows[0]?.id ? 'UPDATED' : 'STALE_STATE';
}