import { BookingStatus, JobStatus, JobType, MachineOperational, PaymentStatus, PrismaClient, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';
import { config } from './config.js';

const TERMINAL_JOB_STATUSES: JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
  JobStatus.TIMED_OUT,
  JobStatus.REJECTED,
  JobStatus.QUARANTINED,
];

const ACTIVE_DEVELOPER_SESSION_STATUSES: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
];

const ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES: JobStatus[] = [
  JobStatus.QUEUED,
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
];

const DEVELOPER_SESSION_FILTER = {
  machineWorkspace: { workspace: { slug: 'developer' } },
} as const;

// Whether AWAITING_DEPOSIT bookings get auto-funded without a real payment. Two independent
// paths, both required to stay safe once a real escrow program is deployed:
// - DEV_PAYMENT_BYPASS: local/dev only, forbidden outright in production (see config.ts).
// - BETA_TEST_DEV_BYPASS: allowed in production, but only while ESCROW_PROGRAM_ID is still the
//   NOT_DEPLOYED_YET placeholder, so it becomes a no-op the moment real escrow is configured.
function devBypassActive(): boolean {
  return (
    (config.NODE_ENV !== 'production' && config.DEV_PAYMENT_BYPASS === 'true') ||
    (config.BETA_TEST_DEV_BYPASS === 'true' && config.ESCROW_PROGRAM_ID === 'NOT_DEPLOYED_YET')
  );
}

