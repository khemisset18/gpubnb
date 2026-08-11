import {
  BookingStatus,
  JobStatus,
  JobType,
  Prisma,
  type PrismaClient,
  WorkspaceSessionStatus,
} from '@prisma/client';

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
): Promise<void> {
  const sequence = await tx.jobAttempt.count({ where: { jobId } }) + 1;
  await tx.jobAttempt.create({ data: { jobId, sequence, agentVersion } });
}

/**
 * Claims one job for an agent. A stale Developer preparation is recovered before
 * a newer queued job because image preparation is immutable and idempotent, while
 * silently abandoning an already assigned job leaves the renter stuck forever.
 * GPU proof and diagnostic jobs are deliberately never reclaimed here.
 */
export async function claimNextAgentJobInTransaction(
  tx: ClaimTransaction,
  options: AgentJobClaimOptions,
) {
  const now = options.now ?? new Date();
  const reclaimCutoff = new Date(
    now.getTime() - Math.max(30, options.reclaimAfterSeconds) * 1000,
  );

  const abandoned = await tx.job.findFirst({
    where: {
      machineId: options.machineId,
      type: JobType.WORKSPACE_PREPARE,
      status: { in: RECLAIMABLE_PREPARATION_STATUSES },
      updatedAt: { lte: reclaimCutoff },
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
        updatedAt: { lte: reclaimCutoff },
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
    await createAttempt(tx, abandoned.id, options.agentVersion);
    return tx.job.findUnique({
      where: { id: abandoned.id },
      select: AGENT_JOB_SELECT,
    });
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

  await createAttempt(tx, queued.id, options.agentVersion);
  return tx.job.findUnique({
    where: { id: queued.id },
    select: AGENT_JOB_SELECT,
  });
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
