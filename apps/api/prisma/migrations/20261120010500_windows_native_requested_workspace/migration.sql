-- Preserve the exact workspace selected by the renter across payment and reconnect.
-- Older bookings remain NULL and retain the legacy Compute/Developer path.
ALTER TABLE "Booking" ADD COLUMN "requestedWorkspaceSlug" VARCHAR(80);
