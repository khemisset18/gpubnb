import { BookingStatus, JobStatus, JobType, MachineOperational, ModerationStatus, PaymentStatus, PrismaClient, ResourceAllocationStatus, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';
import { config } from './config.js';
import { confirmSettlement, requestSettlement } from './settlement-transactions.js';
import { enterQuarantine } from './quarantine-service.js';
import { runBookingTransaction } from './booking-transaction-retry.js';

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
    // DB-only callback, safe to retry as a whole - already Serializable, only the missing
    // retry around it is new (see reconcileStalledActivations below for the same pattern).
    const quarantined = await runBookingTransaction(db, async (tx) => {
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
      const quarantinable = await tx.machine.updateMany({
        where: { id: workspace.machineId, moderationStatus: ModerationStatus.CLEAR },
        data: { operational: MachineOperational.UNAVAILABLE },
      });
      if (quarantinable.count === 1) {
        await enterQuarantine(tx, {
          machineId: workspace.machineId,
          reasonCode: 'DIAGNOSTIC_COMPLETION_RACE',
          reason: 'Session Developer restée active alors que la réservation associée est déjà terminée et que la ressource GPU a été réallouée.',
          details: { bookingId: workspace.bookingId, sessionId: workspace.id },
          source: 'dev-booking-reconciler.racedDeveloperSessions',
          now,
        });
      }
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
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 });
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
      // DB-only callback, safe to retry as a whole - this booking row is also written by
      // agent-triggered, Serializable-retried transactions (completeGpuProofJob and friends),
      // so an unretried transient conflict here used to just silently skip a tick instead of
      // recovering.
      const changed = await runBookingTransaction(db, async (tx) => {
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
      }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 });
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
    // DB-only callback, safe to retry as a whole - see the comment on the dev-bypass funding
    // loop above for why this booking row needs the same protection.
    const created = await runBookingTransaction(db, async (tx) => {
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
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 });
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
    // DB-only callback, safe to retry as a whole. Real bug found live (2026-09-02): this ran
    // unretried, on the same booking row completeGpuProofJob (gpu-proof-completion.ts, already
    // Serializable + retried) writes to via the agent's own /finalize-proof call, and on the
    // same row reconcileExpiredActiveDeveloperBookings below also writes to on its own 10s
    // tick - real contention between this unretried tick and those retried ones, right around
    // a booking's natural expiry, could exhaust the agent-facing side's bounded retry budget
    // and surface as an uncaught 500 to the agent, with the GPU verification itself already
    // having genuinely succeeded.
    const changed = await runBookingTransaction(db, async (tx) => {
      // Real bug found live during the private-beta two-machine test:
      // GPU_PROOF succeeding used to move the booking straight to
      // COMPLETED - correct back when proving the GPU *was* the entire
      // rental, wrong now that a still-genuinely-open booking can go on to
      // request a Developer Workspace afterward. GPU_PROOF completed !=
      // rental completed. A successful proof now only unlocks STARTING (the
      // exact state this reconciler itself puts a booking into a few lines
      // above, when it creates this exact job) to ACTIVE - still
      // workspace-eligible (see workspace-developer-flow.js's
      // ELIGIBLE_BOOKING_STATUSES), with no time pressure at all: nothing
      // races to move it away from ACTIVE anymore. An already-ACTIVE
      // booking (reached via some other real path, e.g. a non-Developer
      // workspace's own metrics-driven activation) is left untouched -
      // there is nothing left to unlock - which also makes this update a
      // safe no-op (count 0) on every later tick once a booking is already
      // unlocked, so the same finished job is never "processed" twice.
      // Genuine rental completion now happens only once the booking's own
      // real time window elapses - see
      // reconcileExpiredActiveDeveloperBookings below - never merely
      // because the proof job finished.
      const bookingUpdate = success
        ? await tx.booking.updateMany({
          where: {
            id: job.bookingId,
            status: BookingStatus.STARTING,
            workspaceSessions: { none: DEVELOPER_SESSION_FILTER },
          },
          data: { status: BookingStatus.ACTIVE },
        })
        : await tx.booking.updateMany({
          where: {
            id: job.bookingId,
            status: { in: [BookingStatus.STARTING, BookingStatus.ACTIVE] },
            workspaceSessions: { none: DEVELOPER_SESSION_FILTER },
          },
          data: { status: BookingStatus.DEGRADED },
        });
      if (bookingUpdate.count !== 1) return false;
      await tx.machine.update({
        where: { id: job.machineId },
        data: { operational: success ? MachineOperational.AVAILABLE : MachineOperational.DEGRADED },
      });
      return true;
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 });
    if (changed) {
      if (success) completed += 1;
      else degraded += 1;
    }
  }

  return { funded, queued, completed, degraded, quarantinedDeveloper };
}

