import { Prisma, type PrismaClient } from '@prisma/client';

import { DELIVERY_LIMITS, clampBatchSize, clampLeaseSeconds, validateDeliveryKey } from './reliable-delivery.js';
import type { ClaimedMachineCommand } from './delivery-store.js';

// Production fast path accepts direct Developer stop plus mining commands only
// when their durable representation already contains an exact resource lease
// whose resource/fence matches the inner Agent payload. The TypeScript dispatcher
// performs the complete structural validation before sending anything.
const FAST_PATH_PREDICATE = Prisma.sql`(
  (
    command."commandType" = 'stop_rental'
    AND command."payload" ->> 'workspaceSlug' = 'developer'
  )
  OR
  (
    command."commandType" IN ('start_mining', 'stop_mining')
    AND jsonb_typeof(command."payload" -> 'lease') = 'object'
    AND jsonb_typeof(command."payload" -> 'payload') = 'object'
    AND command."payload" -> 'lease' ->> 'resourceId'
        = command."payload" -> 'payload' ->> 'resourceId'
    AND command."payload" -> 'lease' ->> 'fencingToken'
        = command."payload" -> 'payload' ->> 'runtimeGeneration'
    AND COALESCE(command."payload" -> 'payload' ->> 'hardwareUuid', '') <> ''
  )
)`;

export function productionGatewayCommandEligible(
  commandType: string,
  payload: Record<string, unknown>,
): boolean {
  if (commandType === 'stop_rental') return payload.workspaceSlug === 'developer';
  if (commandType !== 'start_mining' && commandType !== 'stop_mining') return false;
  const lease = payload.lease;
  const inner = payload.payload;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return false;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return false;
  const l = lease as Record<string, unknown>;
  const p = inner as Record<string, unknown>;
  return typeof l.resourceId === 'string'
    && l.resourceId === p.resourceId
    && typeof l.fencingToken === 'string'
    && l.fencingToken === p.runtimeGeneration
    && typeof p.hardwareUuid === 'string'
    && p.hardwareUuid.length > 0;
}

export async function gatewayCommandMachineIds(
  db: PrismaClient,
  requestedLimit = DELIVERY_LIMITS.machineCommandBatch,
): Promise<string[]> {
  const limit = clampBatchSize(requestedLimit, DELIVERY_LIMITS.machineCommandBatch);
  const rows = await db.$queryRaw<Array<{ machineId: string }>>(Prisma.sql`
    SELECT DISTINCT command."machineId"
      FROM "MachineCommand" command
     WHERE ${FAST_PATH_PREDICATE}
       AND command."expiresAt" > CURRENT_TIMESTAMP
       AND (
         (command."status" = 'PENDING' AND command."availableAt" <= CURRENT_TIMESTAMP)
         OR (command."status" = 'LEASED' AND command."leaseExpiresAt" <= CURRENT_TIMESTAMP)
       )
     ORDER BY command."machineId"
     LIMIT ${limit}
  `);
  return rows.map((row) => row.machineId);
}

export async function claimGatewayMachineCommands(
  db: PrismaClient,
  machineId: string,
  workerId: string,
  requestedBatch = 16,
  requestedLeaseSeconds = 15,
): Promise<ClaimedMachineCommand[]> {
  validateDeliveryKey(machineId, 'command_machine_id');
  validateDeliveryKey(workerId, 'worker_id');
  const batch = clampBatchSize(requestedBatch, DELIVERY_LIMITS.machineCommandBatch);
  const claimLimit = Math.min(batch, 1);
  const lease = clampLeaseSeconds(requestedLeaseSeconds, DELIVERY_LIMITS.maxCommandLeaseSeconds);
  return db.$queryRaw<ClaimedMachineCommand[]>(Prisma.sql`
    WITH expired AS (
      UPDATE "MachineCommand" command
         SET "status" = 'EXPIRED', "lastError" = 'command_expired',
             "leaseOwner" = NULL, "leaseExpiresAt" = NULL
       WHERE command."machineId" = ${machineId}
         AND ${FAST_PATH_PREDICATE}
         AND command."status" IN ('PENDING', 'LEASED')
         AND command."expiresAt" <= CURRENT_TIMESTAMP
      RETURNING command."id"
    ), eligible AS MATERIALIZED (
      SELECT command."id", command."commandType", command."sequence", command."status",
             command."availableAt", command."leaseExpiresAt"
        FROM "MachineCommand" command
       WHERE command."machineId" = ${machineId}
         AND ${FAST_PATH_PREDICATE}
         AND command."expiresAt" > CURRENT_TIMESTAMP
         AND command."status" IN ('PENDING', 'LEASED')
    ), candidates AS (
      SELECT command."id"
        FROM "MachineCommand" command
        JOIN eligible current_command ON current_command."id" = command."id"
       WHERE (
         (current_command."status" = 'PENDING' AND current_command."availableAt" <= CURRENT_TIMESTAMP)
         OR (current_command."status" = 'LEASED' AND current_command."leaseExpiresAt" <= CURRENT_TIMESTAMP)
       )
         AND NOT EXISTS (
           SELECT 1
             FROM eligible earlier_command
            WHERE earlier_command."sequence" < current_command."sequence"
              AND (
                current_command."commandType" <> 'stop_rental'
                OR earlier_command."commandType" = 'stop_rental'
              )
         )
       ORDER BY current_command."sequence"
       LIMIT ${claimLimit}
       FOR UPDATE OF command SKIP LOCKED
    )
    UPDATE "MachineCommand" command
       SET "status" = 'LEASED', "leaseOwner" = ${workerId},
           "leaseExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => ${lease}),
           "attempts" = command."attempts" + 1
      FROM candidates
     WHERE command."id" = candidates."id"
    RETURNING command.*
  `);
}
