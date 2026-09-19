-- Persist the runtime selected for a Workspace session so a session can never
-- silently cross from the qualified container/Selkies backend into the separate
-- Windows-native authority boundary (or vice versa) after reservation.
CREATE TYPE "WorkspaceRuntimeBackend" AS ENUM ('CONTAINER', 'WINDOWS_NATIVE');

ALTER TABLE "WorkspaceSession"
ADD COLUMN "runtimeBackend" "WorkspaceRuntimeBackend" NOT NULL DEFAULT 'CONTAINER';

CREATE INDEX "WorkspaceSession_machineId_runtimeBackend_status_idx"
ON "WorkspaceSession"("machineId", "runtimeBackend", "status");
