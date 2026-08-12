-- Explicit, nullable execution leases allow a zero-downtime rollout: existing active
-- jobs keep working until they are reclaimed, while every new claim receives a fenced
-- attempt immediately. The token itself is never persisted; only its SHA-256 digest is.
ALTER TABLE "Job"
  ADD COLUMN "currentAttemptId" TEXT,
  ADD COLUMN "leaseTokenHash" VARCHAR(64),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "lastAgentReportAt" TIMESTAMP(3);

CREATE INDEX "Job_status_leaseExpiresAt_idx"
  ON "Job"("status", "leaseExpiresAt");

CREATE INDEX "Job_machineId_currentAttemptId_idx"
  ON "Job"("machineId", "currentAttemptId");
