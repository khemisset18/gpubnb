-- Preserve the exact workspace selected by the renter across payment and reconnect.
-- Older bookings remain NULL and retain the legacy Compute/Developer path.
-- IF NOT EXISTS lets this migration safely follow the equivalent #378 change.
-- If #380 lands first, reconcile/remove the duplicate #378 migration before it
-- is applied; Prisma migration history still needs one canonical owner.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "requestedWorkspaceSlug" VARCHAR(80);
