import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  MachineWorkspaceState,
  ModerationStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';

import { config } from './config.js';
import { workspaceManifest } from './workspace-manifests.js';
import {
  windowsNativeWorkspaceCandidate,
  type WindowsNativeDesktopSlug,
} from './windows-native-workspace-policy.js';

/**
 * An explicitly dark-by-default *commercial* gate, separate from the old
 * private Windows console qualification. The console path is never an
 * acceptable source for a public renter's Windows desktop.
 */
export function windowsNativeCommercialReleaseEnabled(): boolean {
  return config.WINDOWS_NATIVE_RENTALS_ENABLED === 'true';
}

const rentableGpuStatuses: AcceleratorOperationalStatus[] = [
  AcceleratorOperationalStatus.AVAILABLE,
  AcceleratorOperationalStatus.RESERVED,
  AcceleratorOperationalStatus.RUNNING,
];

const rentableMachineStatuses: MachineOperational[] = [
  MachineOperational.AVAILABLE,
  MachineOperational.RESERVED,
  MachineOperational.RUNNING,
];

export type NativeRentalEligibility = {
  eligible: boolean;
  reason: string | null;
  machineId: string | null;
};

/**
 * Re-read the exact listing, physical GPU, signed heartbeat and opt-in from
 * PostgreSQL. No caller-supplied GPU UUID, host address or stream URL is used.
 * Resource allocation and launch still require their independent atomic
 * checks later in the booking/session pipeline.
 *
 * Using a short heartbeat bound makes a stale native capability fail closed.
 * This is a static pre-booking screen, NOT proof of renter VM/session isolation.
 */
export async function nativeRentalEligibility(
  db: PrismaClient | Prisma.TransactionClient,
  listingId: string,
  slug: WindowsNativeDesktopSlug,
  now: Date = new Date(),
): Promise<NativeRentalEligibility> {
  if (!windowsNativeCommercialReleaseEnabled()) {
    return { eligible: false, reason: 'windows_native_release_not_approved', machineId: null };
  }
  const listing = await db.gpuListing.findFirst({
    where: {
      id: listingId,
      status: ListingStatus.ACTIVE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    },
    select: {
      machineId: true,
      machine: {
        select: {
          connectivity: true,
          operational: true,
          moderationStatus: true,
          operatingSystem: true,
          lastHeartbeatAt: true,
          nativeDesktopStreamingAvailable: true,
          nativeDesktopStreamingGpuUuid: true,
          ramTotalMiB: true,
          diskTotalMiB: true,
        },
      },
      accelerators: {
        select: {
          accelerator: {
            hardwareUuid: true,
            vendor: true,
            vramMiB: true,
            status: true,
            moderationStatus: true,
            lastSeenAt: true,
            miningResource: {
              select: { enabled: true, quarantined: true, lastSeenAt: true },
            },
          },
        },
        take: 2,
      },
    },
  });
  if (!listing || listing.accelerators.length !== 1) {
    return { eligible: false, reason: 'native_exact_gpu_listing_required', machineId: null };
  }

  const gpu = listing.accelerators[0]!.accelerator;
  const host = listing.machine;
  const fresh = (value: Date | null): boolean =>
    value !== null && value.getTime() <= now.getTime()
    && now.getTime() - value.getTime() <= config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS * 1000;

  if (host.connectivity !== MachineConnectivity.ONLINE
    || !rentableMachineStatuses.includes(host.operational)
    || host.moderationStatus !== ModerationStatus.CLEAR
    || !fresh(host.lastHeartbeatAt)
    || gpu.moderationStatus !== ModerationStatus.CLEAR
    || !rentableGpuStatuses.includes(gpu.status)
    || !fresh(gpu.lastSeenAt)
    || gpu.vendor?.toUpperCase() !== 'NVIDIA'
    || !gpu.miningResource?.enabled
    || gpu.miningResource.quarantined
    || !fresh(gpu.miningResource.lastSeenAt)) {
    return { eligible: false, reason: 'native_gpu_or_host_not_healthy', machineId: listing.machineId };
  }

  const manifest = workspaceManifest(slug);
  if (!manifest) return { eligible: false, reason: 'native_workspace_unknown', machineId: listing.machineId };
  const candidate = windowsNativeWorkspaceCandidate(
    { ...host, vramMiB: gpu.vramMiB },
    manifest,
    gpu.hardwareUuid,
  );
  if (!candidate.candidate) {
    return { eligible: false, reason: 'native_hardware_or_helper_not_ready', machineId: listing.machineId };
  }

  const consent = await db.machineWorkspace.findFirst({
    where: {
      machineId: listing.machineId,
      workspace: { slug },
      enabledByOwner: true,
      state: { in: [MachineWorkspaceState.READY, MachineWorkspaceState.LIMITED] },
    },
    select: { id: true },
  });
  if (!consent) {
    return { eligible: false, reason: 'native_workspace_not_enabled_by_owner', machineId: listing.machineId };
  }

  return { eligible: true, reason: null, machineId: listing.machineId };
}
