import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  ListingStatus,
  MiningResourceKind,
  MiningRuntimeState,
  ModerationStatus,
  Prisma,
  ResourceAllocationStatus,
} from '@prisma/client';

export type RentalGpuBlockingReason =
  | 'ACCELERATOR_NOT_AVAILABLE'
  | 'ACCELERATOR_QUARANTINED'
  | 'ISOLATION_NOT_VERIFIED'
  | 'ACCELERATOR_NOT_VERIFIED'
  | 'ACCELERATOR_STALE'
  | 'RESOURCE_AUTHORITY_MISSING'
  | 'RESOURCE_AUTHORITY_DISABLED'
  | 'RESOURCE_AUTHORITY_QUARANTINED'
  | 'RESOURCE_AUTHORITY_STALE'
  | 'RESOURCE_RUNTIME_UNSAFE'
  | 'ACCELERATOR_ALLOCATED'
  | 'ACCELERATOR_ALREADY_LISTED'
  | 'FULL_MACHINE_LISTING_ACTIVE';

export type RentalGpuReadinessInput = {
  status: AcceleratorOperationalStatus;
  moderationStatus: ModerationStatus;
  isolationVerified: boolean;
  verifiedAt: Date | null;
  lastSeenAt: Date | null;
  miningResource: {
    kind: MiningResourceKind;
    enabled: boolean;
    quarantined: boolean;
    runtimeState: MiningRuntimeState;
    activeRentalId: string | null;
    lastSeenAt: Date | null;
  } | null;
  hasLiveAllocation: boolean;
  hasReservableListing: boolean;
  hasFullMachineListing: boolean;
};

export type RentalGpuReadiness = {
  publishable: boolean;
  blockingReason: RentalGpuBlockingReason | null;
};

type RentalGpuDb = Pick<Prisma.TransactionClient, 'machine'>;

const unsafeResourceStates = new Set<MiningRuntimeState>([
  MiningRuntimeState.PREEMPTING,
  MiningRuntimeState.VERIFYING_STOP,
  MiningRuntimeState.RENTAL_BLOCKED,
  MiningRuntimeState.QUARANTINED,
  MiningRuntimeState.EMERGENCY_STOPPED,
]);

// PAUSED still owns the accelerator identity: pausing an advert must not allow
// the owner to create a duplicate advert for the same physical GPU.
const reservableListingStatuses = [
  ListingStatus.PENDING_GPU_VERIFICATION,
  ListingStatus.ACTIVE,
  ListingStatus.RESERVED,
  ListingStatus.HIDDEN_OFFLINE,
  ListingStatus.PAUSED,
];

const liveAllocationStatuses = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

function fresh(value: Date | null, now: Date, staleAfterSeconds: number): boolean {
  return Boolean(value && value.getTime() >= now.getTime() - staleAfterSeconds * 1000);
}

export function computeRentalGpuReadiness(
  input: RentalGpuReadinessInput,
  now: Date,
  staleAfterSeconds: number,
): RentalGpuReadiness {
  if (
    input.moderationStatus !== ModerationStatus.CLEAR ||
    input.status === AcceleratorOperationalStatus.QUARANTINED
  ) {
    return { publishable: false, blockingReason: 'ACCELERATOR_QUARANTINED' };
  }
  if (input.status !== AcceleratorOperationalStatus.AVAILABLE) {
    return { publishable: false, blockingReason: 'ACCELERATOR_NOT_AVAILABLE' };
  }
  if (!input.isolationVerified) {
    return { publishable: false, blockingReason: 'ISOLATION_NOT_VERIFIED' };
  }
  if (!input.verifiedAt) {
    return { publishable: false, blockingReason: 'ACCELERATOR_NOT_VERIFIED' };
  }
  if (!fresh(input.lastSeenAt, now, staleAfterSeconds)) {
    return { publishable: false, blockingReason: 'ACCELERATOR_STALE' };
  }
  if (!input.miningResource || input.miningResource.kind !== MiningResourceKind.GPU) {
    return { publishable: false, blockingReason: 'RESOURCE_AUTHORITY_MISSING' };
  }
  if (!input.miningResource.enabled) {
    return { publishable: false, blockingReason: 'RESOURCE_AUTHORITY_DISABLED' };
  }
  if (input.miningResource.quarantined) {
    return { publishable: false, blockingReason: 'RESOURCE_AUTHORITY_QUARANTINED' };
  }
  if (!fresh(input.miningResource.lastSeenAt, now, staleAfterSeconds)) {
    return { publishable: false, blockingReason: 'RESOURCE_AUTHORITY_STALE' };
  }
  if (
    input.miningResource.activeRentalId ||
    unsafeResourceStates.has(input.miningResource.runtimeState)
  ) {
    return { publishable: false, blockingReason: 'RESOURCE_RUNTIME_UNSAFE' };
  }
  if (input.hasLiveAllocation) {
    return { publishable: false, blockingReason: 'ACCELERATOR_ALLOCATED' };
  }
  if (input.hasReservableListing) {
    return { publishable: false, blockingReason: 'ACCELERATOR_ALREADY_LISTED' };
  }
  if (input.hasFullMachineListing) {
    return { publishable: false, blockingReason: 'FULL_MACHINE_LISTING_ACTIVE' };
  }
  return { publishable: true, blockingReason: null };
}

