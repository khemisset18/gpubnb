import {
  BookingStatus,
  JobStatus,
  JobType,
  Prisma,
  type PrismaClient,
  WorkspaceSessionStatus,
} from '@prisma/client';
import {
  createJobLeaseToken,
  hashJobLeaseToken,
  jobLeaseExpiresAt,
} from './job-execution-lease.js';

const ACTIVE_JOB_BOOKINGS: BookingStatus[] = [
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
];

const RECLAIMABLE_PREPARATION_STATUSES: JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
];

const AGENT_JOB_SELECT = {
  id: true,
  bookingId: true,
  type: true,
  status: true,
  parameters: true,
  workspaceSession: { select: { id: true } },
} satisfies Prisma.JobSelect;

type ClaimTransaction = Pick<
  Prisma.TransactionClient,
  'job' | 'jobAttempt' | 'workspaceSession'
>;

export interface AgentJobClaimOptions {
  machineId: string;
  agentVersion: string | null;
  now?: Date;
  reclaimAfterSeconds: number;
}

async function createAttempt(
  tx: ClaimTransaction,
  jobId: string,
  agentVersion: string | null,
) {
  const sequence = await tx.jobAttempt.count({ where: { jobId } }) + 1;
  return tx.jobAttempt.create({ data: { jobId, sequence, agentVersion } });
}

async function grantLease(
  tx: ClaimTransaction,
  jobId: string,
  agentVersion: string | null,
  now: Date,
  leaseSeconds: number,
) {
  const attempt = await createAttempt(tx, jobId, agentVersion);
  const leaseToken = createJobLeaseToken();
  const leaseExpiresAt = jobLeaseExpiresAt(now, leaseSeconds);
  await tx.job.update({
    where: { id: jobId },
    data: {
      currentAttemptId: attempt.id,
      leaseTokenHash: hashJobLeaseToken(leaseToken),
      leaseExpiresAt,
      lastAgentReportAt: now,
      updatedAt: now,
    },
  });
  const job = await tx.job.findUnique({
    where: { id: jobId },
    select: AGENT_JOB_SELECT,
  });
  return job ? { ...job, attemptId: attempt.id, leaseToken, leaseExpiresAt } : null;
}

/**
 * Claims one job for an agent. Every successful claim receives a unique attempt id
 * plus an opaque lease token. The API stores only the token hash. A stale Developer
 * preparation is recovered before a newer queued job; proof/diagnostic jobs remain
 * deliberately non-reclaimable.
 *
 * During the nullable-column rollout, an old active row with no explicit lease can
 * still be recovered using its legacy updatedAt cutoff. Every new/reclaimed claim is
 * immediately converted to the explicit lease protocol.
 */
export async function claimNextAgentJobInTransaction(
  tx: ClaimTransaction,
  options: AgentJobClaimOptions,
) {
  const now = options.now ?? new Date();
  const leaseSeconds = Math.max(30, options.reclaimAfterSeconds);
  const legacyReclaimCutoff = new Date(now.getTime() - leaseSeconds * 1000);
  const expiredLease = {
    OR: [
      { leaseExpiresAt: { lte: now } },
      { leaseExpiresAt: null, updatedAt: { lte: legacyReclaimCutoff } },
    ],
  } satisfies Prisma.JobWhereInput;

  const abandoned = await tx.job.findFirst({
    where: {
      machineId: options.machineId,
      type: JobType.WORKSPACE_PREPARE,
      status: { in: RECLAIMABLE_PREPARATION_STATUSES },
      ...expiredLease,
      booking: {
        status: { in: ACTIVE_JOB_BOOKINGS },
        endsAt: { gte: now },
      },
    },
    orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, status: true },
  });

  if (abandoned) {
    const recovered = await tx.job.updateMany({
      where: {
        id: abandoned.id,
        status: abandoned.status,
        ...expiredLease,
      },
      data: {
        status: JobStatus.ASSIGNED,
        errorCode: null,
        finishedAt: null,
        updatedAt: now,
      },
    });
    if (recovered.count !== 1) return null;

    await tx.jobAttempt.updateMany({
      where: { jobId: abandoned.id, finishedAt: null },
      data: { finishedAt: now, failureReason: 'agent_lease_expired' },
    });
    await tx.workspaceSession.updateMany({
      where: {
        jobId: abandoned.id,
        status: WorkspaceSessionStatus.PREPARING,
      },
      data: {
        preparationProgress: 25,
        preparationStep: 'AGENT_RECONNECTING',
      },
    });
    return grantLease(
      tx,
      abandoned.id,
      options.agentVersion,
      now,
      leaseSeconds,
    );
  }

  const queued = await tx.job.findFirst({
    where: {
      machineId: options.machineId,
      status: JobStatus.QUEUED,
      booking: {
        status: { in: ACTIVE_JOB_BOOKINGS },
        endsAt: { gte: now },
      },
      OR: [
        { type: JobType.WORKSPACE_PREPARE },
        { booking: { startsAt: { lte: new Date(now.getTime() + 300_000) } } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!queued) return null;

  const claimed = await tx.job.updateMany({
    where: { id: queued.id, status: JobStatus.QUEUED },
    data: { status: JobStatus.ASSIGNED, updatedAt: now },
  });
  if (claimed.count !== 1) return null;

  return grantLease(
    tx,
    queued.id,
    options.agentVersion,
    now,
    leaseSeconds,
  );
}

export async function claimNextAgentJob(
  db: PrismaClient,
  options: AgentJobClaimOptions,
) {
  return db.$transaction(
    tx => claimNextAgentJobInTransaction(tx, options),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
