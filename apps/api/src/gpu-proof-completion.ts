import {
  BookingStatus,
  JobType,
  MachineOperational,
  ModerationStatus,
  Prisma,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';

import { STALLED_ACTIVATION_GRACE_MS } from './dev-booking-reconciler.js';
import { runBookingTransaction } from './booking-transaction-retry.js';
import { ensureCompatibleMachineWorkspace } from './machine-workspace-catalog.js';

export type GpuProofCompletionOutcome = {
  bookingStatus: typeof BookingStatus.STARTING | typeof BookingStatus.COMPLETED;
  machineReleased: boolean;
  developerWorkspaceSessionId: string | null;
  developerPreparationQueued: boolean;
  // Real gap found live (2026-09-02): neither branch below used to check whether its own
  // booking.updateMany actually matched a row before reporting bookingStatus as if it had -
  // if the booking had already left FUNDED/STARTING/ACTIVE by the time this ran (e.g. swept to
  // COMPLETED by reconcileExpiredActiveDeveloperBookings racing this exact call), the caller
  // still got back a confident-looking outcome describing a transition that never actually
  // happened. false here means this call was a no-op: the booking was already in a different
  // terminal/incompatible state, and bookingStatus/machineReleased above describe what this
  // call *attempted*, not what is now true in the database.
  changed: boolean;
};

/**
 * Called by /agent/jobs/:id/finalize-proof once a GPU_PROOF job has been verified.
 *
 * A successful GPU proof on a Developer-capable machine now queues the Developer
 * workspace immediately. The proof container is intentionally ephemeral; making the
 * renter click a second "Créer mon espace" button after that short-lived container exits
 * created a real physical-test failure mode where the UI stayed on the Compute job and no
 * persistent gpubnb-dev-* runtime was ever requested. Keeping this transition server-side
 * also means closing/reloading PC B cannot lose the request.
 *
 * Compatibility is evaluated here from the machine's current measured capabilities,
 * rather than relying on a MachineWorkspace row having been created by a previous manual
 * "Créer mon espace" click. That old dependency was circular: the automatic handoff could
 * never happen on a fresh renter path because the row it checked only came into existence
 * when the renter performed the manual action we are removing.
 *
 * The existing POST /bookings/:bookingId/workspace/developer route remains idempotent and
 * can still return this same session, so old clients and explicit retries keep working.
 */
export async function completeGpuProofJob(
  db: PrismaClient,
  bookingId: string,
  machineId: string,
): Promise<GpuProofCompletionOutcome> {
  let developerWorkspaceCompatible = null;
  try {
    developerWorkspaceCompatible = await ensureCompatibleMachineWorkspace(db, machineId, 'developer');
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'developer_workspace_incompatible') throw error;
  }

  return runBookingTransaction(db, async (tx) => {
    if (developerWorkspaceCompatible) {
      // Keep the booking alive and the GPU locked to it. The activation grace window
      // remains a hard upper bound if the persistent workspace never becomes openable.
      const now = new Date();
      const endsAt = new Date(now.getTime() + STALLED_ACTIVATION_GRACE_MS);
      const updated = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE] },
          workspaceActivatedAt: null,
        },
        data: { status: BookingStatus.STARTING, startsAt: now, endsAt },
      });
      if (updated.count !== 1) {
        return {
          bookingStatus: BookingStatus.STARTING,
          machineReleased: false,
          developerWorkspaceSessionId: null,
          developerPreparationQueued: false,
          changed: false,
        };
      }

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { buyerId: true, endsAt: true },
      });
      if (!booking) {
        throw new Error('gpu_proof_booking_missing_after_transition');
      }

      let developerSession = await tx.workspaceSession.findFirst({
        where: { bookingId, machineWorkspaceId: developerWorkspaceCompatible.id },
        select: { id: true },
      });
      let developerPreparationQueued = false;

      if (!developerSession) {
        const created = await tx.workspaceSession.create({
          data: {
            bookingId,
            renterId: booking.buyerId,
            machineId,
            machineWorkspaceId: developerWorkspaceCompatible.id,
            status: WorkspaceSessionStatus.PREPARING,
            isolationType: 'DOCKER',
            resourceLimits: {
              maxRamMiB: 4096,
              maxCpuCores: 2,
              storageQuotaMiB: 10240,
              networkAccess: 'RESTRICTED',
              autoStopMinutes: 60,
            },
            connectionType: 'GPUBNB_GATEWAY',
            preparationProgress: 5,
            preparationStep: 'GPU_PROOF_VERIFIED_AUTO_DEVELOPER',
            preparationRequestedAt: now,
            readyDeadlineAt: new Date(Math.max(Date.now(), now.getTime() + 60_000)),
            expiresAt: booking.endsAt,
            events: {
              create: {
                actorType: 'RENTER',
                actorId: booking.buyerId,
                action: 'DEVELOPER_PREPARATION_AUTO_REQUESTED_AFTER_GPU_PROOF',
              },
            },
          },
        });
        const job = await tx.job.create({
          data: {
            bookingId,
            renterId: booking.buyerId,
            machineId,
            type: JobType.WORKSPACE_PREPARE,
            parameters: { workspaceSlug: 'developer', timeoutSeconds: 1200 },
          },
        });
        developerSession = await tx.workspaceSession.update({
          where: { id: created.id },
          data: { jobId: job.id, preparationAttempts: { increment: 1 } },
          select: { id: true },
        });
        developerPreparationQueued = true;
      }

      return {
        bookingStatus: BookingStatus.STARTING,
        machineReleased: false,
        developerWorkspaceSessionId: developerSession.id,
        developerPreparationQueued,
        changed: true,
      };
    }

    const updated = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE] },
        workspaceActivatedAt: null,
      },
      data: { status: BookingStatus.COMPLETED },
    });
    if (updated.count !== 1) {
      return {
        bookingStatus: BookingStatus.COMPLETED,
        machineReleased: false,
        developerWorkspaceSessionId: null,
        developerPreparationQueued: false,
        changed: false,
      };
    }
    const released = await tx.machine.updateMany({
      where: {
        id: machineId,
        moderationStatus: ModerationStatus.CLEAR,
        operational: { in: [MachineOperational.RESERVED, MachineOperational.RUNNING] },
      },
      data: { operational: MachineOperational.AVAILABLE },
    });
    return {
      bookingStatus: BookingStatus.COMPLETED,
      machineReleased: released.count === 1,
      developerWorkspaceSessionId: null,
      developerPreparationQueued: false,
      changed: true,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
