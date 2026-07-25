-- Professional multi-GPU marketplace foundation.
-- Additive migration: legacy Machine GPU columns and existing bookings remain untouched.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "AcceleratorOperationalStatus" AS ENUM (
  'DISCOVERED',
  'VERIFYING',
  'AVAILABLE',
  'RESERVED',
  'RUNNING',
  'DEGRADED',
  'MAINTENANCE',
  'MISSING',
  'QUARANTINED'
);

CREATE TYPE "ListingResourceMode" AS ENUM (
  'FULL_MACHINE',
  'SELECTED_ACCELERATORS',
  'COMPUTE_POOL'
);

CREATE TYPE "ResourceAllocationStatus" AS ENUM (
  'HELD',
  'CONFIRMED',
  'ACTIVE',
  'RELEASED',
  'CANCELLED'
);

ALTER TABLE "GpuListing"
  ADD COLUMN "resourceMode" "ListingResourceMode" NOT NULL DEFAULT 'FULL_MACHINE',
  ADD COLUMN "minimumAccelerators" INTEGER,
  ADD COLUMN "maximumAccelerators" INTEGER;

ALTER TABLE "GpuListing"
  ADD CONSTRAINT "GpuListing_accelerator_count_check"
  CHECK (
    ("resourceMode" = 'FULL_MACHINE' AND "minimumAccelerators" IS NULL AND "maximumAccelerators" IS NULL)
    OR
    ("resourceMode" = 'SELECTED_ACCELERATORS' AND "minimumAccelerators" IS NULL AND "maximumAccelerators" IS NULL)
    OR
    ("resourceMode" = 'COMPUTE_POOL'
      AND "minimumAccelerators" IS NOT NULL
      AND "maximumAccelerators" IS NOT NULL
      AND "minimumAccelerators" > 0
      AND "maximumAccelerators" >= "minimumAccelerators")
  );

CREATE TABLE "Accelerator" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "hardwareUuid" TEXT NOT NULL,
  "slotIndex" INTEGER,
  "vendor" VARCHAR(40),
  "model" VARCHAR(160) NOT NULL,
  "vramMiB" INTEGER NOT NULL,
  "driverVersion" VARCHAR(80),
  "cudaVersion" VARCHAR(40),
  "status" "AcceleratorOperationalStatus" NOT NULL DEFAULT 'DISCOVERED',
  "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'CLEAR',
  "isolationVerified" BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Accelerator_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Accelerator_vram_positive" CHECK ("vramMiB" > 0),
  CONSTRAINT "Accelerator_slot_nonnegative" CHECK ("slotIndex" IS NULL OR "slotIndex" >= 0)
);

CREATE UNIQUE INDEX "Accelerator_machineId_hardwareUuid_key"
  ON "Accelerator"("machineId", "hardwareUuid");
CREATE UNIQUE INDEX "Accelerator_machineId_slotIndex_key"
  ON "Accelerator"("machineId", "slotIndex") WHERE "slotIndex" IS NOT NULL;
CREATE INDEX "Accelerator_machineId_status_idx"
  ON "Accelerator"("machineId", "status");

ALTER TABLE "Accelerator"
  ADD CONSTRAINT "Accelerator_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ListingAccelerator" (
  "listingId" TEXT NOT NULL,
  "acceleratorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ListingAccelerator_pkey" PRIMARY KEY ("listingId", "acceleratorId")
);
CREATE INDEX "ListingAccelerator_acceleratorId_idx" ON "ListingAccelerator"("acceleratorId");
ALTER TABLE "ListingAccelerator"
  ADD CONSTRAINT "ListingAccelerator_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "GpuListing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ListingAccelerator_acceleratorId_fkey"
  FOREIGN KEY ("acceleratorId") REFERENCES "Accelerator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MachineAllocation" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "status" "ResourceAllocationStatus" NOT NULL DEFAULT 'HELD',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MachineAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MachineAllocation_period_check" CHECK ("endsAt" > "startsAt")
);
CREATE UNIQUE INDEX "MachineAllocation_bookingId_key" ON "MachineAllocation"("bookingId");
CREATE INDEX "MachineAllocation_machineId_period_idx" ON "MachineAllocation"("machineId", "startsAt", "endsAt");
ALTER TABLE "MachineAllocation"
  ADD CONSTRAINT "MachineAllocation_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MachineAllocation_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MachineAllocation"
  ADD CONSTRAINT "MachineAllocation_no_overlap"
  EXCLUDE USING gist (
    "machineId" WITH =,
    tstzrange("startsAt", COALESCE("releasedAt", "endsAt"), '[)') WITH &&
  ) WHERE ("status" IN ('HELD', 'CONFIRMED', 'ACTIVE'));

CREATE TABLE "AcceleratorAllocation" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "acceleratorId" TEXT NOT NULL,
  "status" "ResourceAllocationStatus" NOT NULL DEFAULT 'HELD',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AcceleratorAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AcceleratorAllocation_period_check" CHECK ("endsAt" > "startsAt")
);
CREATE UNIQUE INDEX "AcceleratorAllocation_bookingId_acceleratorId_key"
  ON "AcceleratorAllocation"("bookingId", "acceleratorId");
