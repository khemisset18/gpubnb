-- Additive-only migration: quarantine reason codes, durable quarantine history,
-- real DiagnosticRun records, and machine registration lifecycle.
-- Hand-written (not `prisma migrate dev`) to avoid touching pre-existing,
-- unrelated local-dev drift (legacy MachineAccelerator/OutboxEvent/etc. tables
-- present on this dev database but already absent from schema.prisma before
-- this change) - this migration only adds new types/columns/tables.

-- CreateEnum
CREATE TYPE "QuarantineReasonCode" AS ENUM ('CRITICAL_GPU_IDENTITY_CHANGE', 'DIAGNOSTIC_COMPLETION_RACE', 'STALE_CLAIM', 'STALE_JOB', 'WORKSPACE_CLEANUP_FAILED', 'AGENT_SECURITY_FAILURE', 'GPU_HEALTH_CHECK_FAILED', 'GPU_UNAVAILABLE', 'DOCKER_UNAVAILABLE', 'NVIDIA_RUNTIME_UNAVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "QuarantineEventStatus" AS ENUM ('ENTERED', 'DIAGNOSTIC', 'CLEARED', 'REENTERED');

-- CreateEnum
CREATE TYPE "DiagnosticRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "DiagnosticTrigger" AS ENUM ('OWNER', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "MachineLifecycleStatus" AS ENUM ('ACTIVE', 'STALE', 'OFFLINE', 'RETIRED');

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN "quarantineReasonCode" "QuarantineReasonCode",
ADD COLUMN "quarantinedAt" TIMESTAMP(3),
ADD COLUMN "lastDiagnosticRunId" TEXT,
ADD COLUMN "lastDiagnosticAt" TIMESTAMP(3),
ADD COLUMN "lifecycleStatus" "MachineLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "retiredAt" TIMESTAMP(3),
ADD COLUMN "retiredReason" VARCHAR(500);

-- CreateTable
CREATE TABLE "DiagnosticRun" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" "DiagnosticRunStatus" NOT NULL DEFAULT 'RUNNING',
    "checks" JSONB,
    "triggeredBy" "DiagnosticTrigger" NOT NULL,
    "triggeredById" TEXT,
    "error" VARCHAR(500),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DiagnosticRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineQuarantineEvent" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" "QuarantineEventStatus" NOT NULL,
    "reasonCode" "QuarantineReasonCode" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "details" JSONB,
    "source" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "diagnosticRunId" TEXT,

    CONSTRAINT "MachineQuarantineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiagnosticRun_machineId_startedAt_idx" ON "DiagnosticRun"("machineId", "startedAt");

-- CreateIndex
CREATE INDEX "DiagnosticRun_machineId_status_idx" ON "DiagnosticRun"("machineId", "status");

-- CreateIndex
CREATE INDEX "MachineQuarantineEvent_machineId_createdAt_idx" ON "MachineQuarantineEvent"("machineId", "createdAt");

-- AddForeignKey
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineQuarantineEvent" ADD CONSTRAINT "MachineQuarantineEvent_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineQuarantineEvent" ADD CONSTRAINT "MachineQuarantineEvent_diagnosticRunId_fkey" FOREIGN KEY ("diagnosticRunId") REFERENCES "DiagnosticRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