export async function listOwnerRentalGpus(
  db: RentalGpuDb,
  machineId: string,
  ownerId: string,
  now: Date,
  staleAfterSeconds: number,
) {
  const machine = await db.machine.findFirst({
    where: { id: machineId, ownerId },
    select: {
      id: true,
      listings: {
        where: {
          resourceMode: ListingResourceMode.FULL_MACHINE,
          status: { in: reservableListingStatuses },
        },
        select: { id: true },
      },
      accelerators: {
        orderBy: [{ slotIndex: 'asc' }, { model: 'asc' }],
        select: {
          id: true,
          hardwareUuid: true,
          slotIndex: true,
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
              kind: true,
              enabled: true,
              quarantined: true,
              runtimeState: true,
              activeRentalId: true,
              lastSeenAt: true,
            },
          },
          allocations: {
            where: {
              status: { in: liveAllocationStatuses },
              releasedAt: null,
            },
            select: { id: true },
            take: 1,
          },
          listings: {
            where: { listing: { status: { in: reservableListingStatuses } } },
            select: { listingId: true },
            take: 1,
          },
        },
      },
    },
  });

  if (!machine) return null;
  const hasFullMachineListing = machine.listings.length > 0;

  return machine.accelerators.map((gpu) => {
    const readiness = computeRentalGpuReadiness({
      status: gpu.status,
      moderationStatus: gpu.moderationStatus,
      isolationVerified: gpu.isolationVerified,
      verifiedAt: gpu.verifiedAt,
      lastSeenAt: gpu.lastSeenAt,
      miningResource: gpu.miningResource,
      hasLiveAllocation: gpu.allocations.length > 0,
      hasReservableListing: gpu.listings.length > 0,
      hasFullMachineListing,
    }, now, staleAfterSeconds);

    return {
      id: gpu.id,
      hardwareUuid: gpu.hardwareUuid,
      slotIndex: gpu.slotIndex,
      vendor: gpu.vendor,
      model: gpu.model,
      vramMiB: gpu.vramMiB,
      driverVersion: gpu.driverVersion,
      cudaVersion: gpu.cudaVersion,
      verifiedAt: gpu.verifiedAt,
      lastSeenAt: gpu.lastSeenAt,
      ...readiness,
    };
  });
}

export async function requirePublishableRentalGpu(
  db: RentalGpuDb,
  machineId: string,
  ownerId: string,
  acceleratorId: string,
  now: Date,
  staleAfterSeconds: number,
) {
  const gpus = await listOwnerRentalGpus(db, machineId, ownerId, now, staleAfterSeconds);
  if (!gpus) return { kind: 'machine_not_found' as const };
  const gpu = gpus.find((item) => item.id === acceleratorId);
  if (!gpu) return { kind: 'accelerator_not_found' as const };
  if (!gpu.publishable) {
    return { kind: 'accelerator_not_publishable' as const, gpu };
  }
  return { kind: 'ok' as const, gpu };
}
