import {
  BookingStatus,
  JobStatus,
  JobType,
  MachineWorkspaceState,
  SessionTerminationReason,
  WorkspaceRelease,
  WorkspaceSessionStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { requestPreparation, requestRentalStop } from './rental-delivery-service.js';

export type TransactionClient = Prisma.TransactionClient;

type Database = Pick<PrismaClient, '$transaction'>;

const ACTIVE_JOB_STATUSES: JobStatus[] = [
  JobStatus.QUEUED,
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
];

const PREPARABLE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
];

const STOPPABLE_SESSION_STATUSES: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
];

export interface PreparationResult {
  id: string;
  status: WorkspaceSessionStatus;
  expiresAt: Date;
  resourceLimits: Prisma.JsonValue;
  preparationProgress: number;
  preparationStep: string | null;
}

export async function prepareComputeRental(
  db: Database,
  bookingId: string,
  renterId: string,
): Promise<PreparationResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.workspaceSession.findUnique({
      where: { bookingId },
      select: {
        id: true,
        renterId: true,
        status: true,
        expiresAt: true,
        resourceLimits: true,
        preparationProgress: true,
        preparationStep: true,
      },
    });

    if (existing) {
      if (existing.renterId !== renterId) throw new Error('workspace_session_forbidden');
      return existing;
    }

    const booking = await tx.booking.findFirst({
      where: {
        id: bookingId,
        buyerId: renterId,
        status: { in: PREPARABLE_BOOKING_STATUSES },
      },
      include: { listing: { select: { id: true, machineId: true } } },
    });
    if (!booking) throw new Error('funded_booking_required');

    const machineWorkspace = await tx.machineWorkspace.findFirst({
      where: {
        machineId: booking.listing.machineId,
        enabledByOwner: true,
        workspace: { slug: 'compute', release: WorkspaceRelease.BETA },
        state: { in: [MachineWorkspaceState.READY, MachineWorkspaceState.LIMITED] },
      },
      select: { id: true, configuration: true },
    });
    if (!machineWorkspace) throw new Error('compute_workspace_not_enabled');

    const resourceLimits = {
      maxRamMiB: 512,
      maxCpuCores: 1,
      storageQuotaMiB: 1024,
      networkAccess: 'NONE',
      autoStopMinutes: 10,
      ...(isPlainObject(machineWorkspace.configuration) ? machineWorkspace.configuration : {}),
    } satisfies Prisma.InputJsonObject;

    const created = await tx.workspaceSession.create({
      data: {
        bookingId,
        renterId,
        machineId: booking.listing.machineId,
        machineWorkspaceId: machineWorkspace.id,
        status: WorkspaceSessionStatus.PREPARING,
        isolationType: 'DOCKER',
        resourceLimits,
        preparationProgress: 5,
        preparationStep: 'RESERVATION_CONFIRMED',
        preparationRequestedAt: new Date(),
        readyDeadlineAt: new Date(Math.max(Date.now(), booking.startsAt.getTime() - 120_000)),
        expiresAt: booking.endsAt,
        preparationAttempts: 1,
        events: {
          create: {
            actorType: 'PLATFORM',
            action: 'PREPARATION_REQUESTED',
            details: { target: 'BEFORE_RENTER_ARRIVAL' },
          },
        },
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        resourceLimits: true,
        preparationProgress: true,
        preparationStep: true,
      },
    });

    const job = await tx.job.create({
      data: {
        bookingId,
        renterId,
        machineId: booking.listing.machineId,
        type: JobType.GPU_PROOF,
        parameters: {
          durationSeconds: Math.max(30, Math.min(600, booking.expectedSeconds)),
          workspaceSlug: 'compute',
        },
      },
      select: { id: true },
    });

    await tx.workspaceSession.update({ where: { id: created.id }, data: { jobId: job.id } });
    await requestPreparation(tx, {
      bookingId,
      machineId: booking.listing.machineId,
      renterId,
      listingId: booking.listing.id,
      sessionId: created.id,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
    });

    return created;
  }, { isolationLevel: 'Serializable' });
}

export async function stopRentalSession(
  db: Database,
  sessionId: string,
  actorId: string,
): Promise<{ id: string; status: WorkspaceSessionStatus }> {
  return db.$transaction(async (tx) => {
    const session = await tx.workspaceSession.findFirst({
      where: {
        id: sessionId,
        OR: [{ renterId: actorId }, { machine: { ownerId: actorId } }],
      },
      include: {
        booking: { select: { id: true, listingId: true, startsAt: true, endsAt: true } },
        machine: { select: { id: true, ownerId: true } },
      },
    });
    if (!session) throw new Error('session_not_found');
    if (!STOPPABLE_SESSION_STATUSES.includes(session.status)) throw new Error('session_not_active');

    const ownerStop = session.machine.ownerId === actorId;
    const status = WorkspaceSessionStatus.STOP_REQUESTED;

    await tx.workspaceSession.update({
      where: { id: session.id },
      data: {
        status,
        terminationReason: ownerStop
          ? SessionTerminationReason.OWNER_EMERGENCY_STOP
          : SessionTerminationReason.USER_STOP,
        events: {
          create: {
            actorType: ownerStop ? 'OWNER' : 'RENTER',
            actorId,
            action: ownerStop ? 'EMERGENCY_STOP_REQUESTED' : 'STOP_REQUESTED',
          },
        },
      },
    });

    if (session.jobId) {
      await tx.job.updateMany({
        where: { id: session.jobId, status: { in: ACTIVE_JOB_STATUSES } },
        data: { status: JobStatus.CANCEL_REQUESTED, cancelRequestedAt: new Date() },
      });
    }

    await requestRentalStop(tx, {
      bookingId: session.booking.id,
      machineId: session.machine.id,
      renterId: session.renterId,
      listingId: session.booking.listingId,
      sessionId: session.id,
      startsAt: session.booking.startsAt,
      endsAt: session.booking.endsAt,
    }, ownerStop ? 'owner' : 'renter');

    return { id: session.id, status };
  }, { isolationLevel: 'Serializable' });
}

function isPlainObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
