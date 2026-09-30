-- Preserve compatibility with the currently deployed legacy API while Stage 3
-- qualifies the explicit WINDOWS_NATIVE backend. Older API builds predate the
-- runtimeBackend Prisma field and therefore omit it on WorkspaceSession INSERT.
-- Native Stage 3 writers set WINDOWS_NATIVE explicitly; this default applies only
-- when a legacy writer omits the column.
ALTER TABLE "WorkspaceSession"
ALTER COLUMN "runtimeBackend" SET DEFAULT 'CONTAINER'::"WorkspaceRuntimeBackend";
