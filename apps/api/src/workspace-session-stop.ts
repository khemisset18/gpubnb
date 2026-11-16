import {
  JobStatus, Prisma, PrismaClient, SessionTerminationReason, WorkspaceSessionStatus,
} from '@prisma/client';
import { runBookingTransaction } from './booking-transaction-retry.js';

// STOP is a monotonic transition. A late browser STOP must never revive a
// session that the Agent has already marked COMPLETED, TIMED_OUT or QUARANTINED.
const STOPPABLE: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.RESERVED, WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY, WorkspaceSessionStatus.RUNNING,
];
const STOP_ALREADY_REQUESTED: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.STOP_REQUESTED, WorkspaceSessionStatus.STOPPING,
];
type StopResult =
  | { kind: 'not_found' }
  | { kind: 'not_active'; status: WorkspaceSessionStatus }
  | { kind: 'accepted'; id: string; status: WorkspaceSessionStatus; alreadyRequested: boolean };

export async function requestWorkspaceSessionStop(
  db: PrismaClient, id: string, actorId: string,
): Promise<StopResult> {
  const permitted = { id, OR: [{ renterId: actorId }, { machine: { ownerId: actorId } }] };
  // Authenticate the actor independently of status, so a terminal session
  // returns 409 instead of disclosing a machine or booking belonging to others.
  const original = await db.workspaceSession.findFirst({
    where: permitted,
    select: { status: true, jobId: true, machine: { select: { ownerId: true } } },
  });
  if (!original) return { kind: 'not_found' };
  if (STOP_ALREADY_REQUESTED.includes(original.status))
    return { kind: 'accepted', id, status: original.status, alreadyRequested: true };
  if (!STOPPABLE.includes(original.status))
    return { kind: 'not_active', status: original.status };

  const ownerStop = original.machine.ownerId === actorId;
  return runBookingTransaction(db, async tx => {
    // The compare-and-set is evaluated against the current PostgreSQL row,
    // not the status read before this transaction. Another STOP, Agent cleanup,
    // or timeout cannot be overwritten by stale browser state.
    const changed = await tx.workspaceSession.updateMany({
      where: { ...permitted, status: { in: STOPPABLE } },
      data: {
        status: WorkspaceSessionStatus.STOP_REQUESTED,
        terminationReason: ownerStop
          ? SessionTerminationReason.OWNER_EMERGENCY_STOP
          : SessionTerminationReason.USER_STOP,
      },
    });
    if (changed.count !== 1) {
      const latest = await tx.workspaceSession.findFirst({
        where: permitted, select: { status: true },
      });
      if (!latest) return { kind: 'not_found' } as const;
      if (STOP_ALREADY_REQUESTED.includes(latest.status))
        return { kind: 'accepted', id, status: latest.status, alreadyRequested: true } as const;
      return { kind: 'not_active', status: latest.status } as const;
    }
    // Only the winner can create an event/cancel a job. Repeated STOP calls
    // cannot rewrite a prior termination reason or create duplicate events.
    await tx.workspaceSessionEvent.create({
      data: {
        sessionId: id, actorType: ownerStop ? 'OWNER' : 'RENTER', actorId,
        action: ownerStop ? 'EMERGENCY_STOP_REQUESTED' : 'STOP_REQUESTED',
      },
    });
    if (original.jobId) {
      await tx.job.updateMany({
        where: {
          id: original.jobId,
          status: {
            in: [
              JobStatus.QUEUED, JobStatus.ASSIGNED, JobStatus.DOWNLOADING,
              JobStatus.PREPARING, JobStatus.RUNNING, JobStatus.UPLOADING_RESULTS,
            ],
          },
        },
        data: { status: JobStatus.CANCEL_REQUESTED, cancelRequestedAt: new Date() },
      });
    }
    return {
      kind: 'accepted', id, status: WorkspaceSessionStatus.STOP_REQUESTED,
      alreadyRequested: false,
    } as const;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000, timeout: 10_000,
  });
}
