import {
  BookingStatus,
  JobStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  ModerationStatus,
  PaymentStatus,
  Prisma,
  ResourceAllocationStatus,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';

import { isExactGpuPubliclyHealthy } from './rental-public-listings.js';

export type OwnerListingAction = 'pause' | 'resume' | 'archive';
export type OwnerListingLifecycleErrorCode =
  | 'listing_not_found'
  | 'invalid_listing_mode'
  | 'invalid_listing_transition'
  | 'listing_has_live_booking'
  | 'listing_has_live_allocation'
  | 'listing_has_live_job'
  | 'listing_has_live_session'
  | 'listing_has_live_payment'
  | 'machine_not_ready'
  | 'accelerator_not_ready'
  | 'listing_conflict';

export class OwnerListingLifecycleError extends Error {
  constructor(
    public readonly code: OwnerListingLifecycleErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'OwnerListingLifecycleError';
  }
}

const committedBookingStatuses = [
  BookingStatus.CREATED,
  BookingStatus.AWAITING_DEPOSIT,
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
  BookingStatus.DEGRADED,
  BookingStatus.DISPUTED,
] as const;

const pausableStatuses = new Set<ListingStatus>([
  ListingStatus.ACTIVE,
  ListingStatus.RESERVED,
  ListingStatus.HIDDEN_OFFLINE,
]);

const archivableStatuses = new Set<ListingStatus>([
  ListingStatus.DRAFT,
  ListingStatus.PENDING_GPU_VERIFICATION,
  ListingStatus.ACTIVE,
  ListingStatus.RESERVED,
  ListingStatus.HIDDEN_OFFLINE,
  ListingStatus.PAUSED,
]);

const lifecycleSelect = {
  id: true,
  machineId: true,
  status: true,
  resourceMode: true,
  machine: {
    select: {
      connectivity: true,
      moderationStatus: true,
      lastHeartbeatAt: true,
    },
  },
  accelerators: {
    take: 2,
    select: {
      accelerator: {
        select: {
          status: true,
          moderationStatus: true,
          isolationVerified: true,
          verifiedAt: true,
          lastSeenAt: true,
          miningResource: {
            select: {
              enabled: true,
              quarantined: true,
              runtimeState: true,
              lastSeenAt: true,
            },
          },
        },
      },
    },
  },
  bookings: {
    where: { status: { in: [...committedBookingStatuses] } },
    select: { id: true, status: true, startsAt: true, endsAt: true },
    take: 50,
  },
} satisfies Prisma.GpuListingSelect;

type LifecycleListing = Prisma.GpuListingGetPayload<{ select: typeof lifecycleSelect }>;

function fresh(value: Date | null, now: Date, staleAfterSeconds: number): boolean {
  return Boolean(value && value.getTime() >= now.getTime() - staleAfterSeconds * 1000);
}

function machineReady(listing: LifecycleListing, now: Date, staleAfterSeconds: number): boolean {
  return listing.machine.connectivity === MachineConnectivity.ONLINE &&
    listing.machine.moderationStatus === ModerationStatus.CLEAR &&
    fresh(listing.machine.lastHeartbeatAt, now, staleAfterSeconds);
}

function exactGpuReady(listing: LifecycleListing, now: Date, staleAfterSeconds: number): boolean {
  if (listing.accelerators.length !== 1) return false;
  const selected = listing.accelerators.at(0);
  return Boolean(selected && isExactGpuPubliclyHealthy(selected.accelerator, now, staleAfterSeconds));
}

function hasLiveCommitment(listing: LifecycleListing): boolean {
  return listing.bookings.length > 0;
}

function targetFor(action: OwnerListingAction): ListingStatus {
  if (action === 'pause') return ListingStatus.PAUSED;
  if (action === 'resume') return ListingStatus.ACTIVE;
  return ListingStatus.ARCHIVED;
}

function assertTransition(
  listing: LifecycleListing,
  action: OwnerListingAction,
  now: Date,
  staleAfterSeconds: number,
): void {
  if (listing.resourceMode !== ListingResourceMode.SELECTED_ACCELERATORS) {
    throw new OwnerListingLifecycleError('invalid_listing_mode');
  }

  if (action === 'pause') {
    if (!pausableStatuses.has(listing.status)) {
      throw new OwnerListingLifecycleError('invalid_listing_transition', { from: listing.status, action });
    }
    return;
  }

  if (action === 'resume') {
    if (listing.status !== ListingStatus.PAUSED) {
      throw new OwnerListingLifecycleError('invalid_listing_transition', { from: listing.status, action });
    }
    if (!machineReady(listing, now, staleAfterSeconds)) {
      throw new OwnerListingLifecycleError('machine_not_ready');
    }
    if (!exactGpuReady(listing, now, staleAfterSeconds)) {
      throw new OwnerListingLifecycleError('accelerator_not_ready');
    }
    return;
  }

  if (!archivableStatuses.has(listing.status)) {
    throw new OwnerListingLifecycleError('invalid_listing_transition', { from: listing.status, action });
  }
  if (hasLiveCommitment(listing)) {
    throw new OwnerListingLifecycleError('listing_has_live_booking', {
      bookingIds: listing.bookings.map((booking) => booking.id),
    });
  }
}

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034');
}

