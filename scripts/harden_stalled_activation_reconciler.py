from pathlib import Path

p=Path('apps/api/src/dev-booking-reconciler.ts')
s=p.read_text(encoding='utf-8')
s=s.replace("import { BookingStatus, JobStatus, JobType, MachineOperational, PaymentStatus, PrismaClient, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';","import { BookingStatus, JobStatus, JobType, MachineOperational, ModerationStatus, PaymentStatus, PrismaClient, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';",1)
start=s.index('  for (const booking of stalled) {',s.index('export async function reconcileStalledActivations'))
end=s.index('  return { degraded };',start)
new='''  for (const booking of stalled) {
    const changed = await db.$transaction(async (tx) => {
      // The outer query is only a candidate scan. Re-read inside the serializable
      // transaction because an Agent may have renewed/reclaimed after that scan.
      const activeJobs = await tx.job.findMany({
        where: { bookingId: booking.id, status: { in: ACTIVE_ACTIVATION_JOB_STATUSES } },
        select: { id: true, status: true, currentAttemptId: true, leaseExpiresAt: true, updatedAt: true },
      });
      const legacyFreshCutoff = new Date(now.getTime() - STALLED_ACTIVATION_GRACE_MS);
      const executionStillLive = activeJobs.some(job =>
        (job.leaseExpiresAt !== null && job.leaseExpiresAt > now)
        || (job.leaseExpiresAt === null && job.updatedAt >= legacyFreshCutoff),
      );
      if (executionStillLive) return false;

      // Once work was claimed, an expired lease proves loss of ownership, not proof
      // that the physical runtime was cleaned. Fail closed and quarantine.
      const claimedExecution = activeJobs.some(job =>
        job.currentAttemptId !== null || job.status !== JobStatus.QUEUED,
      );

      const updated = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] } },
        data: { status: BookingStatus.DEGRADED },
      });
      if (updated.count !== 1) return false;

      const activeJobIds = activeJobs.map(job => job.id);
      if (activeJobIds.length) {
        await tx.job.updateMany({
          where: { id: { in: activeJobIds }, status: { in: ACTIVE_ACTIVATION_JOB_STATUSES } },
          data: { status: JobStatus.TIMED_OUT, errorCode: 'activation_stalled_timeout', finishedAt: now, leaseExpiresAt: null },
        });
        await tx.jobAttempt.updateMany({
          where: { jobId: { in: activeJobIds }, finishedAt: null },
          data: { finishedAt: now, failureReason: 'activation_stalled_timeout' },
        });
      }

      await tx.workspaceSession.updateMany({
        where: { bookingId: booking.id, status: { in: [WorkspaceSessionStatus.RESERVED, WorkspaceSessionStatus.PREPARING] } },
        data: { status: WorkspaceSessionStatus.TIMED_OUT, preparationStep: 'ACTIVATION_STALLED_TIMEOUT', endedAt: now, terminationReason: SessionTerminationReason.TIMEOUT },
      });
      await tx.payment.updateMany({
        where: { bookingId: booking.id, status: PaymentStatus.ESCROW_FUNDED },
        data: { status: PaymentStatus.SETTLEMENT_PENDING },
      });

      if (claimedExecution) {
        await tx.machine.updateMany({
          where: { id: booking.listing.machineId, moderationStatus: ModerationStatus.CLEAR },
          data: { moderationStatus: ModerationStatus.QUARANTINED, operational: MachineOperational.UNAVAILABLE },
        });
      } else {
        await tx.machine.updateMany({
          where: {
            id: booking.listing.machineId,
            moderationStatus: ModerationStatus.CLEAR,
            operational: MachineOperational.RESERVED,
            jobs: { none: { status: { in: ACTIVE_ACTIVATION_JOB_STATUSES } } },
            workspaceSessions: { none: { status: { in: ACTIVE_DEVELOPER_SESSION_STATUSES } } },
          },
          data: { operational: MachineOperational.AVAILABLE },
        });
      }
      return true;
    }, { isolationLevel: 'Serializable' });
    if (changed) degraded += 1;
  }
'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8',newline='\n')
Path('.github/workflows/harden-stalled-activation.yml').unlink(missing_ok=True)
Path('scripts/harden_stalled_activation_reconciler.py').unlink(missing_ok=True)
