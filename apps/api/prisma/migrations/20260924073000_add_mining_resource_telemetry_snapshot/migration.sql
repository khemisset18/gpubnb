-- Current mining metrics are operational snapshots, not an accounting history.
-- Runtime state, rental fencing and quarantine remain authoritative elsewhere.
ALTER TABLE "MiningResource"
  ADD COLUMN "lastMiningTelemetry" JSONB,
  ADD COLUMN "lastMiningTelemetryAt" TIMESTAMP(3);
