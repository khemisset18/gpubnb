import {
  BookingStatus,
  JobStatus,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  PrismaClient,
  SessionTerminationReason,
  WorkspaceSessionStatus,
} from '@prisma/client';

// RC1 Phase 5 finding: sweepOfflineMachines (offline-sweep-service.ts) only fires when
// the MACHINE's heartbeat goes stale. A job whose own status reports were lost in
// flight (e.g. an API outage right as the agent tried to report RUNNING/COMPLETE) can
// be left stuck forever even though the agent later recovers and heartbeats normally —
// nothing ever re-evaluates that one job. This sweep closes that gap independently of
// machine connectivity, using each job's own updatedAt as the staleness signal.

const STALE_JOB_ERROR_CODE = 'job_stale_timeout';

// Jobs that already reached UPLOADING_RESULTS finished their real work — from the
// platform's view the workload may well have succeeded and only the report was lost,
// so FAILED (not TIMED_OUT) is the honest terminal status there. This also matches
// job-state.ts: UPLOADING_RESULTS -> TIMED_OUT is not a legal transition.
const STALE_JOB_TARGET_STATUS: Partial<Record<JobStatus, JobStatus>> = {
  [JobStatus.QUEUED]: JobStatus.TIMED_OUT,
  [JobStatus.ASSIGNED]: JobStatus.TIMED_OUT,
  [JobStatus.DOWNLOADING]: JobStatus.TIMED_OUT,
  [JobStatus.PREPARING]: JobStatus.TIMED_OUT,
  [JobStatus.RUNNING]: JobStatus.TIMED_OUT,
  [JobStatus.UPLOADING_RESULTS]: JobStatus.FAILED,
};

const ACTIVE_BOOKING_STATUSES = [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE] as const;
const ACTIVE_SESSION_STATUSES = [
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
] as const;

export type JobStalenessSweepResult = {
  cutoff: Date;
  jobsTimedOut: number;
  jobsFailed: number;
  bookingsDegraded: number;
  sessionsTimedOut: number;
  machinesReleased: number;
  machinesQuarantined: number;
  paymentsPendingSettlement: number;
};

const EMPTY_RESULT = (cutoff: Date): JobStalenessSweepResult => ({
  cutoff,
  jobsTimedOut: 0,
  jobsFailed: 0,
  bookingsDegraded: 0,
  sessionsTimedOut: 0,
  machinesReleased: 0,
  machinesQuarantined: 0,
  paymentsPendingSettlement: 0,
});