// Symmetric counterpart to the fix above: an ACTIVE booking unlocked by a
// successful GPU_PROOF still has to become COMPLETED *eventually*, once the
// rental's own real time window elapses, or it (and the GPU it holds
// exclusively) would never be freed for a new booking. Feeds directly into
// the settlement path that already exists (COMPLETED is already
// SETTLEABLE, see settlement-transactions.ts) - no new settlement
// mechanism, just the missing trigger into the one already there. Never
// touches a booking with a live Developer session - the exact same
// exclusivity guard used throughout this file, re-checked inside the same
// transaction as the write, so a session created in the gap between the
// read above and this transaction correctly makes the write a no-op rather
// than racing it. Like every other dev-bypass mechanism here, this is a
// no-op the instant real escrow is configured.
export async function findExpiredActiveDeveloperBookings(db: PrismaClient, now: Date) {
  return db.booking.findMany({
    where: {
      status: BookingStatus.ACTIVE,
      endsAt: { lt: now },
      // Bare DEVELOPER_SESSION_FILTER (no status) would match a booking whose Developer
      // session already ended (a normal Stop, or an unactivated timeout) forever, the same
      // way a booking that never had one at all matches - silently blocking this sweep from
      // ever settling a booking that finished its rental normally. Scoped to only a LIVE
      // session, matching every other exclusivity guard in this file (see
      // reconcileDevelopmentBookings above).
      workspaceSessions: { none: { ...DEVELOPER_SESSION_FILTER, status: { in: ACTIVE_DEVELOPER_SESSION_STATUSES } } },
      // Real gap found live (2026-09-02): this booking's own endsAt is unrelated to how long
      // its GPU_PROOF verification actually takes - a booking reaches ACTIVE via the
      // GPU_DIAGNOSTIC bypass (above) while a separate, slower GPU_PROOF job (the one that
      // unlocks the Developer button) can still genuinely be running for the exact same
      // booking. Without this exclusion, this sweep would silently mark the booking COMPLETED
      // out from under that still-running job - no crash, no error, just a booking the renter
      // can never open a Developer workspace on again, even though GPU_PROOF goes on to
      // succeed moments later. Reuses the same active-job-status list every other exclusivity
      // guard in this file already uses (see ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES above),
      // not a new mechanism.
      jobs: { none: { type: JobType.GPU_PROOF, status: { in: ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES } } },
    },
    select: { id: true, listing: { select: { machineId: true } } },
    take: 25,
    orderBy: { endsAt: 'asc' },
  });
}

