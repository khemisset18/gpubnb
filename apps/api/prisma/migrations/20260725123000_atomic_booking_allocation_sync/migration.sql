-- Keep booking state and physical resource locks synchronized at the database boundary.
-- This trigger protects every writer (HTTP API, delivery worker, maintenance jobs, and
-- future services) from forgetting to transition MachineAllocation/AcceleratorAllocation.

CREATE OR REPLACE FUNCTION "sync_booking_resource_allocations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_status "ResourceAllocationStatus";
  terminal_transition BOOLEAN := false;
  target_machine_id TEXT;
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  target_status := CASE NEW."status"
    WHEN 'AWAITING_DEPOSIT' THEN 'HELD'::"ResourceAllocationStatus"
    WHEN 'FUNDED' THEN 'CONFIRMED'::"ResourceAllocationStatus"
    WHEN 'STARTING' THEN 'CONFIRMED'::"ResourceAllocationStatus"
    WHEN 'ACTIVE' THEN 'ACTIVE'::"ResourceAllocationStatus"
    WHEN 'DEGRADED' THEN 'ACTIVE'::"ResourceAllocationStatus"
    WHEN 'COMPLETED' THEN 'RELEASED'::"ResourceAllocationStatus"
    WHEN 'SETTLED' THEN 'RELEASED'::"ResourceAllocationStatus"
    WHEN 'REFUNDED' THEN 'RELEASED'::"ResourceAllocationStatus"
    WHEN 'CANCELLED' THEN 'CANCELLED'::"ResourceAllocationStatus"
    ELSE NULL
  END;

  IF target_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT listing."machineId"
  INTO target_machine_id
  FROM "GpuListing" AS listing
  WHERE listing."id" = NEW."listingId";

  IF target_machine_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(target_machine_id, 0));
  END IF;

  terminal_transition := target_status IN (
    'RELEASED'::"ResourceAllocationStatus",
    'CANCELLED'::"ResourceAllocationStatus"
  );

  IF target_status = 'HELD'::"ResourceAllocationStatus" THEN
    -- Allocation creation is explicit during booking acceptance. Never resurrect a
    -- terminal allocation when a booking is moved backwards administratively.
    RETURN NEW;
  ELSIF target_status = 'CONFIRMED'::"ResourceAllocationStatus" THEN
    UPDATE "MachineAllocation"
    SET "status" = target_status, "releasedAt" = NULL
    WHERE "bookingId" = NEW."id" AND "status" = 'HELD';

    UPDATE "AcceleratorAllocation"
    SET "status" = target_status, "releasedAt" = NULL
    WHERE "bookingId" = NEW."id" AND "status" = 'HELD';
  ELSIF target_status = 'ACTIVE'::"ResourceAllocationStatus" THEN
    UPDATE "MachineAllocation"
    SET "status" = target_status, "releasedAt" = NULL
    WHERE "bookingId" = NEW."id" AND "status" IN ('HELD', 'CONFIRMED');

    UPDATE "AcceleratorAllocation"
    SET "status" = target_status, "releasedAt" = NULL
    WHERE "bookingId" = NEW."id" AND "status" IN ('HELD', 'CONFIRMED');
  ELSIF terminal_transition THEN
    UPDATE "MachineAllocation"
    SET "status" = target_status, "releasedAt" = COALESCE("releasedAt", CURRENT_TIMESTAMP)
    WHERE "bookingId" = NEW."id" AND "status" IN ('HELD', 'CONFIRMED', 'ACTIVE');

    UPDATE "AcceleratorAllocation"
    SET "status" = target_status, "releasedAt" = COALESCE("releasedAt", CURRENT_TIMESTAMP)
    WHERE "bookingId" = NEW."id" AND "status" IN ('HELD', 'CONFIRMED', 'ACTIVE');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Booking_resource_allocation_sync" ON "Booking";

CREATE TRIGGER "Booking_resource_allocation_sync"
AFTER UPDATE OF "status" ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION "sync_booking_resource_allocations"();
