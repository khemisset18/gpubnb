import type { PrismaClient } from '@prisma/client';
import {
  DELIVERY_LIMITS,
  clampBatchSize,
  clampLeaseSeconds,
  payloadHash,
  retryDelaySeconds,
  shouldDeadLetter,
  validateDeliveryKey,
  validateMachineCommand,
  validateOutboxEnvelope,
  type MachineCommandEnvelope,
  type OutboxEnvelope,
} from './reliable-delivery.js';

export interface ClaimedOutboxEvent extends OutboxEnvelope {
  status: 'LEASED';
  attempts: number;
  availableAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
  createdAt: Date;
}

export interface ClaimedMachineCommand extends MachineCommandEnvelope {
  status: 'LEASED';
  attempts: number;
  availableAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
  createdAt: Date;
}

export interface DeliveryBacklog {
  pendingOutbox: bigint;
  leasedOutbox: bigint;
  deadOutbox: bigint;
  pendingCommands: bigint;
  leasedCommands: bigint;
  deadCommands: bigint;
  expiredCommands: bigint;
  oldestOutboxAgeSeconds: number;
}

type SqlClient = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>;

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000) || 'delivery_failed';
}

export async function appendOutboxEvent(client: SqlClient, envelope: OutboxEnvelope): Promise<void> {
  const event = validateOutboxEnvelope(envelope);
  const headers = event.headers ?? {};
  await client.$executeRaw`
    INSERT INTO "OutboxEvent" (
      "id", "topic", "aggregateType", "aggregateId", "eventType", "payload",
      "headers", "idempotencyKey", "partitionKey"
    ) VALUES (
      ${event.id}, ${event.topic}, ${event.aggregateType}, ${event.aggregateId}, ${event.eventType},
      ${JSON.stringify(event.payload)}::jsonb, ${JSON.stringify(headers)}::jsonb,
      ${event.idempotencyKey}, ${event.partitionKey}
    )
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
}

export async function enqueueMachineCommand(client: SqlClient, command: MachineCommandEnvelope): Promise<void> {
  const item = validateMachineCommand(command);
  await client.$executeRaw`
    INSERT INTO "MachineCommand" (
      "id", "machineId", "commandType", "payload", "idempotencyKey", "sequence", "expiresAt"
    ) VALUES (
      ${item.id}, ${item.machineId}, ${item.commandType}, ${JSON.stringify(item.payload)}::jsonb,
      ${item.idempotencyKey}, ${item.sequence}, ${item.expiresAt}
    )
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
}

export async function nextMachineSequence(client: SqlClient, machineId: string): Promise<bigint> {
  validateDeliveryKey(machineId, 'command_machine_id');
  const rows = await client.$queryRaw<Array<{ sequence: bigint }>>`
    SELECT COALESCE(MAX("sequence"), 0)::bigint + 1 AS "sequence"
    FROM "MachineCommand"
    WHERE "machineId" = ${machineId}
    FOR UPDATE
  `;
  return rows[0]?.sequence ?? 1n;
}

export async function claimOutboxEvents(
  client: SqlClient,
  workerId: string,
  requestedBatch = DELIVERY_LIMITS.outboxBatch,
  requestedLeaseSeconds = 30,
): Promise<ClaimedOutboxEvent[]> {
  validateDeliveryKey(workerId, 'worker_id');
  const batch = clampBatchSize(requestedBatch, DELIVERY_LIMITS.outboxBatch);
  const lease = clampLeaseSeconds(requestedLeaseSeconds, DELIVERY_LIMITS.maxOutboxLeaseSeconds);
  return client.$queryRaw<ClaimedOutboxEvent[]>`
    SELECT * FROM claim_outbox_events(${workerId}, ${batch}::integer, ${lease}::integer)
  `;
}

export async function claimMachineCommands(
  client: SqlClient,
  machineId: string,
  workerId: string,
  requestedBatch = DELIVERY_LIMITS.machineCommandBatch,
  requestedLeaseSeconds = 30,
): Promise<ClaimedMachineCommand[]> {
  validateDeliveryKey(machineId, 'command_machine_id');
  validateDeliveryKey(workerId, 'worker_id');
  const batch = clampBatchSize(requestedBatch, DELIVERY_LIMITS.machineCommandBatch);
  const lease = clampLeaseSeconds(requestedLeaseSeconds, DELIVERY_LIMITS.maxCommandLeaseSeconds);
  return client.$queryRaw<ClaimedMachineCommand[]>`
    SELECT * FROM claim_machine_commands(${machineId}, ${workerId}, ${batch}::integer, ${lease}::integer)
  `;
}

