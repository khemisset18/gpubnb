ALTER TABLE "Machine"
  ADD COLUMN "agentVersion" TEXT,
  ADD COLUMN "keyCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "keyLastUsedAt" TIMESTAMP(3),
  ADD COLUMN "keyRevokedAt" TIMESTAMP(3),
  ADD COLUMN "operatingSystem" TEXT,
  ADD COLUMN "osVersion" TEXT,
  ADD COLUMN "cpuModel" TEXT,
  ADD COLUMN "cpuCount" INTEGER,
  ADD COLUMN "ramTotalMiB" INTEGER,
  ADD COLUMN "diskTotalMiB" INTEGER,
  ADD COLUMN "cudaVersion" TEXT,
  ADD COLUMN "dockerAvailable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "nvidiaRuntimeAvailable" BOOLEAN NOT NULL DEFAULT false;
