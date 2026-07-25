-- Reliable delivery primitives for horizontally scaled workers.
-- Rows are claimed with short leases and FOR UPDATE SKIP LOCKED so workers never block each other.

CREATE TABLE "OutboxEvent" (
    "id" TEXT PRIMARY KEY,
    "topic" VARCHAR(120) NOT NULL,
    "aggregateType" VARCHAR(80) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "eventType" VARCHAR(120) NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "partitionKey" VARCHAR(160) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMPTZ,
    "publishedAt" TIMESTAMPTZ,
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxEvent_status_check" CHECK ("status" IN ('PENDING', 'LEASED', 'PUBLISHED', 'DEAD')),
    CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 100),
    CONSTRAINT "OutboxEvent_payload_object_check" CHECK (jsonb_typeof("payload") = 'object')
);

CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");
CREATE INDEX "OutboxEvent_claim_idx" ON "OutboxEvent"("status", "availableAt", "createdAt");
CREATE INDEX "OutboxEvent_lease_idx" ON "OutboxEvent"("status", "leaseExpiresAt");
CREATE INDEX "OutboxEvent_aggregate_idx" ON "OutboxEvent"("aggregateType", "aggregateId", "createdAt");
CREATE INDEX "OutboxEvent_partition_idx" ON "OutboxEvent"("partitionKey", "createdAt");

CREATE TABLE "MachineCommand" (
    "id" TEXT PRIMARY KEY,
    "machineId" TEXT NOT NULL,
    "commandType" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "leaseOwner" VARCHAR(128),
    "leaseExpiresAt" TIMESTAMPTZ,
    "acknowledgedAt" TIMESTAMPTZ,
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineCommand_status_check" CHECK ("status" IN ('PENDING', 'LEASED', 'ACKNOWLEDGED', 'EXPIRED', 'DEAD')),
    CONSTRAINT "MachineCommand_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 100),
    CONSTRAINT "MachineCommand_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "MachineCommand_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "MachineCommand_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MachineCommand_idempotencyKey_key" ON "MachineCommand"("idempotencyKey");
CREATE UNIQUE INDEX "MachineCommand_machine_sequence_key" ON "MachineCommand"("machineId", "sequence");
CREATE INDEX "MachineCommand_claim_idx" ON "MachineCommand"("machineId", "status", "availableAt", "sequence");
CREATE INDEX "MachineCommand_expiry_idx" ON "MachineCommand"("status", "expiresAt");
CREATE INDEX "MachineCommand_lease_idx" ON "MachineCommand"("status", "leaseExpiresAt");

CREATE TABLE "ConsumedMessage" (
    "consumer" VARCHAR(120) NOT NULL,
    "messageId" VARCHAR(160) NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "processedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("consumer", "messageId")
);

CREATE INDEX "ConsumedMessage_processedAt_idx" ON "ConsumedMessage"("processedAt");

-- Atomically claim an outbox batch. The caller must run this inside a short transaction.
CREATE OR REPLACE FUNCTION claim_outbox_events(
    worker_id TEXT,
    batch_size INTEGER,
    lease_seconds INTEGER
)
RETURNS SETOF "OutboxEvent"
LANGUAGE sql
AS $$
    WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE (
            ("status" = 'PENDING' AND "availableAt" <= CURRENT_TIMESTAMP)
            OR ("status" = 'LEASED' AND "leaseExpiresAt" <= CURRENT_TIMESTAMP)
        )
        ORDER BY "availableAt", "createdAt"
        LIMIT LEAST(GREATEST(batch_size, 1), 500)
        FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxEvent" AS event
    SET "status" = 'LEASED',
        "leaseOwner" = worker_id,
        "leaseExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => LEAST(GREATEST(lease_seconds, 5), 300)),
        "attempts" = event."attempts" + 1
    FROM candidates
    WHERE event."id" = candidates."id"
    RETURNING event.*;
$$;

-- Atomically claim ordered commands for one machine.
CREATE OR REPLACE FUNCTION claim_machine_commands(
    target_machine_id TEXT,
    worker_id TEXT,
    batch_size INTEGER,
    lease_seconds INTEGER
)
RETURNS SETOF "MachineCommand"
LANGUAGE sql
AS $$
    WITH expired AS (
        UPDATE "MachineCommand"
        SET "status" = 'EXPIRED', "lastError" = 'command_expired'
        WHERE "machineId" = target_machine_id
          AND "status" IN ('PENDING', 'LEASED')
          AND "expiresAt" <= CURRENT_TIMESTAMP
        RETURNING "id"
    ), candidates AS (
        SELECT command."id"
        FROM "MachineCommand" AS command
        WHERE command."machineId" = target_machine_id
          AND command."expiresAt" > CURRENT_TIMESTAMP
          AND (
              (command."status" = 'PENDING' AND command."availableAt" <= CURRENT_TIMESTAMP)
              OR (command."status" = 'LEASED' AND command."leaseExpiresAt" <= CURRENT_TIMESTAMP)
          )
        ORDER BY command."sequence"
        LIMIT LEAST(GREATEST(batch_size, 1), 100)
        FOR UPDATE SKIP LOCKED
    )
    UPDATE "MachineCommand" AS command
    SET "status" = 'LEASED',
        "leaseOwner" = worker_id,
        "leaseExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => LEAST(GREATEST(lease_seconds, 5), 120)),
        "attempts" = command."attempts" + 1
    FROM candidates
    WHERE command."id" = candidates."id"
    RETURNING command.*;
$$;
