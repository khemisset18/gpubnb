-- Align persisted mining configuration with the owner-controlled GPU thermal
-- cutoff exposed by Host Desktop and enforced by the resource-scoped Agent.
ALTER TABLE "MiningConfiguration"
  DROP CONSTRAINT IF EXISTS "MiningConfiguration_limits_check";

ALTER TABLE "MiningConfiguration"
  ADD CONSTRAINT "MiningConfiguration_limits_check" CHECK (
    ("maximumTemperatureC" IS NULL OR "maximumTemperatureC" BETWEEN 50 AND 98)
    AND ("maximumPowerWatts" IS NULL OR "maximumPowerWatts" BETWEEN 25 AND 1500)
    AND ("maximumCpuPercent" IS NULL OR "maximumCpuPercent" BETWEEN 1 AND 100)
    AND ("cpuThreadCount" IS NULL OR "cpuThreadCount" BETWEEN 1 AND 1024)
    AND ("gpuIntensityPercent" IS NULL OR "gpuIntensityPercent" BETWEEN 1 AND 100)
  );
