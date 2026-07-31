-- GPUbnb mining persistence. Rental allocation always has scheduling priority.
CREATE TYPE "MiningResourceKind" AS ENUM ('CPU', 'GPU');
CREATE TYPE "MiningMode" AS ENUM ('DISABLED', 'GPUBNB_MANAGED', 'OWNER_POOL');
CREATE TYPE "MiningRuntimeState" AS ENUM (
  'IDLE',
  'STARTING',
  'MINING',
  'PREEMPTING',
  'VERIFYING_STOP',
  'RENTAL_BLOCKED',
  'STOPPED',
  'QUARANTINED',
  'EMERGENCY_STOPPED'
);
CREATE TYPE "MiningEventType" AS ENUM (
  'CONFIGURATION_CHANGED',
  'START_REQUESTED',
  'STARTED',
  'STOP_REQUESTED',
  'STOP_VERIFIED',
  'STOP_FAILED',
  'RENTAL_PREEMPTED',
  'RENTAL_RELEASED',
  'CLEANUP_VERIFIED',
  'AUTO_RESUME_REQUESTED',
  'QUARANTINED',
  'EMERGENCY_STOPPED',
  'HEARTBEAT'
);
CREATE TYPE "MiningAuditActorType" AS ENUM ('OWNER', 'AGENT', 'PLATFORM', 'SYSTEM');

CREATE TABLE "MiningResource" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "kind" "MiningResourceKind" NOT NULL,
  "resourceKey" VARCHAR(200) NOT NULL,
  "displayName" VARCHAR(200) NOT NULL,
  "acceleratorId" TEXT,
  "cpuPackageIndex" INTEGER,
  "cpuLogicalCores" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "quarantined" BOOLEAN NOT NULL DEFAULT false,
  "runtimeState" "MiningRuntimeState" NOT NULL DEFAULT 'IDLE',
  "activeRentalId" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MiningResource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MiningResource_kind_identity_check" CHECK (
    ("kind" = 'GPU' AND "acceleratorId" IS NOT NULL AND "cpuPackageIndex" IS NULL)
    OR
    ("kind" = 'CPU' AND "acceleratorId" IS NULL AND "cpuPackageIndex" IS NOT NULL)
  )
);

CREATE TABLE "MiningConfiguration" (
  "id" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "mode" "MiningMode" NOT NULL DEFAULT 'DISABLED',
  "profileId" VARCHAR(96),
  "walletAddress" VARCHAR(160),
  "workerName" VARCHAR(64) NOT NULL,
  "ownerPoolEndpoint" VARCHAR(300),
  "ownerPoolSecretRef" VARCHAR(200),
  "autoResumeAfterRental" BOOLEAN NOT NULL DEFAULT true,
  "maximumTemperatureC" INTEGER,
  "maximumPowerWatts" INTEGER,
  "maximumCpuPercent" INTEGER,
  "cpuThreadCount" INTEGER,
  "gpuIntensityPercent" INTEGER,
  "platformFeeBasisPoints" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MiningConfiguration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MiningConfiguration_fee_check" CHECK (
    ("mode" = 'GPUBNB_MANAGED' AND "platformFeeBasisPoints" = 100)
    OR
    ("mode" <> 'GPUBNB_MANAGED' AND "platformFeeBasisPoints" = 0)
  ),
  CONSTRAINT "MiningConfiguration_owner_pool_check" CHECK (
    ("mode" = 'OWNER_POOL' AND "ownerPoolEndpoint" IS NOT NULL)
    OR
    ("mode" <> 'OWNER_POOL')
  ),
  CONSTRAINT "MiningConfiguration_limits_check" CHECK (
    ("maximumTemperatureC" IS NULL OR "maximumTemperatureC" BETWEEN 50 AND 95)
    AND ("maximumPowerWatts" IS NULL OR "maximumPowerWatts" BETWEEN 25 AND 1500)
    AND ("maximumCpuPercent" IS NULL OR "maximumCpuPercent" BETWEEN 1 AND 100)
    AND ("cpuThreadCount" IS NULL OR "cpuThreadCount" BETWEEN 1 AND 1024)
    AND ("gpuIntensityPercent" IS NULL OR "gpuIntensityPercent" BETWEEN 1 AND 100)
  )
);

CREATE TABLE "MiningRuntimeEvent" (
  "id" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "eventType" "MiningEventType" NOT NULL,
  "stateBefore" "MiningRuntimeState",
  "stateAfter" "MiningRuntimeState" NOT NULL,
  "reservationId" TEXT,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "agentCounter" BIGINT,
  "payload" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MiningRuntimeEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MiningAuditLog" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "resourceId" TEXT,
  "configurationId" TEXT,
  "actorType" "MiningAuditActorType" NOT NULL,
  "actorId" VARCHAR(160) NOT NULL,
  "action" VARCHAR(120) NOT NULL,
  "requestId" VARCHAR(160),
  "ipAddressHash" VARCHAR(128),
  "previousValue" JSONB,
  "nextValue" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MiningAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MiningResource_machineId_resourceKey_key" ON "MiningResource"("machineId", "resourceKey");
CREATE UNIQUE INDEX "MiningResource_acceleratorId_key" ON "MiningResource"("acceleratorId");
CREATE INDEX "MiningResource_machineId_kind_idx" ON "MiningResource"("machineId", "kind");
CREATE INDEX "MiningResource_runtimeState_idx" ON "MiningResource"("runtimeState");
CREATE UNIQUE INDEX "MiningConfiguration_resourceId_key" ON "MiningConfiguration"("resourceId");
CREATE INDEX "MiningConfiguration_mode_idx" ON "MiningConfiguration"("mode");
CREATE UNIQUE INDEX "MiningRuntimeEvent_idempotencyKey_key" ON "MiningRuntimeEvent"("idempotencyKey");
CREATE INDEX "MiningRuntimeEvent_resourceId_occurredAt_idx" ON "MiningRuntimeEvent"("resourceId", "occurredAt");
CREATE INDEX "MiningRuntimeEvent_reservationId_idx" ON "MiningRuntimeEvent"("reservationId");
CREATE INDEX "MiningAuditLog_machineId_createdAt_idx" ON "MiningAuditLog"("machineId", "createdAt");
CREATE INDEX "MiningAuditLog_resourceId_createdAt_idx" ON "MiningAuditLog"("resourceId", "createdAt");

ALTER TABLE "MiningResource"
  ADD CONSTRAINT "MiningResource_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MiningResource"
  ADD CONSTRAINT "MiningResource_acceleratorId_fkey"
  FOREIGN KEY ("acceleratorId") REFERENCES "Accelerator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MiningConfiguration"
  ADD CONSTRAINT "MiningConfiguration_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "MiningResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MiningRuntimeEvent"
  ADD CONSTRAINT "MiningRuntimeEvent_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "MiningResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MiningAuditLog"
  ADD CONSTRAINT "MiningAuditLog_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MiningAuditLog"
  ADD CONSTRAINT "MiningAuditLog_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "MiningResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MiningAuditLog"
  ADD CONSTRAINT "MiningAuditLog_configurationId_fkey"
  FOREIGN KEY ("configurationId") REFERENCES "MiningConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
