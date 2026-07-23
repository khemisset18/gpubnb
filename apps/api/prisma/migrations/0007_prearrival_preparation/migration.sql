ALTER TYPE "JobType" ADD VALUE 'WORKSPACE_PREPARE';
ALTER TABLE "WorkspaceSession"
  ADD COLUMN "preparationProgress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "preparationStep" VARCHAR(80),
  ADD COLUMN "preparationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "preparationStartedAt" TIMESTAMP(3),
  ADD COLUMN "preparationCompletedAt" TIMESTAMP(3),
  ADD COLUMN "readyDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "preparationAttempts" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "WorkspaceSession_status_readyDeadlineAt_idx" ON "WorkspaceSession"("status","readyDeadlineAt");
CREATE UNIQUE INDEX "WorkspaceSession_bookingId_key" ON "WorkspaceSession"("bookingId");
