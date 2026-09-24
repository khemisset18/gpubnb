CREATE TABLE "MiningTelemetrySample" (
  "id" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "agentCounter" BIGINT NOT NULL,
  "runtimeGeneration" BIGINT NOT NULL,
  "hardwareUuid" VARCHAR(200) NOT NULL,
  "profileId" VARCHAR(96),
  "processPid" INTEGER,
  "temperatureC" DOUBLE PRECISION NOT NULL,
  "powerWatts" DOUBLE PRECISION,
  "gpuUtilizationPercent" DOUBLE PRECISION,
  "memoryUsedMiB" DOUBLE PRECISION,
  "hashrate" DOUBLE PRECISION,
  "hashrateUnit" VARCHAR(16),
  "acceptedShares" BIGINT,
  "staleShares" BIGINT,
  "hardwareErrors" BIGINT,
  "uptimeSeconds" BIGINT,
  "poolConnected" BOOLEAN NOT NULL,
  "thermalStopCelsius" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MiningTelemetrySample_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MiningTelemetrySample_resource_fkey"
    FOREIGN KEY ("resourceId") REFERENCES "MiningResource"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MiningTelemetrySample_ranges_check" CHECK (
    "agentCounter" > 0
    AND "runtimeGeneration" > 0
    AND "temperatureC" BETWEEN 0 AND 150
    AND ("powerWatts" IS NULL OR "powerWatts" BETWEEN 0 AND 5000)
    AND ("gpuUtilizationPercent" IS NULL OR "gpuUtilizationPercent" BETWEEN 0 AND 100)
    AND ("memoryUsedMiB" IS NULL OR "memoryUsedMiB" >= 0)
    AND ("hashrate" IS NULL OR "hashrate" >= 0)
    AND ("acceptedShares" IS NULL OR "acceptedShares" >= 0)
    AND ("staleShares" IS NULL OR "staleShares" >= 0)
    AND ("hardwareErrors" IS NULL OR "hardwareErrors" >= 0)
    AND ("uptimeSeconds" IS NULL OR "uptimeSeconds" >= 0)
    AND "thermalStopCelsius" BETWEEN 85 AND 98
  )
);

CREATE UNIQUE INDEX "MiningTelemetrySample_resourceId_capturedAt_key"
  ON "MiningTelemetrySample"("resourceId", "capturedAt");

CREATE INDEX "MiningTelemetrySample_resourceId_capturedAt_idx"
  ON "MiningTelemetrySample"("resourceId", "capturedAt");
