import {
  AcceleratorOperationalStatus,
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MiningRuntimeState,
  ModerationStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

const visibleAcceleratorStatuses = new Set<AcceleratorOperationalStatus>([
  AcceleratorOperationalStatus.AVAILABLE,
  AcceleratorOperationalStatus.RESERVED,
  AcceleratorOperationalStatus.RUNNING,
]);

const unsafeResourceStates = new Set<MiningRuntimeState>([
  MiningRuntimeState.PREEMPTING,
  MiningRuntimeState.VERIFYING_STOP,
  MiningRuntimeState.RENTAL_BLOCKED,
  MiningRuntimeState.QUARANTINED,
  MiningRuntimeState.EMERGENCY_STOPPED,
]);

const liveBookingStatuses = [
  BookingStatus.AWAITING_DEPOSIT,
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
];

function fresh(value: Date | null, now: Date, staleAfterSeconds: number): boolean {
  return Boolean(value && value.getTime() >= now.getTime() - staleAfterSeconds * 1000);
}

function exactGpuHealthy(
  accelerator: {
    status: AcceleratorOperationalStatus;
    moderationStatus: ModerationStatus;
    isolationVerified: boolean;
    verifiedAt: Date | null;
    lastSeenAt: Date | null;
    miningResource: {
      enabled: boolean;
      quarantined: boolean;
      runtimeState: MiningRuntimeState;
      lastSeenAt: Date | null;
    } | null;
  },
  now: Date,
  staleAfterSeconds: number,
): boolean {
  return visibleAcceleratorStatuses.has(accelerator.status) &&
    accelerator.moderationStatus === ModerationStatus.CLEAR &&
    accelerator.isolationVerified &&
    accelerator.verifiedAt !== null &&
    fresh(accelerator.lastSeenAt, now, staleAfterSeconds) &&
    accelerator.miningResource !== null &&
    accelerator.miningResource.enabled &&
    !accelerator.miningResource.quarantined &&
    !unsafeResourceStates.has(accelerator.miningResource.runtimeState) &&
    fresh(accelerator.miningResource.lastSeenAt, now, staleAfterSeconds);
}

const publicListingSelect = {
  id: true,
  title: true,
  description: true,
  hourlyLamports: true,
  createdAt: true,
  resourceMode: true,
  owner: {
    select: {
      pseudonym: true,
      profile: { select: { reliabilityScore: true, completedSessions: true } },
    },
  },
  machine: {
    select: {
      id: true,
      connectivity: true,
      moderationStatus: true,
      lastHeartbeatAt: true,
      ramTotalMiB: true,
      diskTotalMiB: true,
      dockerAvailable: true,
      nvidiaRuntimeAvailable: true,
      operatingSystem: true,
      virtualizationAvailable: true,
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
              lastSeenAt: true,
            },
          },
        },
      },
    },
  },
  bookings: {
    where: { status: { in: liveBookingStatuses } },
    select: { status: true, startsAt: true, endsAt: true },
    orderBy: { endsAt: 'desc' },
    take: 20,
  },
} satisfies Prisma.GpuListingSelect;

type PublicListingRow = Prisma.GpuListingGetPayload<{ select: typeof publicListingSelect }>;

function projectListing(row: PublicListingRow, now: Date, staleAfterSeconds: number) {
  if (row.resourceMode !== ListingResourceMode.SELECTED_ACCELERATORS) return null;
  if (
    row.machine.connectivity !== MachineConnectivity.ONLINE ||
    row.machine.moderationStatus !== ModerationStatus.CLEAR ||
    !fresh(row.machine.lastHeartbeatAt, now, staleAfterSeconds)
  ) return null;
  if (row.accelerators.length !== 1) return null;
  const gpu = row.accelerators[0].accelerator;
  if (!exactGpuHealthy(gpu, now, staleAfterSeconds)) return null;

  const active = row.bookings
    .filter((booking) => booking.endsAt > now)
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  const availability = !active
    ? { state: 'AVAILABLE' as const, label: 'Disponible', availableAt: null }
    : active.status === BookingStatus.ACTIVE
      ? { state: 'WORKING' as const, label: 'En travail', availableAt: active.endsAt }
      : { state: 'RENTED' as const, label: 'En location', availableAt: active.endsAt };

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    hourlyLamports: row.hourlyLamports.toString(),
    createdAt: row.createdAt,
    resourceMode: row.resourceMode,
    owner: row.owner,
    gpu: {
      id: gpu.id,
      vendor: gpu.vendor,
      model: gpu.model,
      vramMiB: gpu.vramMiB,
      driverVersion: gpu.driverVersion,
      cudaVersion: gpu.cudaVersion,
      verifiedAt: gpu.verifiedAt,
    },
    machine: {
      id: row.machine.id,
      ramTotalMiB: row.machine.ramTotalMiB,
      diskTotalMiB: row.machine.diskTotalMiB,
      dockerAvailable: row.machine.dockerAvailable,
      nvidiaRuntimeAvailable: row.machine.nvidiaRuntimeAvailable,
      operatingSystem: row.machine.operatingSystem,
      virtualizationAvailable: row.machine.virtualizationAvailable,
      // Backward-compatible capability aliases for workspace analysis. These are
      // derived from the exact selected accelerator, never the Machine GPU summary.
      gpuModel: gpu.model,
      vramMiB: gpu.vramMiB,
      cudaVersion: gpu.cudaVersion,
    },
    availability,
  };
}

export async function listPublicExactGpuListings(
  db: PrismaClient,
  now: Date,
  staleAfterSeconds: number,
) {
  const rows = await db.gpuListing.findMany({
    where: {
      status: ListingStatus.ACTIVE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    },
    select: publicListingSelect,
    take: 100,
    orderBy: { createdAt: 'desc' },
  });

  return rows
    .map((row) => projectListing(row, now, staleAfterSeconds))
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

export async function getPublicExactGpuListing(
  db: PrismaClient,
  listingId: string,
  now: Date,
  staleAfterSeconds: number,
) {
  const row = await db.gpuListing.findFirst({
    where: {
      id: listingId,
      status: ListingStatus.ACTIVE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    },
    select: publicListingSelect,
  });
  return row ? projectListing(row, now, staleAfterSeconds) : null;
}
