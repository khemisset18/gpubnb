import { BookingStatus, JobStatus, JobType, MachineOperational, ModerationStatus, PaymentStatus, PrismaClient, ResourceAllocationStatus, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';
import { config } from './config.js';
import { confirmSettlement, requestSettlement } from './settlement-transactions.js';

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

const LIVE_ALLOCATION_STATUSES: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

const DEVELOPER_SESSION_FILTER = {
  machineWorkspace: { workspace: { slug: 'developer' } },
} as const;

export function betaTestDevBypassActive(): boolean {
  return (
    config.BETA_TEST_DEV_BYPASS === 'true' &&
    config.ESCROW_PROGRAM_ID === 'NOT_DEPLOYED_YET'
  );
}

function devBypassActive(): boolean {
  return (
    (config.NODE_ENV !== 'production' && config.DEV_PAYMENT_BYPASS === 'true') ||
    betaTestDevBypassActive()
  );
}

export async function reconcileDevelopmentBookings(db: PrismaClient, now = new Date()): Promise<{
  funded: number;
  queued: number;
  completed: number;
  degraded: number;
  quarantinedDeveloper: number;
}> {
  let funded = 0;
  let queued = 0;
  let completed = 0;
  let degraded = 0;
  let quarantinedDeveloper = 0;

  // Historical beta code could finish a GPU diagnostic after a Developer workspace
  // had already been requested, moving the booking to COMPLETED while the workspace
  // preparation remained live. COMPLETED releases the booking's DB allocation, so
  // moving that booking backwards to STARTING would execute without a resource lock.
  // Fail closed instead: fence the job/session, send escrow to settlement and quarantine
  // the host because an already-claimed runtime cannot be proven cleaned from the API.
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
    select: { id: true, bookingId: true, machineId: true, jobId: true },
    take: 50,
    orderBy: { createdAt: 'asc' },
  });

  for (const workspace of racedDeveloperSessions) {
    const quarantined = await db.$transaction(async (tx) => {
      const session = await tx.workspaceSession.updateMany({
        where: {
          id: workspace.id,
          status: { in: ACTIVE_DEVELOPER_SESSION_STATUSES },
          booking: { status: BookingStatus.COMPLETED },
          ...DEVELOPER_SESSION_FILTER,
          job: {
            is: {
              type: JobType.WORKSPACE_PREPARE,
              status: { in: ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES },
            },
          },
        },
        data: {
          status: WorkspaceSessionStatus.QUARANTINED,
          endedAt: now,
          terminationReason: SessionTerminationReason.SECURITY_POLICY,
          preparationStep: 'BOOKING_COMPLETED_WITH_LIVE_RUNTIME',
        },
      });
      if (session.count !== 1) return false;

      if (workspace.jobId) {
        await tx.job.updateMany({
          where: { id: workspace.jobId, status: { in: ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES } },
          data: {
            status: JobStatus.QUARANTINED,
            errorCode: 'booking_completed_with_live_runtime',
            finishedAt: now,
            leaseExpiresAt: null,
          },
        });
        await tx.jobAttempt.updateMany({
          where: { jobId: workspace.jobId, finishedAt: null },
          data: { finishedAt: now, failureReason: 'booking_completed_with_live_runtime' },
        });
      }

      await tx.payment.updateMany({
        where: { bookingId: workspace.bookingId, status: PaymentStatus.ESCROW_FUNDED },
        data: { status: PaymentStatus.SETTLEMENT_PENDING },
      });
      await tx.machine.updateMany({
        where: { id: workspace.machineId, moderationStatus: ModerationStatus.CLEAR },
        data: { moderationStatus: ModerationStatus.QUARANTINED, operational: MachineOperational.UNAVAILABLE },
      });
      await tx.workspaceSession.update({
        where: { id: workspace.id },
        data: {
          events: {
            create: {
              actorType: 'PLATFORM',
              action: 'DIAGNOSTIC_COMPLETION_RACE_QUARANTINED',
              details: { bookingId: workspace.bookingId, reason: 'resource_allocation_already_released' },
            },
          },
        },
      });
      return true;
    }, { isolationLevel: 'Serializable' });
    if (quarantined) quarantinedDeveloper += 1;
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

  const readyBookings = betaTestDevBypassActive() ? [] : await db.booking.findMany({
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

  return { funded, queued, completed, degraded, quarantinedDeveloper };
}

// Base58 excludes 0/O/I/l (see settlement-transactions.ts SIGNATURE_PATTERN), but a
// booking cuid can contain '0' or 'l' - substitute them with other allowed characters so
// the id can double as a synthetic settlement signature. Only ever used by the dev-bypass
// path below, never presented as a real Solana transaction signature.
export function devBypassSettlementSignature(bookingId: string): string {
  const sanitized = bookingId.replace(/0/g, '8').replace(/l/g, 'k');
  return `devBypassRefundAuto${sanitized}`;
}

// Symmetric counterpart to the AWAITING_DEPOSIT -> FUNDED dev-bypass above: without a
// deployed escrow program, a DEGRADED/COMPLETED booking can never reach a real settlement
// either (requestSettlement/confirmSettlement are otherwise only driven by the internal
// settlement service with a real signed Solana transaction), so it stayed stuck forever -
// which in turn permanently tripped archiveLegacyFullMachineListing's listing_has_live_booking
// check for any listing carrying one. Only ever touches a booking whose time window has
// fully elapsed, and only while betaTestDevBypassActive() (becomes a no-op the instant real
// escrow is configured, exactly like the funding bypass it mirrors).
export async function reconcileDevBypassSettlements(db: PrismaClient, now = new Date()): Promise<{
  settled: number;
  failed: Array<{ bookingId: string; error: string }>;
}> {
  let settled = 0;
  const failed: Array<{ bookingId: string; error: string }> = [];
  if (!betaTestDevBypassActive()) return { settled, failed };

  // Not just ESCROW_FUNDED: reconcileStalledActivations already moves a degrading
  // booking's payment to SETTLEMENT_PENDING before this ever sees it (see above), so
  // matching only ESCROW_FUNDED would silently skip the exact bookings this exists for.
  // Exclude only what requestSettlement itself would reject anyway (already terminal, or
  // FROZEN pending a security review) - mirrors its own guard, not a separate judgment call.
  const openPayment = {
    status: {
      notIn: [
        PaymentStatus.RELEASED,
        PaymentStatus.FULLY_REFUNDED,
        PaymentStatus.FROZEN,
      ],
    },
  };

  const candidates = await db.booking.findMany({
    where: {
      payment: openPayment,
      OR: [
        // COMPLETED already means the diagnostic proved the workload finished
        // successfully (see reconcileDevelopmentBookings' finishedJobs handling above) -
        // that can land well before the booking's nominal endsAt, and nothing further is
        // "live" about it from that point on, so there is no reason to also wait out the
        // wall-clock window before settling.
        { status: BookingStatus.COMPLETED },
        // DEGRADED can mean something is still resolvable within its own window (e.g. a
        // stalled activation degraded 20 minutes in on an hour-long booking) - keep the
        // extra safety margin of only ever touching one whose window has fully elapsed.
        { status: BookingStatus.DEGRADED, endsAt: { lt: now } },
      ],
    },
    select: { id: true },
    take: 25,
    orderBy: { endsAt: 'asc' },
  });

  for (const booking of candidates) {
    try {
      await requestSettlement(db, booking.id);
      await confirmSettlement(db, booking.id, devBypassSettlementSignature(booking.id));
      settled += 1;
    } catch (error) {
      // Could be losing a race with another tick, or the booking's state moving on since
      // the query above (e.g. a real settlement request landing first) - not necessarily a
      // bug. But swallowing this with zero visibility made a real, persistent failure here
      // indistinguishable from that from outside the process, so surface it instead of
      // just continuing silently.
      failed.push({ bookingId: booking.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { settled, failed };
}

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
      jobs: { none: { status: { in: ACTIVE_ACTIVATION_JOB_STATUSES }, updatedAt: { gte: new Date(now.getTime() - STALLED_ACTIVATION_GRACE_MS) } } },
    },
    select: { id: true, listing: { select: { machineId: true } } },
    take: 50,
  });
  for (const booking of stalled) {
    const changed = await db.$transaction(async (tx) => {
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
        const releasedAt = now;
        const allocationData = { status: ResourceAllocationStatus.RELEASED, releasedAt };
        await tx.machineAllocation.updateMany({
          where: { bookingId: booking.id, status: { in: LIVE_ALLOCATION_STATUSES } },
          data: allocationData,
        });
        await tx.acceleratorAllocation.updateMany({
          where: { bookingId: booking.id, status: { in: LIVE_ALLOCATION_STATUSES } },
          data: allocationData,
        });
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
  return { degraded };
}

// POST /bookings creates the Booking row and calls allocateBookingResources() as two
// separate transactions (see server.ts) - deliberately, so a client retry with the same
// idempotencyKey can find and re-allocate an existing unallocated booking (Booking is
// looked up by (buyerId, idempotencyKey) before allocation runs either way). That retry
// is the normal recovery path. This reconciler only exists for the case nothing retries:
// the API process crashes/restarts between the two transactions and the original client
// never comes back (closed tab, abandoned request) with zero allocation ever created.
// booking_no_overlap (migration 0001_initial) EXCLUDEs on (listingId, [startsAt,endsAt))
// for AWAITING_DEPOSIT and later statuses, so an orphan like this blocks its listing's
// exact time slot forever until something cancels it.
//
// The grace period is not an arbitrary guess: allocateBookingResources()'s own
// transaction budget (maxWait 5s + timeout 10s, see resource-allocation-service.ts) is
// the maximum time a *legitimate* in-flight allocation attempt can take, even under
// contention. This grace period is a large, safe multiple of that bound, not a tuned
// product-facing deposit deadline - it only has to be long enough that it can never be
// confused with a request still genuinely in flight.
const ORPHANED_DEPOSIT_ALLOCATION_GRACE_MS = 2 * 60_000;

export async function reconcileOrphanedDepositBookings(db: PrismaClient, now = new Date()): Promise<{ cancelled: number }> {
  let cancelled = 0;
  const cutoff = new Date(now.getTime() - ORPHANED_DEPOSIT_ALLOCATION_GRACE_MS);
  const orphaned = await db.booking.findMany({
    where: {
      status: BookingStatus.AWAITING_DEPOSIT,
      createdAt: { lt: cutoff },
      machineAllocation: { is: null },
      acceleratorAllocations: { none: {} },
    },
    select: { id: true, listingId: true, createdAt: true },
    take: 50,
    orderBy: { createdAt: 'asc' },
  });

  for (const booking of orphaned) {
    // Re-check both the status and the absence of any allocation inside the same
    // conditional update: a concurrent request could have allocated (or a concurrent
    // reconciler tick already cancelled) this exact booking between the read above and
    // this write. count !== 1 means we lost that race, not an error - idempotent no-op.
    const updated = await db.booking.updateMany({
      where: {
        id: booking.id,
        status: BookingStatus.AWAITING_DEPOSIT,
        machineAllocation: { is: null },
        acceleratorAllocations: { none: {} },
      },
      data: { status: BookingStatus.CANCELLED },
    });
    if (updated.count === 1) cancelled += 1;
  }

  return { cancelled };
}