export async function reconcileDevelopmentBookings(db: PrismaClient, now = new Date()): Promise<{
  funded: number;
  queued: number;
  completed: number;
  degraded: number;
  recoveredDeveloper: number;
}> {
  let funded = 0;
  let queued = 0;
  let completed = 0;
  let degraded = 0;
  let recoveredDeveloper = 0;

  // A beta diagnostic can be queued in the short interval between auto-funding a
  // booking and the renter creating the Developer session. If that diagnostic
  // finishes after the Developer request, older code marked the whole booking
  // COMPLETED and made the still-PREPARING workspace disappear from the active UI.
  // Repair only that exact, auditable state: an unexpired Developer session with a
  // live WORKSPACE_PREPARE job. Legitimately completed rentals have terminal
  // workspace sessions and can never match this recovery query.
  const racedDeveloperSessions = await db.workspaceSession.findMany({
    where: {
      status: { in: ACTIVE_DEVELOPER_SESSION_STATUSES },
      expiresAt: { gt: now },
      booking: { status: BookingStatus.COMPLETED },
      ...DEVELOPER_SESSION_FILTER,
      job: {
        is: {
          type: JobType.WORKSPACE_PREPARE,
          status: { in: ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES },
        },
      },
    },
    select: { id: true, bookingId: true, machineId: true },
    take: 50,
    orderBy: { createdAt: 'asc' },
  });

  for (const workspace of racedDeveloperSessions) {
    const recovered = await db.$transaction(async (tx) => {
      const booking = await tx.booking.updateMany({
        where: {
          id: workspace.bookingId,
          status: BookingStatus.COMPLETED,
          workspaceSessions: {
            some: {
              id: workspace.id,
              status: { in: ACTIVE_DEVELOPER_SESSION_STATUSES },
              ...DEVELOPER_SESSION_FILTER,
              job: {
                is: {
                  type: JobType.WORKSPACE_PREPARE,
                  status: { in: ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES },
                },
              },
            },
          },
        },
        data: { status: BookingStatus.STARTING },
      });
      if (booking.count !== 1) return false;
      await tx.machine.updateMany({
        where: { id: workspace.machineId, operational: MachineOperational.AVAILABLE },
        data: { operational: MachineOperational.RESERVED },
      });
      await tx.workspaceSession.update({
        where: { id: workspace.id },
        data: {
          events: {
            create: {
              actorType: 'PLATFORM',
              action: 'DIAGNOSTIC_COMPLETION_RACE_RECOVERED',
              details: { bookingId: workspace.bookingId },
            },
          },
        },
      });
      return true;
    });
    if (recovered) recoveredDeveloper += 1;
  }

  if (devBypassActive()) {
    const waiting = await db.booking.findMany({
      where: {
        status: BookingStatus.AWAITING_DEPOSIT,
        startsAt: { lte: new Date(now.getTime() + 5 * 60_000) },
        endsAt: { gt: now },
      },
      select: { id: true, quotedLamports: true },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });
    for (const booking of waiting) {
      const changed = await db.$transaction(async (tx) => {
        const update = await tx.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.AWAITING_DEPOSIT },
          data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:${booking.id}` },
        });
        if (update.count !== 1) return false;
        await tx.payment.upsert({
          where: { bookingId: booking.id },
          update: { grossLamports: booking.quotedLamports, status: PaymentStatus.ESCROW_FUNDED },
          create: { bookingId: booking.id, grossLamports: booking.quotedLamports, status: PaymentStatus.ESCROW_FUNDED },
        });
        return true;
      });
      if (changed) funded += 1;
    }
  }

  const readyBookings = await db.booking.findMany({
    where: {
      status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] },
      startsAt: { lte: new Date(now.getTime() + 5 * 60_000) },
      endsAt: { gt: now },
      listing: {
        machine: {
          connectivity: 'ONLINE',
          lastCudaProbeOk: true,
          dockerAvailable: true,
          nvidiaRuntimeAvailable: true,
        },
      },
      // A renter who requested a real Developer Workspace session is going through
      // that lifecycle (workspace-renter-routes.ts), not this dev-bypass shortcut.
      // Without this exclusion, this reconciler would run an unrelated GPU_DIAGNOSTIC
      // job and mark the booking COMPLETED/DEGRADED out from under an in-progress or
      // active Developer rental.
      workspaceSessions: { none: { machineWorkspace: { workspace: { slug: 'developer' } } } },
    },
    select: { id: true, buyerId: true, listing: { select: { machineId: true } } },
    take: 50,
    orderBy: { startsAt: 'asc' },
  });

  for (const booking of readyBookings) {
    const existing = await db.job.findFirst({
      where: { bookingId: booking.id, type: JobType.GPU_DIAGNOSTIC },
      select: { id: true },
    });
    if (existing) continue;
    const created = await db.$transaction(async (tx) => {
      const reserved = await tx.booking.updateMany({
        where: {
          id: booking.id,
          status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] },
          workspaceSessions: { none: DEVELOPER_SESSION_FILTER },
        },
        data: { status: BookingStatus.STARTING },
      });
      if (reserved.count !== 1) return false;
      await tx.job.create({
        data: {
          bookingId: booking.id,
          renterId: booking.buyerId,
          machineId: booking.listing.machineId,
          type: JobType.GPU_DIAGNOSTIC,
          parameters: {
            timeoutSeconds: 120,
            purpose: 'FIRST_RENTAL_E2E',
            ...(config.DEV_DIAGNOSTIC_IMAGE ? { diagnosticImage: config.DEV_DIAGNOSTIC_IMAGE } : {}),
          },
        },
      });
      await tx.machine.update({
        where: { id: booking.listing.machineId },
        data: { operational: MachineOperational.RESERVED },
      });
      return true;
    });
    if (created) queued += 1;
  }

  const finishedJobs = await db.job.findMany({
    where: {
      type: JobType.GPU_DIAGNOSTIC,
      status: { in: TERMINAL_JOB_STATUSES },
      booking: {
        status: { in: [BookingStatus.STARTING, BookingStatus.ACTIVE] },
        workspaceSessions: { none: DEVELOPER_SESSION_FILTER },
      },
    },
    select: { id: true, status: true, bookingId: true, machineId: true, result: true },
    take: 50,
    orderBy: { finishedAt: 'asc' },
  });

  for (const job of finishedJobs) {
    const success = job.status === JobStatus.COMPLETED
      && typeof job.result === 'object'
      && job.result !== null
      && (job.result as { gpuDetected?: unknown }).gpuDetected === true;
    const changed = await db.$transaction(async (tx) => {
      const bookingUpdate = await tx.booking.updateMany({
        where: {
          id: job.bookingId,
          status: { in: [BookingStatus.STARTING, BookingStatus.ACTIVE] },
          workspaceSessions: { none: DEVELOPER_SESSION_FILTER },
        },
        data: { status: success ? BookingStatus.COMPLETED : BookingStatus.DEGRADED },
      });
      if (bookingUpdate.count !== 1) return false;
      await tx.machine.update({
        where: { id: job.machineId },
        data: { operational: success ? MachineOperational.AVAILABLE : MachineOperational.DEGRADED },
      });
      return true;
    });
    if (changed) {
      if (success) completed += 1;
      else degraded += 1;
    }
  }

  return { funded, queued, completed, degraded, recoveredDeveloper };
}

// A FUNDED/STARTING booking that never reaches ACTIVE is a stuck listing lock, not a
// theoretical edge case - found live: a booking requesting a Developer Workspace is
// deliberately excluded from reconcileDevelopmentBookings' GPU_DIAGNOSTIC path above (a
// Developer rental has its own real lifecycle in workspace-gateway.ts, and this reconciler
// must never race that). If the agent was offline/broken at the moment it should have picked
// up the workspace preparation - exactly what happened during earlier installer/service
// troubleshooting on the test machine - that booking's status simply never advances, and it
// keeps counting against every future booking attempt on that listing (time_slot_unavailable)
// for its entire original duration, which can be up to 24h. This is a plain safety-net
// timeout, independent of BETA_TEST_DEV_BYPASS: any booking whose start time is long past
// without ever reaching ACTIVE was never really active, so degrading it can never interrupt a
// renter who is actually using their session.
const STALLED_ACTIVATION_GRACE_MS = 20 * 60_000;
const ACTIVE_ACTIVATION_JOB_STATUSES = [
  JobStatus.QUEUED,
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
];

export async function reconcileStalledActivations(db: PrismaClient, now = new Date()): Promise<{ degraded: number }> {
  let degraded = 0;
  const stalled = await db.booking.findMany({
    where: {
      status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] },
      startsAt: { lt: new Date(now.getTime() - STALLED_ACTIVATION_GRACE_MS) },
      // A long first image pull is legitimate as long as the agent keeps refreshing
      // the job's updatedAt through progress reports. Only an activation with no
      // recently live job is abandoned.
      jobs: { none: { status: { in: ACTIVE_ACTIVATION_JOB_STATUSES }, updatedAt: { gte: new Date(now.getTime() - STALLED_ACTIVATION_GRACE_MS) } } },
    },
    select: { id: true, listing: { select: { machineId: true } } },
    take: 50,
  });
  for (const booking of stalled) {
    const changed = await db.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] } },
        data: { status: BookingStatus.DEGRADED },
      });
      if (updated.count !== 1) return false;
      await tx.job.updateMany({
        where: { bookingId: booking.id, status: JobStatus.QUEUED },
        data: { status: JobStatus.TIMED_OUT, errorCode: 'activation_stalled_timeout', finishedAt: now },
      });
      await tx.workspaceSession.updateMany({
        where: { bookingId: booking.id, status: { in: [WorkspaceSessionStatus.RESERVED, WorkspaceSessionStatus.PREPARING] } },
        data: { status: WorkspaceSessionStatus.TIMED_OUT, preparationStep: 'ACTIVATION_STALLED_TIMEOUT', endedAt: now, terminationReason: SessionTerminationReason.TIMEOUT },
      });
      await tx.machine.updateMany({
        where: { id: booking.listing.machineId, operational: MachineOperational.RESERVED },
        data: { operational: MachineOperational.AVAILABLE },
      });
      return true;
    });
    if (changed) degraded += 1;
  }
  return { degraded };
}
