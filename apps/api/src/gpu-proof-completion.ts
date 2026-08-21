import {
  BookingStatus,
  MachineOperational,
  MachineWorkspaceState,
  ModerationStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { STALLED_ACTIVATION_GRACE_MS } from './dev-booking-reconciler.js';

export type GpuProofCompletionOutcome = {
  bookingStatus: typeof BookingStatus.STARTING | typeof BookingStatus.COMPLETED;
  machineReleased: boolean;
};

/**
 * Called by /agent/jobs/:id/finalize-proof once a GPU_PROOF job has been verified.
 * GPU_PROOF is a pre-flight check, not necessarily the end of the booking: a
 * Developer workspace may still be requested on the same booking afterward (see
 * POST /bookings/:bookingId/workspace/developer). Completing the booking and
 * releasing the machine unconditionally would let a second renter claim the exact
 * same accelerator before this renter ever opens their workspace - the class of
 * bug dev-booking-reconciler.ts's racedDeveloperSessions guard exists to fence
 * and quarantine after the fact.
 *
 * Kept as its own module (rather than inline in server.ts) so it can be exercised
 * directly against a real database in tests, the same way allocateBookingResources/
 * releaseBookingResources already are in e2e-gpu-rental-lifecycle.test.ts - not
 * re-simulated in parallel, which would let the test and the real route drift.
 */
export async function completeGpuProofJob(
  db: PrismaClient,
  bookingId: string,
  machineId: string,
): Promise<GpuProofCompletionOutcome> {
  // Read-only check: does this machine even offer a compatible Developer workspace
  // right now? If not, nothing changes from the pre-existing behavior - immediate
  // completion, exactly as before GPU_PROOF's follow-up workspace ever existed.
  const developerWorkspaceCompatible = await db.machineWorkspace.findFirst({
    where: {
      machineId,
      workspace: { slug: 'developer' },
      state: { in: [MachineWorkspaceState.READY, MachineWorkspaceState.LIMITED] },
    },
    select: { id: true },
  });

  return db.$transaction(async (tx) => {
    if (developerWorkspaceCompatible) {
      // Keep the booking alive and the GPU locked to it. reconcileStalledActivations
      // (dev-booking-reconciler.ts) already sweeps FUNDED/STARTING bookings on its own
      // STALLED_ACTIVATION_GRACE_MS window - refreshing startsAt/endsAt here is enough
      // to give the renter a real, already-tested safety timeout to actually request
      // the workspace, without inventing a second timeout mechanism. machine.operational
      // is deliberately left untouched: it must not become AVAILABLE while this booking
      // may still open a Developer workspace on the same accelerator.
      const now = new Date();
      await tx.booking.updateMany({
        where: { id: bookingId, status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE] } },
        data: { status: BookingStatus.STARTING, startsAt: now, endsAt: new Date(now.getTime() + STALLED_ACTIVATION_GRACE_MS) },
      });
      return { bookingStatus: BookingStatus.STARTING, machineReleased: false };
    }
    await tx.booking.updateMany({
      where: { id: bookingId, status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE] } },
      data: { status: BookingStatus.COMPLETED },
    });
    const released = await tx.machine.updateMany({
      where: { id: machineId, moderationStatus: ModerationStatus.CLEAR, operational: { in: [MachineOperational.RESERVED, MachineOperational.RUNNING] } },
      data: { operational: MachineOperational.AVAILABLE },
    });
    return { bookingStatus: BookingStatus.COMPLETED, machineReleased: released.count === 1 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
