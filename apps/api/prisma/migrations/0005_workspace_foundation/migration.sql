CREATE TYPE "WorkspaceRelease" AS ENUM ('BETA', 'UPCOMING', 'EXPERIMENTAL', 'SUSPENDED');
CREATE TYPE "MachineWorkspaceState" AS ENUM ('READY', 'LIMITED', 'INSTALL_REQUIRED', 'INCOMPATIBLE', 'OWNER_DISABLED');
ALTER TABLE "Machine" ADD COLUMN "virtualizationAvailable" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "WorkspaceDefinition" (
  "id" TEXT NOT NULL, "slug" VARCHAR(80) NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "name" VARCHAR(120) NOT NULL, "category" VARCHAR(40) NOT NULL,
  "release" "WorkspaceRelease" NOT NULL DEFAULT 'UPCOMING',
  "globallyEnabled" BOOLEAN NOT NULL DEFAULT true, "manifest" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceDefinition_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MachineWorkspace" (
  "id" TEXT NOT NULL, "machineId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
  "compatibilityScore" INTEGER NOT NULL, "state" "MachineWorkspaceState" NOT NULL,
  "enabledByOwner" BOOLEAN NOT NULL DEFAULT false, "analysis" JSONB NOT NULL,
  "configuration" JSONB, "hourlyLamports" BIGINT, "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "testedAt" TIMESTAMP(3), CONSTRAINT "MachineWorkspace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceDefinition_slug_key" ON "WorkspaceDefinition"("slug");
CREATE UNIQUE INDEX "MachineWorkspace_machineId_workspaceId_key" ON "MachineWorkspace"("machineId","workspaceId");
CREATE INDEX "MachineWorkspace_machineId_enabledByOwner_state_idx" ON "MachineWorkspace"("machineId","enabledByOwner","state");
ALTER TABLE "MachineWorkspace" ADD CONSTRAINT "MachineWorkspace_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineWorkspace" ADD CONSTRAINT "MachineWorkspace_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "WorkspaceDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