// Legacy FULL_MACHINE listings predate the SELECTED_ACCELERATORS marketplace and were
// created by the now-disabled POST /listings route. They carry no ListingAccelerator
// rows and are invisible to the current owner/public listing surfaces, but a live
// FULL_MACHINE listing still blocks per-GPU publication of the same physical machine
// (computeRentalGpuReadiness -> FULL_MACHINE_LISTING_ACTIVE). This is the one-time,
// narrowly-scoped retirement path for that legacy resourceMode: it never applies to
// SELECTED_ACCELERATORS listings (transitionOwnerExactGpuListing above is unchanged),
// and it only ever flips status -> ARCHIVED (never a DELETE), so listing history for
// audit/dispute purposes is preserved.
const committedBookingStatusSet = new Set<BookingStatus>(committedBookingStatuses);

const legacyArchivableStatuses = new Set<ListingStatus>([
  ListingStatus.PENDING_GPU_VERIFICATION,
  ListingStatus.ACTIVE,
  ListingStatus.RESERVED,
  ListingStatus.HIDDEN_OFFLINE,
  ListingStatus.PAUSED,
]);

const liveAllocationStatuses = new Set<ResourceAllocationStatus>([
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
]);

const liveJobStatuses = new Set<JobStatus>([
  JobStatus.QUEUED,
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
]);

const liveWorkspaceSessionStatuses = new Set<WorkspaceSessionStatus>([
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
]);

// PARTIALLY_REFUNDED is deliberately absent: confirmSettlement (settlement-transactions.ts)
// sets it, alongside BookingStatus.SETTLED and a recorded settlementSignature, as one of
// three mutually exclusive terminal outcomes (full release / full refund / mixed release+
// refund) for a booking whose window ended partway through - nothing in the codebase ever
// transitions a payment onward from there. Treating it as still "open" here made any legacy
// FULL_MACHINE listing whose last booking settled with a partial refund permanently
// unarchivable (confirmed against production: cmskhoviy0047dx0uuv7am07o blocked by booking
// cmsp5vcwo... at PARTIALLY_REFUNDED, endsAt 9 days in the past).
const openPaymentStatuses = new Set<PaymentStatus>([
  PaymentStatus.ESCROW_PENDING,
  PaymentStatus.ESCROW_FUNDED,
  PaymentStatus.SETTLEMENT_PENDING,
]);

const legacyArchiveSelect = {
  id: true,
  status: true,
  resourceMode: true,
  bookings: {
    select: {
      id: true,
      status: true,
      machineAllocation: { select: { id: true, status: true, releasedAt: true } },
      acceleratorAllocations: { select: { id: true, status: true, releasedAt: true } },
      jobs: { select: { id: true, status: true } },
      workspaceSessions: { select: { id: true, status: true } },
      payment: { select: { id: true, status: true } },
    },
    take: 200,
  },
} satisfies Prisma.GpuListingSelect;

type LegacyArchiveListing = Prisma.GpuListingGetPayload<{ select: typeof legacyArchiveSelect }>;

// Scoped to *this listing's own bookings* only (via the booking -> listing FK), never
// to the machine as a whole: a machine can carry more than one listing, and this must
// never treat another listing's live activity as a reason to block (or allow) this one.
function assertNoLiveDependency(listing: LegacyArchiveListing): void {
  for (const booking of listing.bookings) {
    if (committedBookingStatusSet.has(booking.status)) {
      throw new OwnerListingLifecycleError('listing_has_live_booking', { bookingId: booking.id, status: booking.status });
    }
    if (booking.machineAllocation && !booking.machineAllocation.releasedAt &&
      liveAllocationStatuses.has(booking.machineAllocation.status)) {
      throw new OwnerListingLifecycleError('listing_has_live_allocation', {
        bookingId: booking.id, allocationId: booking.machineAllocation.id, kind: 'machine',
      });
    }
    for (const allocation of booking.acceleratorAllocations) {
      if (!allocation.releasedAt && liveAllocationStatuses.has(allocation.status)) {
        throw new OwnerListingLifecycleError('listing_has_live_allocation', {
          bookingId: booking.id, allocationId: allocation.id, kind: 'accelerator',
        });
      }
    }
    for (const job of booking.jobs) {
      if (liveJobStatuses.has(job.status)) {
        throw new OwnerListingLifecycleError('listing_has_live_job', { bookingId: booking.id, jobId: job.id });
      }
    }
    for (const session of booking.workspaceSessions) {
      if (liveWorkspaceSessionStatuses.has(session.status)) {
        throw new OwnerListingLifecycleError('listing_has_live_session', { bookingId: booking.id, sessionId: session.id });
      }
    }
    if (booking.payment && openPaymentStatuses.has(booking.payment.status)) {
      throw new OwnerListingLifecycleError('listing_has_live_payment', { bookingId: booking.id, paymentId: booking.payment.id });
    }
  }
}