CREATE INDEX "AcceleratorAllocation_acceleratorId_period_idx"
  ON "AcceleratorAllocation"("acceleratorId", "startsAt", "endsAt");
ALTER TABLE "AcceleratorAllocation"
  ADD CONSTRAINT "AcceleratorAllocation_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AcceleratorAllocation_acceleratorId_fkey"
  FOREIGN KEY ("acceleratorId") REFERENCES "Accelerator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AcceleratorAllocation"
  ADD CONSTRAINT "AcceleratorAllocation_no_overlap"
  EXCLUDE USING gist (
    "acceleratorId" WITH =,
    tstzrange("startsAt", COALESCE("releasedAt", "endsAt"), '[)') WITH &&
  ) WHERE ("status" IN ('HELD', 'CONFIRMED', 'ACTIVE'));

-- A full-machine allocation conflicts with every accelerator allocation on that machine,
-- and an accelerator allocation conflicts with an active full-machine allocation.
CREATE OR REPLACE FUNCTION "guard_machine_allocation_conflicts"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('HELD', 'CONFIRMED', 'ACTIVE') AND EXISTS (
    SELECT 1
    FROM "AcceleratorAllocation" aa
    JOIN "Accelerator" a ON a."id" = aa."acceleratorId"
    WHERE a."machineId" = NEW."machineId"
      AND aa."status" IN ('HELD', 'CONFIRMED', 'ACTIVE')
      AND tstzrange(aa."startsAt", COALESCE(aa."releasedAt", aa."endsAt"), '[)')
          && tstzrange(NEW."startsAt", COALESCE(NEW."releasedAt", NEW."endsAt"), '[)')
  ) THEN
    RAISE EXCEPTION 'machine allocation conflicts with an accelerator allocation'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "guard_accelerator_allocation_conflicts"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_machine_id TEXT;
BEGIN
  SELECT "machineId" INTO target_machine_id
  FROM "Accelerator" WHERE "id" = NEW."acceleratorId";

  IF target_machine_id IS NULL THEN
    RAISE EXCEPTION 'accelerator does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW."status" IN ('HELD', 'CONFIRMED', 'ACTIVE') AND EXISTS (
    SELECT 1
    FROM "MachineAllocation" ma
    WHERE ma."machineId" = target_machine_id
      AND ma."status" IN ('HELD', 'CONFIRMED', 'ACTIVE')
      AND tstzrange(ma."startsAt", COALESCE(ma."releasedAt", ma."endsAt"), '[)')
          && tstzrange(NEW."startsAt", COALESCE(NEW."releasedAt", NEW."endsAt"), '[)')
  ) THEN
    RAISE EXCEPTION 'accelerator allocation conflicts with a full-machine allocation'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MachineAllocation_cross_resource_guard"
AFTER INSERT OR UPDATE ON "MachineAllocation"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION "guard_machine_allocation_conflicts"();

CREATE CONSTRAINT TRIGGER "AcceleratorAllocation_cross_resource_guard"
AFTER INSERT OR UPDATE ON "AcceleratorAllocation"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION "guard_accelerator_allocation_conflicts"();

-- Ensure a listing can reference only accelerators belonging to its machine.
CREATE OR REPLACE FUNCTION "guard_listing_accelerator_machine"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "GpuListing" l
    JOIN "Accelerator" a ON a."id" = NEW."acceleratorId"
    WHERE l."id" = NEW."listingId" AND l."machineId" = a."machineId"
  ) THEN
    RAISE EXCEPTION 'listing and accelerator must belong to the same machine'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ListingAccelerator_same_machine_guard"
BEFORE INSERT OR UPDATE ON "ListingAccelerator"
FOR EACH ROW EXECUTE FUNCTION "guard_listing_accelerator_machine"();

-- Backfill one accelerator for legacy machines that already expose one GPU.
-- Legacy columns remain available during the transition.
INSERT INTO "Accelerator" (
  "id", "machineId", "hardwareUuid", "vendor", "model", "vramMiB",
  "driverVersion", "cudaVersion", "status", "moderationStatus",
  "isolationVerified", "verifiedAt", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  'legacy-' || m."id",
  m."id",
  COALESCE(m."gpuUuid", 'legacy-' || m."id"),
  m."gpuVendor",
  COALESCE(m."gpuModel", 'GPU non identifié'),
  GREATEST(COALESCE(m."vramMiB", 1), 1),
  m."driverVersion",
  m."cudaVersion",
  CASE
    WHEN m."moderationStatus" = 'QUARANTINED' THEN 'QUARANTINED'::"AcceleratorOperationalStatus"
    WHEN m."verifiedAt" IS NOT NULL THEN 'AVAILABLE'::"AcceleratorOperationalStatus"
    ELSE 'DISCOVERED'::"AcceleratorOperationalStatus"
  END,
  m."moderationStatus",
  m."virtualizationAvailable" AND m."nvidiaRuntimeAvailable",
  m."verifiedAt",
  m."lastHeartbeatAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Machine" m
WHERE m."gpuUuid" IS NOT NULL OR m."gpuModel" IS NOT NULL OR m."vramMiB" IS NOT NULL
ON CONFLICT ("machineId", "hardwareUuid") DO NOTHING;
