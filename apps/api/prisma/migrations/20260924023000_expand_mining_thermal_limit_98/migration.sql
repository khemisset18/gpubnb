-- Align the server-side GPU mining thermal envelope with Host Desktop and the
-- resource-scoped Agent watchdog. GPU policy keeps 85 C as its minimum/default
-- safety cutoff and allows up to 98 C. CPU policy remains capped at 95 C.
ALTER TABLE "MiningConfiguration"
  DROP CONSTRAINT "MiningConfiguration_limits_check";

ALTER TABLE "MiningConfiguration"
  ADD CONSTRAINT "MiningConfiguration_limits_check" CHECK (
    ("maximumTemperatureC" IS NULL OR "maximumTemperatureC" BETWEEN 50 AND 98)
    AND ("maximumPowerWatts" IS NULL OR "maximumPowerWatts" BETWEEN 25 AND 1500)
    AND ("maximumCpuPercent" IS NULL OR "maximumCpuPercent" BETWEEN 1 AND 100)
    AND ("cpuThreadCount" IS NULL OR "cpuThreadCount" BETWEEN 1 AND 1024)
    AND ("gpuIntensityPercent" IS NULL OR "gpuIntensityPercent" BETWEEN 1 AND 100)
  );
