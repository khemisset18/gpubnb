ALTER TABLE "MiningResource"
  ADD COLUMN "lastTelemetry" JSONB,
  ADD COLUMN "lastTelemetryAt" TIMESTAMP(3);

CREATE INDEX "MiningResource_lastTelemetryAt_idx"
  ON "MiningResource"("lastTelemetryAt");