export type LegacyListingArchiveResult = {
  id: string;
  previousStatus: ListingStatus;
  status: ListingStatus;
  alreadyArchived: boolean;
};

// Retires a single legacy FULL_MACHINE listing so the physical machine it points at
// stops tripping FULL_MACHINE_LISTING_ACTIVE for the SELECTED_ACCELERATORS flow. Never
// deletes the row (history stays queryable for audit), never touches a
// SELECTED_ACCELERATORS listing, and is idempotent: calling it again on an
// already-ARCHIVED listing returns success without writing.
export async function archiveLegacyFullMachineListing(
  db: PrismaClient,
  ownerId: string,
  listingId: string,
): Promise<LegacyListingArchiveResult> {
  try {
    return await db.$transaction(async (tx) => {
      const identity = await tx.gpuListing.findFirst({
        where: { id: listingId, ownerId },
        select: { id: true, machineId: true },
      });
      if (!identity) throw new OwnerListingLifecycleError('listing_not_found');

      // Same per-machine advisory lock as transitionOwnerExactGpuListing: serializes
      // against a concurrent exact-GPU publish/readiness check for this machine so the
      // two code paths can never race on the same physical resource.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.machineId}, 0))`;

      const listing = await tx.gpuListing.findFirst({
        where: { id: listingId, ownerId },
        select: legacyArchiveSelect,
      });
      if (!listing) throw new OwnerListingLifecycleError('listing_not_found');

      if (listing.resourceMode !== ListingResourceMode.FULL_MACHINE) {
        throw new OwnerListingLifecycleError('invalid_listing_mode');
      }

      if (listing.status === ListingStatus.ARCHIVED) {
        return { id: listing.id, previousStatus: listing.status, status: ListingStatus.ARCHIVED, alreadyArchived: true };
      }
      if (!legacyArchivableStatuses.has(listing.status)) {
        throw new OwnerListingLifecycleError('invalid_listing_transition', { from: listing.status, action: 'archive-legacy' });
      }

      assertNoLiveDependency(listing);

      const updated = await tx.gpuListing.updateMany({
        where: { id: listing.id, ownerId, status: listing.status, resourceMode: ListingResourceMode.FULL_MACHINE },
        data: { status: ListingStatus.ARCHIVED },
      });
      if (updated.count !== 1) throw new OwnerListingLifecycleError('listing_conflict');

      return { id: listing.id, previousStatus: listing.status, status: ListingStatus.ARCHIVED, alreadyArchived: false };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error) {
    if (error instanceof OwnerListingLifecycleError) throw error;
    if (isTransactionConflict(error)) throw new OwnerListingLifecycleError('listing_conflict');
    throw error;
  }
}

export async function transitionOwnerExactGpuListing(
  db: PrismaClient,
  ownerId: string,
  listingId: string,
  action: OwnerListingAction,
  now: Date,
  staleAfterSeconds: number,
) {
  try {
    return await db.$transaction(async (tx) => {
      const identity = await tx.gpuListing.findFirst({
        where: { id: listingId, ownerId },
        select: { id: true, machineId: true },
      });
      if (!identity) throw new OwnerListingLifecycleError('listing_not_found');

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.machineId}, 0))`;

      const listing = await tx.gpuListing.findFirst({
        where: { id: listingId, ownerId },
        select: lifecycleSelect,
      });
      if (!listing) throw new OwnerListingLifecycleError('listing_not_found');

      assertTransition(listing, action, now, staleAfterSeconds);
      const target = targetFor(action);
      const updated = await tx.gpuListing.updateMany({
        where: { id: listing.id, ownerId, status: listing.status },
        data: { status: target },
      });
      if (updated.count !== 1) throw new OwnerListingLifecycleError('listing_conflict');

      return {
        id: listing.id,
        previousStatus: listing.status,
        status: target,
        action,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error) {
    if (error instanceof OwnerListingLifecycleError) throw error;
    if (isTransactionConflict(error)) throw new OwnerListingLifecycleError('listing_conflict');
    throw error;
  }
}
