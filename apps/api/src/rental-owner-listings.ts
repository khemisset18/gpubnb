import {
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { isExactGpuPubliclyHealthy } from './rental-public-listings.js';

const liveBookingStatuses = [
  BookingStatus.AWAITING_DEPOSIT,
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
  BookingStatus.DEGRADED,
] as const;

const ownerListingSelect = {
  id: true,
  title: true,
  description: true,
  hourlyLamports: true,
  status: true,
  resourceMode: true,
  createdAt: true,
  updatedAt: true,
  machine: {
    select: {
      id: true,
      connectivity: true,
      operational: true,
      lastHeartbeatAt: true,
    },
  },
  accelerators: {
    take: 2,
    select: {
      accelerator: {
        select: {
          id: true,
          hardwareUuid: true,
          vendor: true,
          model: true,
          vramMiB: true,
          driverVersion: true,
          cudaVersion: true,
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
              activeRentalId: true,
              lastSeenAt: true,
            },
          },
        },
      },
    },
  },
  bookings: {
    where: { status: { in: [...liveBookingStatuses] } },
    select: { id: true, status: true, startsAt: true, endsAt: true },
    orderBy: { endsAt: 'desc' },
    take: 20,
  },
} satisfies Prisma.GpuListingSelect;

type OwnerListingRow = Prisma.GpuListingGetPayload<{ select: typeof ownerListingSelect }>;

function projectOwnerListing(row: OwnerListingRow, now: Date, staleAfterSeconds: number) {
  const selected = row.accelerators.length === 1 ? row.accelerators.at(0)?.accelerator ?? null : null;
  const gpuHealthy = selected ? isExactGpuPubliclyHealthy(selected, now, staleAfterSeconds) : false;
  const activeBooking = row.bookings
    .filter((booking) => booking.endsAt > now)
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0] ?? null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    hourlyLamports: row.hourlyLamports.toString(),
    status: row.status,
    resourceMode: row.resourceMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    machine: row.machine,
    gpu: selected ? {
      id: selected.id,
      hardwareUuid: selected.hardwareUuid,
      vendor: selected.vendor,
      model: selected.model,
      vramMiB: selected.vramMiB,
      driverVersion: selected.driverVersion,
      cudaVersion: selected.cudaVersion,
      status: selected.status,
      verifiedAt: selected.verifiedAt,
      lastSeenAt: selected.lastSeenAt,
      resourceRuntimeState: selected.miningResource?.runtimeState ?? null,
      activeRentalId: selected.miningResource?.activeRentalId ?? null,
    } : null,
    health: {
      exactAcceleratorLinked: row.resourceMode === ListingResourceMode.SELECTED_ACCELERATORS && row.accelerators.length === 1,
      gpuHealthy,
      publiclyVisible: row.status === ListingStatus.ACTIVE && gpuHealthy,
    },
    activeBooking,
  };
}

export async function listOwnerExactGpuListings(
  db: PrismaClient,
  ownerId: string,
  now: Date,
  staleAfterSeconds: number,
) {
  const rows = await db.gpuListing.findMany({
    where: {
      ownerId,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    },
    select: ownerListingSelect,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map((row) => projectOwnerListing(row, now, staleAfterSeconds));
}
