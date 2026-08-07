import { JobStatus, JobType, ModerationStatus, type Prisma } from '@prisma/client';

// RC1 risk R3: nothing prevented GET /agent/jobs/next/:machineId from handing out a
// second job for a physical GPU that was already busy running a first one. This is
// the declarative source of truth for which job types need exclusive GPU access, and
// the shared conflict-detection query used at claim time (server.ts).

// Every job type must explicitly declare whether it needs exclusive GPU access —
// silence is never read as "safe to run concurrently" (see isExclusiveJobType's
// fail-closed default for any type missing from this map). All three current job
// types pin the container to the same physical device: diagnostic_command and
// gpu_proof_command in runner.py both pass `--gpus=device=0`, and
// workspace_health_command either falls back to diagnostic_command or requests the
// same device flag for the "developer" workspace slug. No job type was found to be
// safe to run alongside another GPU workload on the same card, so all three are
// exclusive.
export const JOB_TYPE_EXCLUSIVITY: Record<JobType, boolean> = {
  [JobType.GPU_DIAGNOSTIC]: true,
  [JobType.WORKSPACE_PREPARE]: true,
  [JobType.GPU_PROOF]: true,
};

export function isExclusiveJobType(type: JobType): boolean {
  return JOB_TYPE_EXCLUSIVITY[type] ?? true; // fail closed for any type this map doesn't cover
}

// Statuses in which a job is actually occupying the GPU: after it has been assigned
// to run, before it reaches a terminal state. QUEUED is deliberately excluded — a
// queued job has not touched the GPU yet, so it can never itself be the reason
// another claim is refused.
export const GPU_OCCUPYING_JOB_STATUSES: JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
];

export type GpuLockScope = { gpuUuid: string } | { machineId: string };

/**
 * Locks per physical GPU UUID when the machine has reported one — the precise scope,
 * and the only thing that can catch two different Machine rows that happen to report
 * the same physical card (a duplicated agent install, a cloned VM, or a spoofed
 * inventory). Falls back to a per-machine scope, fail-closed, when no GPU UUID is
 * known yet: lacking proof of a shared physical identity, two different machines are
 * never merged into one lock scope, but the one machine we ARE sure about is still
 * strictly enforced.
 */
export function gpuLockScope(machine: { id: string; gpuUuid: string | null }): GpuLockScope {
  return machine.gpuUuid ? { gpuUuid: machine.gpuUuid } : { machineId: machine.id };
}

function jobScopeWhere(scope: GpuLockScope): Prisma.JobWhereInput {
  return 'gpuUuid' in scope ? { machine: { gpuUuid: scope.gpuUuid } } : { machineId: scope.machineId };
}

export type GpuExclusivityConflict =
  | { reason: 'gpu_occupied_by_another_job'; jobId: string }
  | { reason: 'gpu_shares_a_quarantined_machine'; machineId: string };

/**
 * The one check every exclusive-job claim must pass. Two parts, both required to
 * make "release only after confirmed cleanup" actually hold across the GPU-UUID
 * scope, not just within one machine row:
 *
 *  1. No other job in the same scope is currently occupying the GPU (ASSIGNED
 *     through UPLOADING_RESULTS/CANCEL_REQUESTED). This is the core exclusivity
 *     guarantee: two concurrent exclusive jobs on the same card are never both
 *     allowed to run.
 *
 *  2. No OTHER machine reporting the same GPU UUID is currently QUARANTINED.
 *     Quarantine is exactly what an unverified-cleanup terminal job (see
 *     CLEANUP_UNVERIFIED_ERROR_CODES / job-staleness-sweep.ts) already leaves
 *     behind, and it already blocks that machine's own authenticatedAgent() calls —
 *     but without this check, a second machine merely reporting the same physical
 *     GPU UUID could still claim a fresh job on it the moment the first job goes
 *     terminal, even though nobody ever confirmed the GPU was actually cleaned up.
 *     Quarantine on ANY machine sharing the UUID is treated as the GPU still being
 *     held until a human clears it.
 */
export async function findGpuExclusivityConflict(
  tx: Prisma.TransactionClient,
  candidateJobId: string,
  machine: { id: string; gpuUuid: string | null },
): Promise<GpuExclusivityConflict | null> {
  const scope = gpuLockScope(machine);

  const occupyingJob = await tx.job.findFirst({
    where: { id: { not: candidateJobId }, status: { in: GPU_OCCUPYING_JOB_STATUSES }, ...jobScopeWhere(scope) },
    select: { id: true },
  });
  if (occupyingJob) return { reason: 'gpu_occupied_by_another_job', jobId: occupyingJob.id };

  if ('gpuUuid' in scope) {
    const quarantinedSharer = await tx.machine.findFirst({
      where: { id: { not: machine.id }, gpuUuid: scope.gpuUuid, moderationStatus: ModerationStatus.QUARANTINED },
      select: { id: true },
    });
    if (quarantinedSharer) return { reason: 'gpu_shares_a_quarantined_machine', machineId: quarantinedSharer.id };
  }

  return null;
}
