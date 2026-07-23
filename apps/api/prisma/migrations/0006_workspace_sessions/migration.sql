CREATE TYPE "WorkspaceSessionStatus" AS ENUM ('RESERVED','PREPARING','READY','RUNNING','STOP_REQUESTED','STOPPING','COMPLETED','FAILED','CANCELLED','TIMED_OUT','QUARANTINED');
CREATE TYPE "SessionTerminationReason" AS ENUM ('USER_STOP','OWNER_EMERGENCY_STOP','PLATFORM_EMERGENCY_STOP','COMPLETED','TIMEOUT','AGENT_OFFLINE','SECURITY_POLICY','EXECUTION_FAILED');
CREATE TABLE "WorkspaceSession" (
 "id" TEXT NOT NULL, "bookingId" TEXT NOT NULL, "renterId" TEXT NOT NULL, "machineId" TEXT NOT NULL,
 "machineWorkspaceId" TEXT NOT NULL, "jobId" TEXT, "status" "WorkspaceSessionStatus" NOT NULL DEFAULT 'RESERVED',
 "isolationType" VARCHAR(32) NOT NULL, "resourceLimits" JSONB NOT NULL, "connectionType" VARCHAR(32),
 "connectionMetadata" JSONB, "lastMetricCounter" BIGINT NOT NULL DEFAULT 0, "startedAt" TIMESTAMP(3),
 "readyAt" TIMESTAMP(3), "endedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
 "terminationReason" "SessionTerminationReason", "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WorkspaceSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkspaceMetric" (
 "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "counter" BIGINT NOT NULL, "capturedAt" TIMESTAMP(3) NOT NULL,
 "intervalSeconds" INTEGER NOT NULL, "gpuUtilization" INTEGER NOT NULL, "memoryUsedMiB" INTEGER NOT NULL,
 "temperatureC" INTEGER NOT NULL, "cpuUtilization" INTEGER NOT NULL, "ramUsedMiB" INTEGER NOT NULL,
 "diskUsedMiB" INTEGER NOT NULL, "networkRxBytes" BIGINT NOT NULL, "networkTxBytes" BIGINT NOT NULL,
 "available" BOOLEAN NOT NULL, "workloadProof" BOOLEAN NOT NULL, "signatureHash" TEXT NOT NULL,
 CONSTRAINT "WorkspaceMetric_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkspaceSessionEvent" (
 "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "actorType" VARCHAR(24) NOT NULL, "actorId" TEXT,
 "action" VARCHAR(80) NOT NULL, "details" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "WorkspaceSessionEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceSession_jobId_key" ON "WorkspaceSession"("jobId");
CREATE INDEX "WorkspaceSession_renterId_createdAt_idx" ON "WorkspaceSession"("renterId","createdAt");
CREATE INDEX "WorkspaceSession_machineId_status_idx" ON "WorkspaceSession"("machineId","status");
CREATE INDEX "WorkspaceSession_bookingId_idx" ON "WorkspaceSession"("bookingId");
CREATE UNIQUE INDEX "WorkspaceMetric_signatureHash_key" ON "WorkspaceMetric"("signatureHash");
CREATE UNIQUE INDEX "WorkspaceMetric_sessionId_counter_key" ON "WorkspaceMetric"("sessionId","counter");
CREATE INDEX "WorkspaceMetric_sessionId_capturedAt_idx" ON "WorkspaceMetric"("sessionId","capturedAt");
CREATE INDEX "WorkspaceSessionEvent_sessionId_createdAt_idx" ON "WorkspaceSessionEvent"("sessionId","createdAt");
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_renterId_fkey" FOREIGN KEY ("renterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_machineWorkspaceId_fkey" FOREIGN KEY ("machineWorkspaceId") REFERENCES "MachineWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMetric" ADD CONSTRAINT "WorkspaceMetric_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkspaceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceSessionEvent" ADD CONSTRAINT "WorkspaceSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkspaceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
