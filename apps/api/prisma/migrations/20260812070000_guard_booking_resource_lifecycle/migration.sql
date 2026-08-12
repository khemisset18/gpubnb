-- A booking that is funded or executing must always retain a live physical resource lock.
-- This closes two dangerous resurrection paths:
--   1. a cancelled booking whose already-broadcast escrow transaction is confirmed later;
--   2. legacy recovery code moving a completed booking back to STARTING after its
--      allocation was already released by sync_booking_allocation_after_status_update.
--
-- Keep this invariant in PostgreSQL so HTTP routes, reconcilers, workers and future
-- admin tooling all receive the same protection.
CREATE OR REPLACE FUNCTION guard_booking_resource_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_live_allocation boolean;
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  -- Terminal bookings must never return to a reserving/executing state. COMPLETED is
  -- included: settlement may still move COMPLETED -> SETTLED/REFUNDED, but runtime
  -- execution is not allowed to restart once its resource allocation was released.
  IF OLD."status" IN ('COMPLETED', 'SETTLED', 'REFUNDED', 'CANCELLED')
     AND NEW."status" IN ('CREATED', 'AWAITING_DEPOSIT', 'FUNDED', 'STARTING', 'ACTIVE', 'DEGRADED') THEN
    RAISE EXCEPTION 'terminal booking % cannot transition from % to %',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  -- Every paid/executing state must be backed by either a whole-machine allocation
  -- or one/more accelerator allocations. HELD is valid while AWAITING_DEPOSIT ->
  -- FUNDED is being committed; the existing AFTER trigger promotes it to CONFIRMED.
  IF NEW."status" IN ('FUNDED', 'STARTING', 'ACTIVE', 'DEGRADED') THEN
    SELECT
      EXISTS (
        SELECT 1
        FROM "MachineAllocation"
        WHERE "bookingId" = NEW."id"
          AND "status" IN ('HELD', 'CONFIRMED', 'ACTIVE')
      )
      OR EXISTS (
        SELECT 1
        FROM "AcceleratorAllocation"
        WHERE "bookingId" = NEW."id"
          AND "status" IN ('HELD', 'CONFIRMED', 'ACTIVE')
      )
    INTO has_live_allocation;

    IF NOT has_live_allocation THEN
      RAISE EXCEPTION 'booking % cannot enter % without a live resource allocation',
        NEW."id", NEW."status"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Booking_guard_resource_lifecycle" ON "Booking";
CREATE TRIGGER "Booking_guard_resource_lifecycle"
BEFORE UPDATE OF "status" ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION guard_booking_resource_lifecycle();