export async function markOutboxPublished(client: SqlClient, eventId: string, workerId: string): Promise<boolean> {
  validateDeliveryKey(eventId, 'outbox_id');
  validateDeliveryKey(workerId, 'worker_id');
  const changed = await client.$executeRaw`
    UPDATE "OutboxEvent"
    SET "status" = 'PUBLISHED', "publishedAt" = CURRENT_TIMESTAMP,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL
    WHERE "id" = ${eventId} AND "status" = 'LEASED' AND "leaseOwner" = ${workerId}
  `;
  return changed === 1;
}

export async function rescheduleOutboxFailure(
  client: SqlClient,
  event: Pick<ClaimedOutboxEvent, 'id' | 'attempts'>,
  workerId: string,
  error: unknown,
): Promise<'PENDING' | 'DEAD' | 'LEASE_LOST'> {
  validateDeliveryKey(event.id, 'outbox_id');
  validateDeliveryKey(workerId, 'worker_id');
  const terminal = shouldDeadLetter(event.attempts);
  const delay = retryDelaySeconds(event.attempts, event.id);
  const changed = await client.$executeRaw`
    UPDATE "OutboxEvent"
    SET "status" = ${terminal ? 'DEAD' : 'PENDING'},
        "availableAt" = CURRENT_TIMESTAMP + make_interval(secs => ${delay}),
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = ${sanitizeError(error)}
    WHERE "id" = ${event.id} AND "status" = 'LEASED' AND "leaseOwner" = ${workerId}
  `;
  if (changed !== 1) return 'LEASE_LOST';
  return terminal ? 'DEAD' : 'PENDING';
}

export async function acknowledgeMachineCommand(
  client: SqlClient,
  commandId: string,
  machineId: string,
  workerId: string,
): Promise<boolean> {
  validateDeliveryKey(commandId, 'command_id');
  validateDeliveryKey(machineId, 'command_machine_id');
  validateDeliveryKey(workerId, 'worker_id');
  const changed = await client.$executeRaw`
    UPDATE "MachineCommand"
    SET "status" = 'ACKNOWLEDGED', "acknowledgedAt" = CURRENT_TIMESTAMP,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL
    WHERE "id" = ${commandId} AND "machineId" = ${machineId}
      AND "status" = 'LEASED' AND "leaseOwner" = ${workerId}
  `;
  return changed === 1;
}

export async function recordConsumedMessage(
  client: SqlClient,
  consumer: string,
  messageId: string,
  payload: Record<string, unknown>,
): Promise<'NEW' | 'DUPLICATE'> {
  validateDeliveryKey(consumer, 'consumer');
  validateDeliveryKey(messageId, 'message_id');
  const hash = payloadHash(payload);
  const inserted = await client.$executeRaw`
    INSERT INTO "ConsumedMessage" ("consumer", "messageId", "payloadHash")
    VALUES (${consumer}, ${messageId}, ${hash})
    ON CONFLICT ("consumer", "messageId") DO NOTHING
  `;
  if (inserted === 1) return 'NEW';
  const rows = await client.$queryRaw<Array<{ payloadHash: string }>>`
    SELECT "payloadHash" FROM "ConsumedMessage"
    WHERE "consumer" = ${consumer} AND "messageId" = ${messageId}
  `;
  if (rows[0]?.payloadHash !== hash) throw new Error('consumed_message_payload_mismatch');
  return 'DUPLICATE';
}

export async function deliveryBacklog(client: SqlClient): Promise<DeliveryBacklog> {
  const rows = await client.$queryRaw<Array<DeliveryBacklog>>`
    SELECT
      COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS "pendingOutbox",
      COUNT(*) FILTER (WHERE "status" = 'LEASED')::bigint AS "leasedOutbox",
      COUNT(*) FILTER (WHERE "status" = 'DEAD')::bigint AS "deadOutbox",
      COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("createdAt") FILTER (WHERE "status" = 'PENDING'))), 0)::double precision AS "oldestOutboxAgeSeconds",
      (SELECT COUNT(*)::bigint FROM "MachineCommand" WHERE "status" = 'PENDING') AS "pendingCommands",
      (SELECT COUNT(*)::bigint FROM "MachineCommand" WHERE "status" = 'LEASED') AS "leasedCommands",
      (SELECT COUNT(*)::bigint FROM "MachineCommand" WHERE "status" = 'DEAD') AS "deadCommands",
      (SELECT COUNT(*)::bigint FROM "MachineCommand" WHERE "status" = 'EXPIRED') AS "expiredCommands"
    FROM "OutboxEvent"
  `;
  return rows[0] ?? {
    pendingOutbox: 0n,
    leasedOutbox: 0n,
    deadOutbox: 0n,
    pendingCommands: 0n,
    leasedCommands: 0n,
    deadCommands: 0n,
    expiredCommands: 0n,
    oldestOutboxAgeSeconds: 0,
  };
}
