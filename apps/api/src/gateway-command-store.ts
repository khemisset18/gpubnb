import { Prisma, type PrismaClient } from '@prisma/client';

import { DELIVERY_LIMITS, clampBatchSize, clampLeaseSeconds, validateDeliveryKey } from './reliable-delivery.js';
import type { ClaimedMachineCommand } from './delivery-store.js';

// v1 production fast path is intentionally limited to a runtime we can prove
// end-to-end today. Mining command kinds remain protocol/packaging dark-qualified
// until a resource-scoped miner supervisor exists.
const FAST_PATH_PREDICATE = Prisma.sql`(
  command."commandType" = 'stop_rental'
  AND command."payload" ->> 'workspaceSlug' = 'developer'
)`;

export function productionGatewayCommandEligible(
  commandType: string,
  payload: Record<string, unknown>,
): boolean {
  return commandType === 'stop_rental' && payload.workspaceSlug === 'developer';
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