export async function sweepStaleJobs(
  db: PrismaClient,
  now: Date,
  staleAfterSeconds: number,
): Promise<JobStalenessSweepResult> {
  const cutoff = new Date(now.getTime() - staleAfterSeconds * 1000);
  const staleStatuses = Object.keys(STALE_JOB_TARGET_STATUS) as JobStatus[];

  return db.$transaction(async tx => {
    const staleJobs = await tx.job.findMany({
      where: { status: { in: staleStatuses }, updatedAt: { lt: cutoff } },
      select: { id: true, status: true, bookingId: true, machineId: true },
    });

    if (staleJobs.length === 0) return EMPTY_RESULT(cutoff);

    const timedOutIds = staleJobs.filter(job => STALE_JOB_TARGET_STATUS[job.status] === JobStatus.TIMED_OUT).map(job => job.id);
    const failedIds = staleJobs.filter(job => STALE_JOB_TARGET_STATUS[job.status] === JobStatus.FAILED).map(job => job.id);

    // Each updateMany is guarded by the exact source status it read above, so a
    // concurrent/repeated sweep run can never re-transition a job it (or another
    // sweep run) already moved to a terminal state: idempotent by construction, no
    // double events, no double payment/settlement writes.
    const [timedOutUpdate, failedUpdate] = await Promise.all([
      timedOutIds.length
        ? tx.job.updateMany({
            where: { id: { in: timedOutIds }, status: { in: [JobStatus.QUEUED, JobStatus.ASSIGNED, JobStatus.DOWNLOADING, JobStatus.PREPARING, JobStatus.RUNNING] } },
            data: { status: JobStatus.TIMED_OUT, errorCode: STALE_JOB_ERROR_CODE, finishedAt: now },
          })
        : { count: 0 },
      failedIds.length
        ? tx.job.updateMany({
            where: { id: { in: failedIds }, status: JobStatus.UPLOADING_RESULTS },
            data: { status: JobStatus.FAILED, errorCode: STALE_JOB_ERROR_CODE, finishedAt: now },
          })
        : { count: 0 },
    ]);

    const affectedJobIds = new Set([...timedOutIds, ...failedIds]);
    const affectedBookingIds = [...new Set(staleJobs.filter(job => affectedJobIds.has(job.id)).map(job => job.bookingId))];
    const claimedMachineIds = [...new Set(staleJobs.filter(job => affectedJobIds.has(job.id) && job.status !== JobStatus.QUEUED).map(job => job.machineId))];
    const claimedMachineIdSet = new Set(claimedMachineIds);
    const unclaimedMachineIds = [...new Set(staleJobs.filter(job => affectedJobIds.has(job.id) && job.status === JobStatus.QUEUED && !claimedMachineIdSet.has(job.machineId)).map(job => job.machineId))];

    const bookingUpdate = affectedBookingIds.length
      ? await tx.booking.updateMany({
          where: { id: { in: affectedBookingIds }, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
          data: { status: BookingStatus.DEGRADED },
        })
      : { count: 0 };

    const sessionUpdate = affectedBookingIds.length
      ? await tx.workspaceSession.updateMany({
          where: { bookingId: { in: affectedBookingIds }, status: { in: [...ACTIVE_SESSION_STATUSES] } },
          data: { status: WorkspaceSessionStatus.TIMED_OUT, endedAt: now, terminationReason: SessionTerminationReason.TIMEOUT },
        })
      : { count: 0 };

    // A QUEUED job was never claimed by an agent, so it cannot have created a runtime
    // container. Releasing that reservation is safe and prevents an abandoned 5%
    // preparation from blocking every later booking on the listing.
    const releasedMachineUpdate = unclaimedMachineIds.length
      ? await tx.machine.updateMany({
          where: { id: { in: unclaimedMachineIds }, moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED },
          data: { operational: MachineOperational.AVAILABLE },
        })
      : { count: 0 };

    // Once an agent has claimed a job, whether the workload container was actually
    // cleaned up on the physical host can
    // never be confirmed from this API process — there is no channel for the agent to
    // prove it after the fact. A stale job therefore NEVER returns its machine to
    // AVAILABLE on its own: it is quarantined (moderationStatus blocks all further
    // agent authentication, see authenticatedAgent() in server.ts) until a human
    // verifies the host and clears it. This is the "sinon QUARANTINED" branch for
    // every claimed job because proof of cleanup is not something this sweep can obtain.
    const machineUpdate = claimedMachineIds.length
      ? await tx.machine.updateMany({
          where: { id: { in: claimedMachineIds }, moderationStatus: ModerationStatus.CLEAR },
          data: { moderationStatus: ModerationStatus.QUARANTINED, operational: MachineOperational.UNAVAILABLE },
        })
      : { count: 0 };

    // Never settle as a success: a stale job can only push a funded payment toward
    // manual settlement review, exactly like the machine-offline sweep. It can never
    // move a payment to a paid-out/completed state.
    const paymentUpdate = affectedBookingIds.length
      ? await tx.payment.updateMany({
          where: { bookingId: { in: affectedBookingIds }, status: PaymentStatus.ESCROW_FUNDED },
          data: { status: PaymentStatus.SETTLEMENT_PENDING },
        })
      : { count: 0 };

    return {
      cutoff,
      jobsTimedOut: timedOutUpdate.count,
      jobsFailed: failedUpdate.count,
      bookingsDegraded: bookingUpdate.count,
      sessionsTimedOut: sessionUpdate.count,
      machinesReleased: releasedMachineUpdate.count,
      machinesQuarantined: machineUpdate.count,
      paymentsPendingSettlement: paymentUpdate.count,
    };
  }, { isolationLevel: 'Serializable' });
}
