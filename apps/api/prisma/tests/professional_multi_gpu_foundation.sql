-- Transactional acceptance tests for the professional multi-GPU foundation.
-- Run against an isolated PostgreSQL database after prisma migrate deploy.

BEGIN;

DO $$
DECLARE
  owner_id TEXT := 'test-owner-multigpu';
  renter_a TEXT := 'test-renter-a';
  renter_b TEXT := 'test-renter-b';
  machine_a TEXT := 'test-machine-4gpu';
  machine_b TEXT := 'test-machine-2gpu';
  listing_a TEXT := 'test-listing-selected';
  listing_b TEXT := 'test-listing-full';
  booking_a TEXT := 'test-booking-a';
  booking_b TEXT := 'test-booking-b';
BEGIN
  INSERT INTO "User" ("id", "wallet", "pseudonym", "canHost") VALUES
    (owner_id, 'wallet-owner-multigpu', 'owner-multigpu', true),
    (renter_a, 'wallet-renter-a', 'renter-a', false),
    (renter_b, 'wallet-renter-b', 'renter-b', false);

  INSERT INTO "Machine" ("id", "ownerId", "agentPublicKey") VALUES
    (machine_a, owner_id, 'agent-key-machine-a'),
    (machine_b, owner_id, 'agent-key-machine-b');

  INSERT INTO "Accelerator" ("id", "machineId", "hardwareUuid", "slotIndex", "model", "vramMiB", "status", "isolationVerified") VALUES
    ('gpu-a1', machine_a, 'uuid-a1', 0, 'RTX test', 24576, 'AVAILABLE', true),
    ('gpu-a2', machine_a, 'uuid-a2', 1, 'RTX test', 24576, 'AVAILABLE', true),
    ('gpu-a3', machine_a, 'uuid-a3', 2, 'RTX test', 24576, 'AVAILABLE', true),
    ('gpu-a4', machine_a, 'uuid-a4', 3, 'RTX test', 24576, 'AVAILABLE', true),
    ('gpu-b1', machine_b, 'uuid-b1', 0, 'RTX test', 24576, 'AVAILABLE', true),
    ('gpu-b2', machine_b, 'uuid-b2', 1, 'RTX test', 24576, 'AVAILABLE', true);

  INSERT INTO "GpuListing" ("id", "ownerId", "machineId", "title", "description", "hourlyLamports", "resourceMode") VALUES
    (listing_a, owner_id, machine_a, 'Deux GPU', 'Deux GPU sélectionnés', 1000, 'SELECTED_ACCELERATORS'),
    (listing_b, owner_id, machine_b, 'Machine complète', 'Machine complète', 2000, 'FULL_MACHINE');

  INSERT INTO "ListingAccelerator" ("listingId", "acceleratorId") VALUES
    (listing_a, 'gpu-a1'),
    (listing_a, 'gpu-a2');

  -- A listing cannot select a GPU from another machine.
  BEGIN
    INSERT INTO "ListingAccelerator" ("listingId", "acceleratorId") VALUES (listing_a, 'gpu-b1');
    RAISE EXCEPTION 'expected cross-machine listing selection to fail';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO "Booking" ("id", "buyerId", "listingId", "idempotencyKey", "startsAt", "endsAt", "quotedLamports", "expectedSeconds") VALUES
    (booking_a, renter_a, listing_a, 'idem-a', '2030-01-01 10:00:00+00', '2030-01-01 12:00:00+00', 2000, 7200),
    (booking_b, renter_b, listing_a, 'idem-b', '2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00', 1000, 3600);

  INSERT INTO "AcceleratorAllocation" ("id", "bookingId", "acceleratorId", "startsAt", "endsAt", "status") VALUES
    ('allocation-a1', booking_a, 'gpu-a1', '2030-01-01 10:00:00+00', '2030-01-01 12:00:00+00', 'CONFIRMED');

  -- Same GPU cannot overlap.
  BEGIN
    INSERT INTO "AcceleratorAllocation" ("id", "bookingId", "acceleratorId", "startsAt", "endsAt", "status") VALUES
      ('allocation-conflict', booking_b, 'gpu-a1', '2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00', 'CONFIRMED');
    RAISE EXCEPTION 'expected overlapping accelerator allocation to fail';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;

  -- Different GPUs on the same machine may be rented simultaneously.
  INSERT INTO "AcceleratorAllocation" ("id", "bookingId", "acceleratorId", "startsAt", "endsAt", "status") VALUES
    ('allocation-a2', booking_b, 'gpu-a2', '2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00', 'CONFIRMED');

  -- Full-machine rental conflicts with any partial GPU rental on that machine.
  BEGIN
    INSERT INTO "MachineAllocation" ("id", "bookingId", "machineId", "startsAt", "endsAt", "status") VALUES
      ('machine-conflict', booking_b, machine_a, '2030-01-01 10:45:00+00', '2030-01-01 11:00:00+00', 'CONFIRMED');
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'expected full-machine allocation conflict to fail';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;

  -- Early release makes the GPU available after releasedAt while preserving history.
  UPDATE "AcceleratorAllocation"
  SET "releasedAt" = '2030-01-01 11:00:00+00', "status" = 'RELEASED'
  WHERE "id" = 'allocation-a1';

  INSERT INTO "AcceleratorAllocation" ("id", "bookingId", "acceleratorId", "startsAt", "endsAt", "status") VALUES
    ('allocation-after-release', booking_b, 'gpu-a1', '2030-01-01 11:00:00+00', '2030-01-01 11:30:00+00', 'CONFIRMED');
END;
$$;

ROLLBACK;
