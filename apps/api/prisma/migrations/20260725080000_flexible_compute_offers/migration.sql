-- Flexible compute offers: full machine, selected accelerators, or declared compute pool.
-- Additive migration: existing machine-based GpuListing rows remain valid.

CREATE TYPE "ListingResourceMode" AS ENUM (
  'FULL_MACHINE',
  'SELECTED_ACCELERATORS',
  'COMPUTE_POOL'
);

ALTER TABLE "GpuListing"
  ADD COLUMN "resourceMode" "ListingResourceMode" NOT NULL DEFAULT 'FULL_MACHINE',
  ADD COLUMN "minimumAcceleratorCount" INTEGER,
  ADD COLUMN "maximumAcceleratorCount" INTEGER,
  ADD COLUMN "declaredComputeProfile" JSONB;

ALTER TABLE "GpuListing"
  ADD CONSTRAINT "GpuListing_accelerator_count_positive"
  CHECK (
    ("minimumAcceleratorCount" IS NULL OR "minimumAcceleratorCount" > 0) AND
    ("maximumAcceleratorCount" IS NULL OR "maximumAcceleratorCount" > 0)
  ),
  ADD CONSTRAINT "GpuListing_accelerator_count_order"
  CHECK (
    "minimumAcceleratorCount" IS NULL OR
    "maximumAcceleratorCount" IS NULL OR
    "minimumAcceleratorCount" <= "maximumAcceleratorCount"
  ),
  ADD CONSTRAINT "GpuListing_compute_profile_object"
  CHECK (
    "declaredComputeProfile" IS NULL OR
    jsonb_typeof("declaredComputeProfile") = 'object'
  );

-- Accelerators explicitly available to an offer. An accelerator may appear in
-- several offer templates, but booking locks below prevent overlapping rentals.
CREATE TABLE "GpuListingAccelerator" (
  "listingId" TEXT NOT NULL,
  "acceleratorId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GpuListingAccelerator_pkey" PRIMARY KEY ("listingId", "acceleratorId"),
  CONSTRAINT "GpuListingAccelerator_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "GpuListing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GpuListingAccelerator_acceleratorId_fkey"
    FOREIGN KEY ("acceleratorId") REFERENCES "MachineAccelerator"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GpuListingAccelerator_position_nonnegative"
    CHECK ("position" >= 0)
);

CREATE INDEX "GpuListingAccelerator_accelerator_idx"
  ON "GpuListingAccelerator"("acceleratorId", "listingId");

-- Immutable booking allocation. Each row records the exact physical GPU
-- allocated to a booking, even when the offer is later edited.
CREATE TABLE "BookingAcceleratorAllocation" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "acceleratorId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookingAcceleratorAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingAcceleratorAllocation_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingAcceleratorAllocation_acceleratorId_fkey"
    FOREIGN KEY ("acceleratorId") REFERENCES "MachineAccelerator"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingAcceleratorAllocation_period_valid"
    CHECK ("endsAt" > "startsAt")
);

CREATE UNIQUE INDEX "BookingAcceleratorAllocation_booking_accelerator_key"
  ON "BookingAcceleratorAllocation"("bookingId", "acceleratorId");
CREATE INDEX "BookingAcceleratorAllocation_accelerator_period_idx"
  ON "BookingAcceleratorAllocation"("acceleratorId", "startsAt", "endsAt");

-- PostgreSQL exclusion constraint: the same physical accelerator cannot be
-- allocated to two non-released bookings whose rental periods overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "BookingAcceleratorAllocation"
  ADD CONSTRAINT "BookingAcceleratorAllocation_no_overlap"
  EXCLUDE USING gist (
    "acceleratorId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("releasedAt" IS NULL);
