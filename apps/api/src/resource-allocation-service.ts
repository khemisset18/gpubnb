import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  ListingStatus,
  ModerationStatus,
  Prisma,
  PrismaClient,
  ResourceAllocationStatus,
} from '@prisma/client';

const RENTABLE_ACCELERATOR_STATUSES: AcceleratorOperationalStatus[] = [
  AcceleratorOperationalStatus.AVAILABLE,
  AcceleratorOperationalStatus.RESERVED,
  AcceleratorOperationalStatus.RUNNING,
];

const LIVE_ALLOCATION_STATUSES: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

export class ResourceAllocationError extends Error {
  constructor(
    public readonly code:
      | 'booking_not_found'
      | 'listing_not_available'
      | 'invalid_booking_period'
      | 'allocation_already_exists'
      | 'allocation_missing'
      | 'invalid_allocation_transition'
      | 'accelerator_selection_not_allowed'
      | 'accelerator_count_out_of_range'
      | 'accelerator_not_rentable'
      | 'resource_conflict',
  ) {
    super(code);
    this.name = 'ResourceAllocationError';
  }
}

export type AllocateBookingResourcesInput = {
  bookingId: string;
  buyerId: string;
  acceleratorIds?: string[];
};

export type BookingResourceAllocation = {
  bookingId: string;
  machineId: string;
  mode: ListingResourceMode;
  acceleratorIds: string[];
};

function normalizedIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])].sort();
}

function isResourceConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === 'P2002' || error.code === 'P2010' || error.code === 'P2034';
}

function canTransitionAllocation(
  current: ResourceAllocationStatus,
  target: ResourceAllocationStatus,
): boolean {
  if (current === target) return true;
  if (current === ResourceAllocationStatus.HELD) {
    return target === ResourceAllocationStatus.CONFIRMED ||
      target === ResourceAllocationStatus.RELEASED ||
      target === ResourceAllocationStatus.CANCELLED;
  }
  if (current === ResourceAllocationStatus.CONFIRMED) {
    return target === ResourceAllocationStatus.ACTIVE ||
      target === ResourceAllocationStatus.RELEASED ||
      target === ResourceAllocationStatus.CANCELLED;
  }
  return current === ResourceAllocationStatus.ACTIVE &&
    target === ResourceAllocationStatus.RELEASED;
}

