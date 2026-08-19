import {
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  ModerationStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { isExactGpuPubliclyHealthy } from './rental-public-listings.js';

export type OwnerListingAction = 'pause' | 'resume' | 'archive';
export type OwnerListingLifecycleErrorCode =
  | 'listing_not_found'
  | 'invalid_listing_mode'
  | 'invalid_listing_transition'
  | 'listing_has_live_booking'
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
