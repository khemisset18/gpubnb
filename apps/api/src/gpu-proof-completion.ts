import {
  BookingStatus,
  JobStatus,
  JobType,
  MachineOperational,
  ModerationStatus,
  Prisma,
  WorkspaceRuntimeBackend,
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
  // Only populated for an explicitly selected Linux desktop Workspace.
  workspaceSlug?: string;
  workspaceSessionId?: string | null;
  workspacePreparationQueued?: boolean;
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
  // Preserve the renter's immutable choice across funding and GPU_PROOF.
  // A missing value means a legacy Compute/Developer booking.
  const selected = await db.booking.findUnique({
    where: { id: bookingId },
    select: { requestedWorkspaceSlug: true },
  });
  const desktopSlugs = ['cloud-desktop', 'creator', 'cad', 'gaming'] as const;
  type DesktopSlug = typeof desktopSlugs[number];
  const requested = selected?.requestedWorkspaceSlug;
  const chosenDesktop: DesktopSlug | null = desktopSlugs.find(slug => slug === requested) ?? null;
  const targetSlug = chosenDesktop ?? 'developer';
  let targetWorkspaceCompatible = null;
  try {
    targetWorkspaceCompatible = await ensureCompatibleMachineWorkspace(db, machineId, targetSlug);
    if (chosenDesktop && !targetWorkspaceCompatible.enabledByOwner) {
      targetWorkspaceCompatible = null;
    }
  } catch (error) {
    if (!(error instanceof Error) ||
      ![targetSlug + '_workspace_incompatible', targetSlug + '_workspace_runtime_unavailable'].includes(error.message)) {
      throw error;
    }
  }
  const desktopLimits: Record<DesktopSlug, { maxRamMiB: number; maxCpuCores: number; storageQuotaMiB: number }> = {
    'cloud-desktop': { maxRamMiB: 8192, maxCpuCores: 4, storageQuotaMiB: 81920 },
    creator: { maxRamMiB: 16384, maxCpuCores: 4, storageQuotaMiB: 102400 },
    cad: { maxRamMiB: 16384, maxCpuCores: 4, storageQuotaMiB: 122880 },
    gaming: { maxRamMiB: 16384, maxCpuCores: 4, storageQuotaMiB: 204800 },
  };

  return runBookingTransaction(db, async (tx) => {
    if (targetWorkspaceCompatible) {
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
        where: { bookingId, machineWorkspaceId: targetWorkspaceCompatible.id },
        select: { id: true },
      });
      let developerPreparationQueued = false;

      if (!developerSession) {
        const created = await tx.workspaceSession.create({
          data: {
            bookingId,
            renterId: booking.buyerId,
            machineId,
            machineWorkspaceId: targetWorkspaceCompatible.id,
            status: WorkspaceSessionStatus.PREPARING,
            isolationType: 'DOCKER',
            runtimeBackend: WorkspaceRuntimeBackend.CONTAINER,
            resourceLimits: {
              ...(chosenDesktop ? desktopLimits[chosenDesktop] : {
                maxRamMiB: 4096, maxCpuCores: 2, storageQuotaMiB: 10240,
              }),
              networkAccess: 'RESTRICTED',
              autoStopMinutes: 60,
            },
            connectionType: 'GPUBNB_GATEWAY',
            preparationProgress: 5,
            preparationStep: chosenDesktop ? 'GPU_PROOF_VERIFIED_DESKTOP_REQUESTED' : 'GPU_PROOF_VERIFIED_AUTO_DEVELOPER',
            preparationRequestedAt: now,
            readyDeadlineAt: new Date(Math.max(Date.now(), now.getTime() + 60_000)),
            expiresAt: booking.endsAt,
            events: {
              create: {
                actorType: 'RENTER',
                actorId: booking.buyerId,
                action: chosenDesktop ? 'DESKTOP_PREPARATION_AUTO_REQUESTED_AFTER_GPU_PROOF' : 'DEVELOPER_PREPARATION_AUTO_REQUESTED_AFTER_GPU_PROOF',
              },
            },
          },
        });
        // Preserve parity with the legacy manual Developer endpoint. A queued
        // beta diagnostic is superseded by the real renter workspace, but an
        // already-running diagnostic is deliberately left alone.
        await tx.job.updateMany({
          where: { bookingId, type: JobType.GPU_DIAGNOSTIC, status: JobStatus.QUEUED },
          data: {
            status: JobStatus.CANCELLED,
            errorCode: chosenDesktop ? 'superseded_by_desktop_workspace' : 'superseded_by_developer_workspace',
            finishedAt: now,
          },
        });
        const job = await tx.job.create({
          data: {
            bookingId,
            renterId: booking.buyerId,
            machineId,
            type: JobType.WORKSPACE_PREPARE,
            parameters: { workspaceSlug: targetSlug, timeoutSeconds: chosenDesktop ? 1800 : 1200 },
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
        developerWorkspaceSessionId: chosenDesktop ? null : developerSession.id,
        developerPreparationQueued: chosenDesktop ? false : developerPreparationQueued,
        changed: true,
        ...(chosenDesktop ? {
          workspaceSlug: chosenDesktop,
          workspaceSessionId: developerSession.id,
          workspacePreparationQueued: developerPreparationQueued,
        } : {}),
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
