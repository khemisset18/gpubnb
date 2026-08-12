import {
  BookingStatus,
  JobStatus,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  Prisma,
  PrismaClient,
  SessionTerminationReason,
  WorkspaceSessionStatus,
} from '@prisma/client';

const STALE_JOB_ERROR_CODE = 'job_stale_timeout';

const STALE_JOB_TARGET_STATUS: Partial<Record<JobStatus, JobStatus>> = {
  [JobStatus.QUEUED]: JobStatus.TIMED_OUT,
  [JobStatus.ASSIGNED]: JobStatus.TIMED_OUT,
  [JobStatus.DOWNLOADING]: JobStatus.TIMED_OUT,
  [JobStatus.PREPARING]: JobStatus.TIMED_OUT,
  [JobStatus.RUNNING]: JobStatus.TIMED_OUT,
  [JobStatus.UPLOADING_RESULTS]: JobStatus.FAILED,
};

const CLAIMED_STALE_STATUSES: JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
];

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

function claimedJobIsStale(now: Date, cutoff: Date): Prisma.JobWhereInput {
  return {
    OR: [
      { leaseExpiresAt: { lt: now } },
      // Rollout fallback for jobs claimed before the explicit-lease migration.
      { leaseExpiresAt: null, updatedAt: { lt: cutoff } },
    ],
  };
}

export async function sweepStaleJobs(
  db: PrismaClient,
  now: Date,
  staleAfterSeconds: number,
): Promise<JobStalenessSweepResult> {
  const cutoff = new Date(now.getTime() - staleAfterSeconds * 1000);
  const claimedStale = claimedJobIsStale(now, cutoff);

  return db.$transaction(async tx => {
    const staleJobs = await tx.job.findMany({
      where: {
        OR: [
          { status: JobStatus.QUEUED, updatedAt: { lt: cutoff } },
          { status: { in: CLAIMED_STALE_STATUSES }, ...claimedStale },
        ],
      },
      select: { id: true, status: true, bookingId: true, machineId: true },
    });

    if (staleJobs.length === 0) return EMPTY_RESULT(cutoff);

    // Important: side effects are derived only from transitions this transaction
    // actually wins. The old implementation derived them from the initial read set,
    // so a concurrent agent report could win the job update while the stale sweep
    // still degraded the booking/quarantined the machine from stale information.
    const transitioned: typeof staleJobs = [];
    let jobsTimedOut = 0;
    let jobsFailed = 0;

    for (const job of staleJobs) {
      const target = STALE_JOB_TARGET_STATUS[job.status];
      if (!target) continue;
      const stillStale: Prisma.JobWhereInput = job.status === JobStatus.QUEUED
        ? { updatedAt: { lt: cutoff } }
        : claimedStale;
      const update = await tx.job.updateMany({
        where: { id: job.id, status: job.status, ...stillStale },
        data: {
          status: target,
          errorCode: STALE_JOB_ERROR_CODE,
          finishedAt: now,
          leaseExpiresAt: null,
          lastAgentReportAt: now,
        },
      });
      if (update.count !== 1) continue;
      transitioned.push(job);
      if (target === JobStatus.TIMED_OUT) jobsTimedOut += 1;
      else jobsFailed += 1;
      await tx.jobAttempt.updateMany({
        where: { jobId: job.id, finishedAt: null },
        data: { finishedAt: now, failureReason: STALE_JOB_ERROR_CODE },
      });
    }

    if (transitioned.length === 0) return EMPTY_RESULT(cutoff);

    const affectedBookingIds = [...new Set(transitioned.map(job => job.bookingId))];
    const claimedMachineIds = [...new Set(transitioned.filter(job => job.status !== JobStatus.QUEUED).map(job => job.machineId))];
    const claimedMachineIdSet = new Set(claimedMachineIds);
    const unclaimedMachineIds = [...new Set(
      transitioned
        .filter(job => job.status === JobStatus.QUEUED && !claimedMachineIdSet.has(job.machineId))
        .map(job => job.machineId),
    )];

    const bookingUpdate = await tx.booking.updateMany({
      where: { id: { in: affectedBookingIds }, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
      data: { status: BookingStatus.DEGRADED },
    });

    const sessionUpdate = await tx.workspaceSession.updateMany({
      where: { bookingId: { in: affectedBookingIds }, status: { in: [...ACTIVE_SESSION_STATUSES] } },
      data: { status: WorkspaceSessionStatus.TIMED_OUT, endedAt: now, terminationReason: SessionTerminationReason.TIMEOUT },
    });

    const releasedMachineUpdate = unclaimedMachineIds.length
      ? await tx.machine.updateMany({
          where: { id: { in: unclaimedMachineIds }, moderationStatus: ModerationStatus.CLEAR, operational: MachineOperational.RESERVED },
          data: { operational: MachineOperational.AVAILABLE },
        })
      : { count: 0 };

    // Once an agent has claimed a job, cleanup cannot be proven from this API
    // process. Fail closed: a stale claimed workload never makes the machine
    // AVAILABLE by itself.
    const machineUpdate = claimedMachineIds.length
      ? await tx.machine.updateMany({
          where: { id: { in: claimedMachineIds }, moderationStatus: ModerationStatus.CLEAR },
          data: { moderationStatus: ModerationStatus.QUARANTINED, operational: MachineOperational.UNAVAILABLE },
        })
      : { count: 0 };

    const paymentUpdate = await tx.payment.updateMany({
      where: { bookingId: { in: affectedBookingIds }, status: PaymentStatus.ESCROW_FUNDED },
      data: { status: PaymentStatus.SETTLEMENT_PENDING },
    });

    return {
      cutoff,
      jobsTimedOut,
      jobsFailed,
      bookingsDegraded: bookingUpdate.count,
      sessionsTimedOut: sessionUpdate.count,
      machinesReleased: releasedMachineUpdate.count,
      machinesQuarantined: machineUpdate.count,
      paymentsPendingSettlement: paymentUpdate.count,
    };
  }, { isolationLevel: 'Serializable' });
}
