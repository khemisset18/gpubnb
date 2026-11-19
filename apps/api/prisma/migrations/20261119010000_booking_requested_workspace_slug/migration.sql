-- Renter-selected workspace is immutable after booking creation.
-- Legacy bookings stay NULL and preserve the existing automatic Developer flow.
ALTER TABLE "Booking" ADD COLUMN "requestedWorkspaceSlug" VARCHAR(80);
