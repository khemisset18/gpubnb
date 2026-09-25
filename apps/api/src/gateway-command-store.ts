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

const PRIOR_FAST_PATH_PREDICATE = Prisma.sql`(
  (
    prior."commandType" = 'stop_rental'
    AND prior."payload" ->> 'workspaceSlug' = 'developer'
  )
  OR
  (
    prior."commandType" IN ('start_mining', 'stop_mining')
    AND jsonb_typeof(prior."payload" -> 'lease') = 'object'
    AND jsonb_typeof(prior."payload" -> 'payload') = 'object'
    AND prior."payload" -> 'lease' ->> 'resourceId'
        = prior."payload" -> 'payload' ->> 'resourceId'
    AND prior."payload" -> 'lease' ->> 'fencingToken'
        = prior."payload" -> 'payload' ->> 'runtimeGeneration'
    AND COALESCE(prior."payload" -> 'payload' ->> 'hardwareUuid', '') <> ''
  )
)`;

const NO_PRIOR_ACTIVE_FAST_PATH = Prisma.sql`NOT EXISTS (
  SELECT 1
    FROM "MachineCommand" prior
   WHERE prior."machineId" = command."machineId"
     AND prior."sequence" < command."sequence"
     AND ${PRIOR_FAST_PATH_PREDICATE}
     AND prior."status" IN ('PENDING', 'LEASED')
     AND prior."expiresAt" > CURRENT_TIMESTAMP
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
       AND ${NO_PRIOR_ACTIVE_FAST_PATH}
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
    ), candidates AS (
      SELECT command."id"
        FROM "MachineCommand" command
       WHERE command."machineId" = ${machineId}
         AND ${FAST_PATH_PREDICATE}
         AND command."expiresAt" > CURRENT_TIMESTAMP
         AND ${NO_PRIOR_ACTIVE_FAST_PATH}
         AND (
           (command."status" = 'PENDING' AND command."availableAt" <= CURRENT_TIMESTAMP)
           OR (command."status" = 'LEASED' AND command."leaseExpiresAt" <= CURRENT_TIMESTAMP)
         )
       ORDER BY command."sequence"
       LIMIT ${batch}
       FOR UPDATE SKIP LOCKED
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
