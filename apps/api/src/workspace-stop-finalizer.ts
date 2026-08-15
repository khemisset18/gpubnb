import {
  BookingStatus,
  JobStatus,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  Prisma,
  SessionTerminationReason,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Redis } from 'ioredis';

const STOPPABLE = [
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.READY,
] as const;

const TERMINAL = [
  WorkspaceSessionStatus.COMPLETED,
  WorkspaceSessionStatus.TIMED_OUT,
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
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
] as const;

const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
  BookingStatus.DEGRADED,
] as const;

export type WorkspaceStopFinalization = {
  sessionId: string;
  alreadyFinalized: boolean;
  activated: boolean;
  machineReleased: boolean;
};

export class WorkspaceStopFinalizationError extends Error {
  constructor(public readonly code: 'workspace_stop_session_not_found' | 'workspace_stop_not_stoppable') {
    super(code);
    this.name = 'WorkspaceStopFinalizationError';
  }
}

function activatedKey(sessionId: string): string {
  return `workspace-gateway:ws-session-activated:${sessionId}`;
}

export async function finalizeVerifiedDeveloperStop(
  db: PrismaClient,
  redis: Redis,
  sessionId: string,
  machineId: string,
  endedAt = new Date(),
): Promise<WorkspaceStopFinalization> {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`;

    const row = await tx.workspaceSession.findFirst({
      where: {
        id: sessionId,
        machineId,
        machineWorkspace: { workspace: { slug: 'developer' } },
      },
      select: { id: true, bookingId: true, startedAt: true, status: true },
    });
    if (!row) throw new WorkspaceStopFinalizationError('workspace_stop_session_not_found');

    if ((TERMINAL as readonly WorkspaceSessionStatus[]).includes(row.status)) {
      return {
        sessionId: row.id,
        alreadyFinalized: true,
        activated: row.startedAt !== null,
        machineReleased: false,
      };
    }
    if (!(STOPPABLE as readonly WorkspaceSessionStatus[]).includes(row.status)) {
      throw new WorkspaceStopFinalizationError('workspace_stop_not_stoppable');
    }

    const neverActivated = row.startedAt === null;
    await tx.workspaceSession.update({
      where: { id: row.id },
      data: {
        status: neverActivated ? WorkspaceSessionStatus.TIMED_OUT : WorkspaceSessionStatus.COMPLETED,
        endedAt,
        connectionMetadata: {},
        ...(neverActivated
          ? {
              terminationReason: SessionTerminationReason.TIMEOUT,
              preparationStep: 'INTERACTIVE_CONNECTION_TIMEOUT',
            }
          : {}),
        events: {
          create: {
            actorType: 'AGENT',
            actorId: machineId,
            action: neverActivated
              ? 'INTERACTIVE_CONNECTION_NEVER_ESTABLISHED'
              : 'GATEWAY_CLEANUP_VERIFIED',
          },
        },
      },
    });

    if (neverActivated) {
      await tx.booking.updateMany({
        where: {
          id: row.bookingId,
          status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] },
        },
        data: { status: BookingStatus.DEGRADED },
      });
      await tx.payment.updateMany({
        where: { bookingId: row.bookingId, status: PaymentStatus.ESCROW_FUNDED },
        data: { status: PaymentStatus.SETTLEMENT_PENDING },
      });
    }

    const machineUpdate = await tx.machine.updateMany({
      where: {
        id: machineId,
        moderationStatus: ModerationStatus.CLEAR,
        workspaceSessions: {
          none: {
            id: { not: row.id },
            status: { in: [...ACTIVE_SESSION_STATUSES] },
          },
        },
        jobs: { none: { status: { in: [...ACTIVE_JOB_STATUSES] } } },
        listings: {
          none: {
            bookings: {
              some: {
                id: { not: row.bookingId },
                status: { in: [...ACTIVE_BOOKING_STATUSES] },
              },
            },
          },
        },
      },
      data: {
        operational: neverActivated
          ? MachineOperational.DEGRADED
          : MachineOperational.AVAILABLE,
      },
    });

    return {
      sessionId: row.id,
      alreadyFinalized: false,
      activated: !neverActivated,
      machineReleased: machineUpdate.count === 1,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  await redis.del(activatedKey(sessionId));
  return result;
}
