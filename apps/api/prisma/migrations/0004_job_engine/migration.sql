CREATE TYPE "JobType" AS ENUM ('GPU_DIAGNOSTIC');
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'QUEUED', 'ASSIGNED', 'DOWNLOADING', 'PREPARING', 'RUNNING', 'UPLOADING_RESULTS', 'COMPLETED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'QUARANTINED');

CREATE TABLE "Job" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "renterId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "parameters" JSONB NOT NULL,
  "result" JSONB,
  "errorCode" TEXT,
  "cancelRequestedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "JobAttempt" (
  "id" TEXT NOT NULL, "jobId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "agentVersion" TEXT, "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3), "exitCode" INTEGER, "failureReason" TEXT,
  CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "JobLog" (
  "id" TEXT NOT NULL, "jobId" TEXT NOT NULL, "level" VARCHAR(16) NOT NULL,
  "message" VARCHAR(2000) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobLog_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "JobArtifact" (
  "id" TEXT NOT NULL, "jobId" TEXT NOT NULL, "kind" VARCHAR(32) NOT NULL,
  "sha256" VARCHAR(64) NOT NULL, "sizeBytes" INTEGER NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobArtifact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Job_renterId_createdAt_idx" ON "Job"("renterId", "createdAt");
CREATE INDEX "Job_machineId_status_createdAt_idx" ON "Job"("machineId", "status", "createdAt");
CREATE UNIQUE INDEX "JobAttempt_jobId_sequence_key" ON "JobAttempt"("jobId", "sequence");
CREATE INDEX "JobLog_jobId_createdAt_idx" ON "JobLog"("jobId", "createdAt");
CREATE INDEX "JobArtifact_jobId_createdAt_idx" ON "JobArtifact"("jobId", "createdAt");
ALTER TABLE "Job" ADD CONSTRAINT "Job_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_renterId_fkey" FOREIGN KEY ("renterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobLog" ADD CONSTRAINT "JobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobArtifact" ADD CONSTRAINT "JobArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
