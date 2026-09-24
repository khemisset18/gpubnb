-- Align the server-side owner mining thermal envelope with Host Desktop and the
-- resource-scoped Agent watchdog. 85 C remains the minimum/default safety cutoff;
-- 98 C is the hard upper boundary and also the platform thermal-quarantine edge.
ALTER TABLE "MiningConfiguration"
  DROP CONSTRAINT "MiningConfiguration_limits_check";

ALTER TABLE "MiningConfiguration"
  ADD CONSTRAINT "MiningConfiguration_limits_check" CHECK (
    ("maximumTemperatureC" IS NULL OR "maximumTemperatureC" BETWEEN 85 AND 98)
    AND ("maximumPowerWatts" IS NULL OR "maximumPowerWatts" BETWEEN 25 AND 1500)
    AND ("maximumCpuPercent" IS NULL OR "maximumCpuPercent" BETWEEN 1 AND 100)
    AND ("cpuThreadCount" IS NULL OR "cpuThreadCount" BETWEEN 1 AND 1024)
    AND ("gpuIntensityPercent" IS NULL OR "gpuIntensityPercent" BETWEEN 1 AND 100)
  );