export async function reconcileExpiredActiveDeveloperBookings(
  db: PrismaClient,
  now = new Date(),
): Promise<{ completed: number }> {
  let completedCount = 0;
  if (!betaTestDevBypassActive()) return { completed: completedCount };

  const expired = await findExpiredActiveDeveloperBookings(db, now);
  for (const booking of expired) {
    // DB-only callback, safe to retry as a whole. Real bug found live (2026-09-02): this ran
    // unretried, right at the exact moment a booking's own time window elapses - precisely
    // when the agent's own /finalize-proof -> completeGpuProofJob call (already Serializable +
    // retried) can also be landing on the same booking row for a job that only just finished.
    // An unretried conflict here could win the row lock in a way that exhausted the
    // agent-facing side's bounded retry budget, surfacing as an uncaught 500 to the agent even
    // though the GPU verification itself had already genuinely succeeded.
    const changed = await runBookingTransaction(db, async (tx) => {
      const update = await tx.booking.updateMany({
        where: {
          id: booking.id,
          status: BookingStatus.ACTIVE,
          workspaceSessions: { none: { ...DEVELOPER_SESSION_FILTER, status: { in: ACTIVE_DEVELOPER_SESSION_STATUSES } } },
          // Re-checked inside the transaction, not just the outer read above: a GPU_PROOF job
          // could be created (ensureComputePreparation) or start progressing in the gap
          // between that read and this write.
          jobs: { none: { type: JobType.GPU_PROOF, status: { in: ACTIVE_WORKSPACE_PREPARE_JOB_STATUSES } } },
        },
        data: { status: BookingStatus.COMPLETED },
      });
      if (update.count !== 1) return false;
      await tx.machine.updateMany({
        where: { id: booking.listing.machineId, operational: MachineOperational.RESERVED },
        data: { operational: MachineOperational.AVAILABLE },
      });
      return true;
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 });
    if (changed) completedCount += 1;
  }
  return { completed: completedCount };
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
// Not just ESCROW_FUNDED: reconcileStalledActivations already moves a degrading booking's
// payment to SETTLEMENT_PENDING before this ever sees it, so matching only ESCROW_FUNDED
// would silently skip the exact bookings this exists for. Exclude only what
// requestSettlement itself would reject anyway (already terminal, or FROZEN pending a
// security review) - mirrors its own guard, not a separate judgment call.
const openPayment = {
  status: {
    notIn: [
      PaymentStatus.RELEASED,
      PaymentStatus.FULLY_REFUNDED,
      PaymentStatus.FROZEN,
    ],
  },
};

// Read-only: separated out from reconcileDevBypassSettlements so a diagnostic route can
// show exactly what the reconciler would act on right now, without needing to trigger a
// write or wait for the next interval tick.
export async function findDevBypassSettlementCandidates(db: PrismaClient, now = new Date()) {
  return db.booking.findMany({
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
    select: { id: true, status: true, endsAt: true },
    take: 25,
    orderBy: { endsAt: 'asc' },
  });
}

export async function reconcileDevBypassSettlements(db: PrismaClient, now = new Date()): Promise<{
  settled: number;
  failed: Array<{ bookingId: string; error: string }>;
}> {
  let settled = 0;
  const failed: Array<{ bookingId: string; error: string }> = [];
  if (!betaTestDevBypassActive()) return { settled, failed };

  const candidates = await findDevBypassSettlementCandidates(db, now);

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

// Exported: also used by /agent/jobs/:id/finalize-proof (server.ts) to size the
// safety window a booking gets to request its Developer workspace after GPU_PROOF
// completes, so both sides of that handoff agree on a single grace period.
export const STALLED_ACTIVATION_GRACE_MS = 20 * 60_000;
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
    // DB-only callback (job/booking/session/allocation reads and writes, enterQuarantine -
    // no network calls), safe to retry as a whole. Already Serializable (unchanged below);
    // only the missing retry around it is new.
    const changed = await runBookingTransaction(db, async (tx) => {
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
        const quarantinable = await tx.machine.updateMany({
          where: { id: booking.listing.machineId, moderationStatus: ModerationStatus.CLEAR },
          data: { operational: MachineOperational.UNAVAILABLE },
        });
        if (quarantinable.count === 1) {
          await enterQuarantine(tx, {
            machineId: booking.listing.machineId,
            reasonCode: 'STALE_JOB',
            reason: "Une tâche d'activation est restée assignée à l'agent au-delà du délai attendu, sans confirmation de nettoyage.",
            details: { bookingId: booking.id },
            source: 'dev-booking-reconciler.reconcileStalledActivations',
            now,
          });
        }
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
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 });
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
