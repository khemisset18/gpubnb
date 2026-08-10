-- WorkspaceSession.bookingId was @unique alone, so the first workspace session ever
-- created for a booking (e.g. the compute session ensureComputePreparation() creates
-- automatically on funding) silently blocked any other workspace type - including a
-- renter-requested Developer session - from ever being created for that same booking.
-- One session per (booking, machineWorkspace) is the actually-intended constraint:
-- a booking may still have at most one session per workspace type, but is no longer
-- limited to a single workspace type overall.
DROP INDEX IF EXISTS "WorkspaceSession_bookingId_key";
CREATE UNIQUE INDEX "WorkspaceSession_bookingId_machineWorkspaceId_key" ON "WorkspaceSession"("bookingId", "machineWorkspaceId");