async function allocateInTransaction(
  tx: Prisma.TransactionClient,
  input: AllocateBookingResourcesInput,
): Promise<BookingResourceAllocation> {
  const booking = await tx.booking.findFirst({
    where: { id: input.bookingId, buyerId: input.buyerId },
    include: {
      machineAllocation: { select: { id: true } },
      acceleratorAllocations: { select: { id: true } },
      listing: {
        include: {
          machine: {
            select: {
              id: true,
              moderationStatus: true,
              accelerators: {
                select: {
                  id: true,
                  status: true,
                  moderationStatus: true,
                  isolationVerified: true,
                },
              },
            },
          },
          accelerators: { select: { acceleratorId: true } },
        },
      },
    },
  });

  if (!booking) throw new ResourceAllocationError('booking_not_found');
  if (booking.endsAt <= booking.startsAt) throw new ResourceAllocationError('invalid_booking_period');
  if (booking.machineAllocation || booking.acceleratorAllocations.length > 0) {
    throw new ResourceAllocationError('allocation_already_exists');
  }
  if (
    booking.listing.status !== ListingStatus.ACTIVE ||
    booking.listing.machine.moderationStatus !== ModerationStatus.CLEAR
  ) {
    throw new ResourceAllocationError('listing_not_available');
  }

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${booking.listing.machineId}, 0))`;

  const requestedIds = normalizedIds(input.acceleratorIds);
  const machineAccelerators = new Map(
    booking.listing.machine.accelerators.map((accelerator) => [accelerator.id, accelerator]),
  );
  const listedIds = new Set(booking.listing.accelerators.map((row) => row.acceleratorId));

  if (booking.listing.resourceMode === ListingResourceMode.FULL_MACHINE) {
    if (requestedIds.length > 0) throw new ResourceAllocationError('accelerator_selection_not_allowed');
    await tx.machineAllocation.create({
      data: {
        bookingId: booking.id,
        machineId: booking.listing.machineId,
        status: ResourceAllocationStatus.HELD,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      },
    });
    return {
      bookingId: booking.id,
      machineId: booking.listing.machineId,
      mode: booking.listing.resourceMode,
      acceleratorIds: [],
    };
  }

  let selectedIds: string[];
  if (booking.listing.resourceMode === ListingResourceMode.SELECTED_ACCELERATORS) {
    if (requestedIds.length > 0 && requestedIds.some((id) => !listedIds.has(id))) {
      throw new ResourceAllocationError('accelerator_selection_not_allowed');
    }
    selectedIds = requestedIds.length > 0 ? requestedIds : [...listedIds].sort();
  } else {
    const minimum = booking.listing.minimumAccelerators ?? 1;
    const maximum = booking.listing.maximumAccelerators ?? minimum;
    if (requestedIds.length < minimum || requestedIds.length > maximum) {
      throw new ResourceAllocationError('accelerator_count_out_of_range');
    }
    selectedIds = requestedIds;
  }

  if (selectedIds.length === 0) throw new ResourceAllocationError('accelerator_count_out_of_range');

  for (const acceleratorId of selectedIds) {
    const accelerator = machineAccelerators.get(acceleratorId);
    if (
      !accelerator ||
      !RENTABLE_ACCELERATOR_STATUSES.includes(accelerator.status) ||
      accelerator.moderationStatus !== ModerationStatus.CLEAR ||
      !accelerator.isolationVerified
    ) {
      throw new ResourceAllocationError('accelerator_not_rentable');
    }
  }

  await tx.acceleratorAllocation.createMany({
    data: selectedIds.map((acceleratorId) => ({
      bookingId: booking.id,
      acceleratorId,
      status: ResourceAllocationStatus.HELD,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
    })),
  });

  return {
    bookingId: booking.id,
    machineId: booking.listing.machineId,
    mode: booking.listing.resourceMode,
    acceleratorIds: selectedIds,
  };
}

export async function allocateBookingResources(
  db: PrismaClient,
  input: AllocateBookingResourcesInput,
): Promise<BookingResourceAllocation> {
  try {
    return await db.$transaction((tx) => allocateInTransaction(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error) {
    if (error instanceof ResourceAllocationError) throw error;
    if (isResourceConflict(error)) throw new ResourceAllocationError('resource_conflict');
    throw error;
  }
}

export async function transitionBookingResources(
  db: PrismaClient,
  bookingId: string,
  target: ResourceAllocationStatus,
  at = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        listing: { select: { machineId: true } },
        machineAllocation: { select: { id: true, status: true } },
        acceleratorAllocations: { select: { id: true, status: true } },
      },
    });
    if (!booking) throw new ResourceAllocationError('booking_not_found');

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${booking.listing.machineId}, 0))`;

    const allocations = [
      ...(booking.machineAllocation ? [booking.machineAllocation] : []),
      ...booking.acceleratorAllocations,
    ];
    if (allocations.length === 0) throw new ResourceAllocationError('allocation_missing');
    if (allocations.some((allocation) => !canTransitionAllocation(allocation.status, target))) {
      throw new ResourceAllocationError('invalid_allocation_transition');
    }

    const terminal = target === ResourceAllocationStatus.RELEASED ||
      target === ResourceAllocationStatus.CANCELLED;
    const data: Prisma.MachineAllocationUpdateManyMutationInput = terminal
      ? { status: target, releasedAt: at }
      : { status: target, releasedAt: null };

    await tx.machineAllocation.updateMany({ where: { bookingId }, data });
    await tx.acceleratorAllocation.updateMany({ where: { bookingId }, data });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}

export async function confirmBookingResources(db: PrismaClient, bookingId: string): Promise<void> {
  await transitionBookingResources(db, bookingId, ResourceAllocationStatus.CONFIRMED);
}

export async function activateBookingResources(db: PrismaClient, bookingId: string): Promise<void> {
  await transitionBookingResources(db, bookingId, ResourceAllocationStatus.ACTIVE);
}

export async function cancelBookingResources(
  db: PrismaClient,
  bookingId: string,
  cancelledAt = new Date(),
): Promise<void> {
  await transitionBookingResources(db, bookingId, ResourceAllocationStatus.CANCELLED, cancelledAt);
}

export async function releaseBookingResources(
  db: PrismaClient,
  bookingId: string,
  releasedAt = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { listing: { select: { machineId: true } } },
    });
    if (!booking) throw new ResourceAllocationError('booking_not_found');

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${booking.listing.machineId}, 0))`;
    await tx.machineAllocation.updateMany({
      where: { bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
      data: { status: ResourceAllocationStatus.RELEASED, releasedAt },
    });
    await tx.acceleratorAllocation.updateMany({
      where: { bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
      data: { status: ResourceAllocationStatus.RELEASED, releasedAt },
    });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}
