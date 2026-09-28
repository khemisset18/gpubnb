-- Persist the runtime selected for a Workspace session so a session can never
-- silently cross from the qualified container/Selkies backend into the separate
-- Windows-native authority boundary (or vice versa) after reservation.
CREATE TYPE "WorkspaceRuntimeBackend" AS ENUM ('CONTAINER', 'WINDOWS_NATIVE');

ALTER TABLE "WorkspaceSession"
ADD COLUMN "runtimeBackend" "WorkspaceRuntimeBackend";

-- Existing sessions predate backend identity and all use the container runtime.
UPDATE "WorkspaceSession"
SET "runtimeBackend" = 'CONTAINER'
WHERE "runtimeBackend" IS NULL;

ALTER TABLE "WorkspaceSession"
ALTER COLUMN "runtimeBackend" SET NOT NULL;

CREATE INDEX "WorkspaceSession_machineId_runtimeBackend_status_idx"
ON "WorkspaceSession"("machineId", "runtimeBackend", "status");

-- Backend identity is part of the reservation authority. Changing it after
-- insertion would be a cross-runtime migration and is forbidden: stop the old
-- session and create a freshly qualified one instead.
CREATE OR REPLACE FUNCTION "guard_workspace_runtime_backend_immutable"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."runtimeBackend" IS DISTINCT FROM OLD."runtimeBackend" THEN
    RAISE EXCEPTION 'workspace runtime backend is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkspaceSession_runtime_backend_immutable"
BEFORE UPDATE OF "runtimeBackend" ON "WorkspaceSession"
FOR EACH ROW
EXECUTE FUNCTION "guard_workspace_runtime_backend_immutable"();
