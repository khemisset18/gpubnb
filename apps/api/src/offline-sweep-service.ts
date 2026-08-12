import {
  BookingStatus,
  JobStatus,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  PaymentStatus,
  PrismaClient,
  SessionTerminationReason,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { buildOfflineSweepPlan, heartbeatCutoff } from './offline-sweep.js';

const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
  BookingStatus.DEGRADED,
] as const;

const ACTIVE_SESSION_STATUSES = [
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
] as const;

const ACTIVE_JOB_STATUSES = [
  JobStatus.QUEUED,
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
] as const;

export type OfflineSweepResult = {
  cutoff: Date;
  machinesOffline: number;
  listingsHidden: number;
  bookingsDegraded: number;
  sessionsFailed: number;
  jobsCancelled: number;
  paymentsPendingSettlement: number;
};

/**
 * Applies the authoritative offline transition in one serializable transaction.
 *
 * Financial invariant: validSeconds is never increased here. Settlement remains
 * based exclusively on previously accepted, signed usage samples. The payment is
 * moved to SETTLEMENT_PENDING rather than REFUNDED because the on-chain refund
 * still has to be confirmed before claiming that funds were returned.
 */
export async function sweepOfflineMachines(
  db: PrismaClient,
  now: Date,
  offlineAfterSeconds: number,
): Promise<OfflineSweepResult> {
  const cutoff = heartbeatCutoff(now, offlineAfterSeconds);

  return db.$transaction(async tx => {
    const machines = await tx.machine.findMany({
      where: {
        connectivity: MachineConnectivity.ONLINE,
        lastHeartbeatAt: { lt: cutoff },
      },
      select: { id: true },
    });
    const machineIds = machines.map(machine => machine.id);

    if (machineIds.length === 0) {
      return {
        cutoff,
        machinesOffline: 0,
        listingsHidden: 0,
        bookingsDegraded: 0,
        sessionsFailed: 0,
        jobsCancelled: 0,
        paymentsPendingSettlement: 0,
      };
    }

    const [bookings, sessions, jobs] = await Promise.all([
      tx.booking.findMany({
        where: {
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
          listing: { machineId: { in: machineIds } },
        },
        select: { id: true },
      }),
      tx.workspaceSession.findMany({
        where: {
          machineId: { in: machineIds },
          status: { in: [...ACTIVE_SESSION_STATUSES] },
        },
        select: { id: true },
      }),
      tx.job.findMany({
        where: {
          machineId: { in: machineIds },
          status: { in: [...ACTIVE_JOB_STATUSES] },
        },
        select: { id: true },
      }),
    ]);

    const plan = buildOfflineSweepPlan({
      machineIds,
      activeBookingIds: bookings.map(booking => booking.id),
      activeWorkspaceSessionIds: sessions.map(session => session.id),
      activeJobIds: jobs.map(job => job.id),
    });

    const machineUpdate = await tx.machine.updateMany({
      where: {
        id: { in: plan.machineIds },
        connectivity: MachineConnectivity.ONLINE,
        lastHeartbeatAt: { lt: cutoff },
      },
      data: {
        connectivity: MachineConnectivity.OFFLINE,
        operational: MachineOperational.UNAVAILABLE,
      },
    });

    const listingUpdate = await tx.gpuListing.updateMany({
      where: {
        machineId: { in: plan.listingMachineIds },
        status: { in: [ListingStatus.ACTIVE, ListingStatus.RESERVED] },
      },
      data: { status: ListingStatus.HIDDEN_OFFLINE },
    });

    const bookingUpdate = plan.degradedBookingIds.length
      ? await tx.booking.updateMany({
          where: {
            id: { in: plan.degradedBookingIds },
            status: { in: [...ACTIVE_BOOKING_STATUSES] },
          },
          data: { status: BookingStatus.DEGRADED },
        })
      : { count: 0 };

    const sessionUpdate = plan.failedWorkspaceSessionIds.length
      ? await tx.workspaceSession.updateMany({
          where: {
            id: { in: plan.failedWorkspaceSessionIds },
            status: { in: [...ACTIVE_SESSION_STATUSES] },
          },
          data: {
            status: WorkspaceSessionStatus.FAILED,
            endedAt: now,
            terminationReason: SessionTerminationReason.AGENT_OFFLINE,
          },
        })
      : { count: 0 };

    if (plan.failedWorkspaceSessionIds.length) {
      await tx.workspaceSessionEvent.createMany({
        data: plan.failedWorkspaceSessionIds.map(sessionId => ({
          sessionId,
          actorType: 'platform',
          action: 'agent_offline_timeout',
          details: {
            cutoff: cutoff.toISOString(),
            offlineAfterSeconds,
            paymentPolicy: 'validated_seconds_only',
          },
        })),
      });
    }

    const jobUpdate = plan.cancelledJobIds.length
      ? await tx.job.updateMany({
          where: {
            id: { in: plan.cancelledJobIds },
            status: { in: [...ACTIVE_JOB_STATUSES] },
          },
          data: {
            status: JobStatus.CANCELLED,
            errorCode: 'AGENT_OFFLINE',
            cancelRequestedAt: now,
            finishedAt: now,
            leaseExpiresAt: null,
          },
        })
      : { count: 0 };

    if (jobUpdate.count > 0) {
      await tx.jobAttempt.updateMany({
        where: {
          jobId: { in: plan.cancelledJobIds },
          finishedAt: null,
          job: { status: JobStatus.CANCELLED, errorCode: 'AGENT_OFFLINE' },
        },
        data: {
          finishedAt: now,
          failureReason: 'AGENT_OFFLINE',
        },
      });
    }

    const paymentUpdate = plan.degradedBookingIds.length
      ? await tx.payment.updateMany({
          where: {
            bookingId: { in: plan.degradedBookingIds },
            status: PaymentStatus.ESCROW_FUNDED,
          },
          data: { status: PaymentStatus.SETTLEMENT_PENDING },
        })
      : { count: 0 };

    return {
      cutoff,
      machinesOffline: machineUpdate.count,
      listingsHidden: listingUpdate.count,
      bookingsDegraded: bookingUpdate.count,
      sessionsFailed: sessionUpdate.count,
      jobsCancelled: jobUpdate.count,
      paymentsPendingSettlement: paymentUpdate.count,
    };
  }, { isolationLevel: 'Serializable' });
}
