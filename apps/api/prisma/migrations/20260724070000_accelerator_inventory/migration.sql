-- Generic, vendor-neutral accelerator inventory.
-- This migration is additive: legacy Machine.gpu* columns remain available while
-- agents and clients migrate to the multi-accelerator representation.

CREATE TABLE "MachineAccelerator" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "vendor" VARCHAR(120) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "deviceId" VARCHAR(200) NOT NULL,
    "busAddress" VARCHAR(120),
    "driverVersion" VARCHAR(100),
    "runtimeVersion" VARCHAR(100),
    "memoryTotalMiB" INTEGER,
    "memoryUsedMiB" INTEGER,
    "utilizationPercent" DOUBLE PRECISION,
    "temperatureC" DOUBLE PRECISION,
    "powerWatts" DOUBLE PRECISION,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "throttling" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "metrics" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "fingerprint" VARCHAR(64) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "MachineAccelerator_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MachineAccelerator_machineId_fkey"
      FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineAccelerator_memory_nonnegative"
      CHECK ("memoryTotalMiB" IS NULL OR "memoryTotalMiB" >= 0),
    CONSTRAINT "MachineAccelerator_memory_used_nonnegative"
      CHECK ("memoryUsedMiB" IS NULL OR "memoryUsedMiB" >= 0),
    CONSTRAINT "MachineAccelerator_memory_coherent"
      CHECK (
        "memoryTotalMiB" IS NULL OR "memoryUsedMiB" IS NULL OR
        "memoryUsedMiB" <= "memoryTotalMiB"
      ),
    CONSTRAINT "MachineAccelerator_utilization_range"
      CHECK ("utilizationPercent" IS NULL OR ("utilizationPercent" >= 0 AND "utilizationPercent" <= 100)),
    CONSTRAINT "MachineAccelerator_temperature_range"
      CHECK ("temperatureC" IS NULL OR ("temperatureC" >= -273.15 AND "temperatureC" <= 1000)),
    CONSTRAINT "MachineAccelerator_power_range"
      CHECK ("powerWatts" IS NULL OR ("powerWatts" >= 0 AND "powerWatts" <= 1000000)),
    CONSTRAINT "MachineAccelerator_capabilities_object"
      CHECK (jsonb_typeof("capabilities") = 'object'),
    CONSTRAINT "MachineAccelerator_metrics_object"
      CHECK (jsonb_typeof("metrics") = 'object')
);

CREATE UNIQUE INDEX "MachineAccelerator_machine_device_key"
  ON "MachineAccelerator"("machineId", "kind", "vendor", "deviceId");
CREATE INDEX "MachineAccelerator_machine_active_idx"
  ON "MachineAccelerator"("machineId", "removedAt", "lastSeenAt");
CREATE INDEX "MachineAccelerator_fingerprint_idx"
  ON "MachineAccelerator"("fingerprint");

CREATE TABLE "MachineAcceleratorEvent" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "acceleratorId" TEXT,
    "eventType" VARCHAR(32) NOT NULL,
    "previousFingerprint" VARCHAR(64),
    "currentFingerprint" VARCHAR(64),
    "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineAcceleratorEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MachineAcceleratorEvent_machineId_fkey"
      FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineAcceleratorEvent_acceleratorId_fkey"
      FOREIGN KEY ("acceleratorId") REFERENCES "MachineAccelerator"("id")
      ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MachineAcceleratorEvent_type_allowed"
      CHECK ("eventType" IN ('ADDED', 'UPDATED', 'REMOVED', 'REAPPEARED', 'SECURITY_CHANGE')),
    CONSTRAINT "MachineAcceleratorEvent_details_object"
      CHECK (jsonb_typeof("details") = 'object')
);

CREATE INDEX "MachineAcceleratorEvent_machine_created_idx"
  ON "MachineAcceleratorEvent"("machineId", "createdAt");
CREATE INDEX "MachineAcceleratorEvent_accelerator_created_idx"
  ON "MachineAcceleratorEvent"("acceleratorId", "createdAt");
