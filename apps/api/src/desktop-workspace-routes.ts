import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import {
  AcceleratorOperationalStatus,
  BookingStatus,
  JobStatus,
  JobType,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  MachineWorkspaceState,
  MiningRuntimeState,
  ModerationStatus,
  Prisma,
  ResourceAllocationStatus,
  SessionTerminationReason,
  WorkspaceRuntimeBackend,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Redis } from 'ioredis';

import { requireSession } from './auth.js';
import { runBookingTransaction } from './booking-transaction-retry.js';
import { config } from './config.js';
import { ensureCompatibleMachineWorkspace, type ExecutableWorkspaceSlug } from './machine-workspace-catalog.js';
import { evaluateWorkspaceAccess } from './workspace-access-policy.js';
import { issueWorkspaceAccessGrant } from './workspace-access.js';
import { isWorkspaceGatewayLive } from './workspace-gateway-liveness.js';
import {
  allocateWindowsNativeQualificationBookingResources,
  ResourceAllocationError,
} from './resource-allocation-service.js';
import { preparationPhase, safeConnection } from './workspace-renter-routes.js';
import { WINDOWS_NATIVE_GPU_UUID_RE } from './windows-native-capability.js';

const desktopWorkspaceSlugs = ['cloud-desktop', 'creator', 'cad', 'gaming'] as const;
type DesktopWorkspaceSlug = typeof desktopWorkspaceSlugs[number];

const activeBookings: BookingStatus[] = [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE];

const qualificationBookingStatuses: BookingStatus[] = [
  BookingStatus.AWAITING_DEPOSIT,
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
];

const WINDOWS_NATIVE_QUALIFICATION_SECONDS = 30 * 60;

const activeAllocations: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

const rentableAccelerators: AcceleratorOperationalStatus[] = [
  AcceleratorOperationalStatus.AVAILABLE,
  AcceleratorOperationalStatus.RESERVED,
  AcceleratorOperationalStatus.RUNNING,
];

const liveWorkspaceSessions: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
];

const activeQualificationJobs: JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
];

function windowsNativePrivateQualificationEnabled(): boolean {
  return config.BETA_TEST_DEV_BYPASS === 'true'
    && config.ESCROW_PROGRAM_ID === 'NOT_DEPLOYED_YET';
}

const workspaceSpec: Record<DesktopWorkspaceSlug, {
  requestedStep: string;
  requestedEvent: string;
  timeoutSeconds: number;
  maxRamMiB: number;
  maxCpuCores: number;
  storageQuotaMiB: number;
}> = {
  'cloud-desktop': {
    requestedStep: 'CLOUD_DESKTOP_REQUESTED',
    requestedEvent: 'CLOUD_DESKTOP_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 8192,
    maxCpuCores: 4,
    storageQuotaMiB: 81920,
  },
  creator: {
    requestedStep: 'CREATOR_REQUESTED',
    requestedEvent: 'CREATOR_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 16384,
    maxCpuCores: 4,
    storageQuotaMiB: 102400,
  },
  cad: {
    requestedStep: 'CAD_REQUESTED',
    requestedEvent: 'CAD_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 16384,
    maxCpuCores: 4,
    storageQuotaMiB: 122880,
  },
  gaming: {
    requestedStep: 'GAMING_REQUESTED',
    requestedEvent: 'GAMING_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 16384,
    maxCpuCores: 4,
    storageQuotaMiB: 204800,
  },
};

function executableSlug(slug: DesktopWorkspaceSlug): ExecutableWorkspaceSlug {
  return slug;
}


async function rearmTimedOutWindowsNativeQualificationHost(
  db: PrismaClient,
  renterId: string,
): Promise<boolean> {
  if (!windowsNativePrivateQualificationEnabled()) return false;

  const now = new Date();
  const candidates = await db.gpuListing.findMany({
    where: {
      status: ListingStatus.HIDDEN_OFFLINE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
      machine: {
        connectivity: MachineConnectivity.ONLINE,
        moderationStatus: ModerationStatus.CLEAR,
        operational: MachineOperational.DEGRADED,
        nativeDesktopStreamingAvailable: true,
      },
    },
    take: 3,
    select: { id: true, machineId: true },
  });

  if (candidates.length !== 1 || !candidates[0]) return false;
  const target = candidates[0];

  return runBookingTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${target.machineId}, 1))`;

    const listing = await tx.gpuListing.findFirst({
      where: {
        id: target.id,
        machineId: target.machineId,
        status: ListingStatus.HIDDEN_OFFLINE,
        resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
      },
      select: {
        id: true,
        machineId: true,
        machine: {
          select: {
            operatingSystem: true,
            connectivity: true,
            operational: true,
            moderationStatus: true,
            lastHeartbeatAt: true,
            nativeDesktopStreamingAvailable: true,
            nativeDesktopStreamingGpuUuid: true,
          },
        },
        accelerators: {
          select: {
            accelerator: {
              select: {
                id: true,
                machineId: true,
                hardwareUuid: true,
                vendor: true,
                status: true,
                moderationStatus: true,
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
      },
    });
    if (!listing) return false;

    const machine = listing.machine;
    const accelerator = listing.accelerators[0]?.accelerator;
    const nativeGpuUuid = machine.nativeDesktopStreamingGpuUuid?.trim() ?? '';
    const maxAgeMs = config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS * 1000;
    const fresh = (value: Date | null) =>
      value !== null
      && value.getTime() <= now.getTime()
      && now.getTime() - value.getTime() <= maxAgeMs;

    const physicalProofSafe = Boolean(
      listing.accelerators.length === 1
      && accelerator
      && machine.operatingSystem?.trim().toLowerCase().startsWith('windows')
      && machine.connectivity === MachineConnectivity.ONLINE
      && machine.operational === MachineOperational.DEGRADED
      && machine.moderationStatus === ModerationStatus.CLEAR
      && machine.nativeDesktopStreamingAvailable === true
      && WINDOWS_NATIVE_GPU_UUID_RE.test(nativeGpuUuid)
      && fresh(machine.lastHeartbeatAt)
      && accelerator.machineId === listing.machineId
      && accelerator.vendor?.trim().toUpperCase() === 'NVIDIA'
      && accelerator.status === AcceleratorOperationalStatus.AVAILABLE
      && accelerator.moderationStatus === ModerationStatus.CLEAR
      && accelerator.hardwareUuid.toLowerCase() === nativeGpuUuid.toLowerCase()
      && fresh(accelerator.lastSeenAt)
      && accelerator.miningResource !== null
      && accelerator.miningResource.enabled
      && !accelerator.miningResource.quarantined
      && accelerator.miningResource.runtimeState === MiningRuntimeState.IDLE
      && accelerator.miningResource.activeRentalId === null
      && fresh(accelerator.miningResource.lastSeenAt)
    );
    if (!physicalProofSafe) return false;

    const priorQualification = await tx.booking.findFirst({
      where: {
        buyerId: renterId,
        listingId: listing.id,
        status: BookingStatus.DEGRADED,
        workspaceSessions: {
          some: {
            runtimeBackend: WorkspaceRuntimeBackend.WINDOWS_NATIVE,
            startedAt: null,
            gatewayLastSeenAt: null,
            OR: [
              { status: WorkspaceSessionStatus.TIMED_OUT },
              {
                status: WorkspaceSessionStatus.FAILED,
                terminationReason: SessionTerminationReason.AGENT_OFFLINE,
              },
            ],
          },
        },
      },
      select: {
        id: true,
        workspaceSessions: {
          where: {
            runtimeBackend: WorkspaceRuntimeBackend.WINDOWS_NATIVE,
            startedAt: null,
            gatewayLastSeenAt: null,
            OR: [
              { status: WorkspaceSessionStatus.TIMED_OUT },
              {
                status: WorkspaceSessionStatus.FAILED,
                terminationReason: SessionTerminationReason.AGENT_OFFLINE,
              },
            ],
          },
          select: { status: true, terminationReason: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!priorQualification) return false;

    const recoverableOfflineFailure = priorQualification.workspaceSessions.some(
      (workspace) =>
        workspace.status === WorkspaceSessionStatus.FAILED
        && workspace.terminationReason === SessionTerminationReason.AGENT_OFFLINE,
    );

    const [
      liveSessions,
      activeBookingsCount,
      activeJobs,
      liveMachineAllocations,
      liveAcceleratorAllocations,
    ] = await Promise.all([
      tx.workspaceSession.count({
        where: { machineId: listing.machineId, status: { in: liveWorkspaceSessions } },
      }),
      tx.booking.count({
        where: {
          listing: { machineId: listing.machineId },
          status: { in: qualificationBookingStatuses },
          endsAt: { gt: now },
        },
      }),
      tx.job.count({
        where: { machineId: listing.machineId, status: { in: activeQualificationJobs } },
      }),
      tx.machineAllocation.findMany({
        where: { machineId: listing.machineId, status: { in: activeAllocations } },
        select: { id: true, bookingId: true },
      }),
      tx.acceleratorAllocation.findMany({
        where: {
          accelerator: { machineId: listing.machineId },
          status: { in: activeAllocations },
        },
        select: { id: true, bookingId: true },
      }),
    ]);

    if (
      liveSessions !== 0
      || activeBookingsCount !== 0
      || activeJobs !== 0
    ) {
      return false;
    }

    const noLiveAllocations =
      liveMachineAllocations.length === 0
      && liveAcceleratorAllocations.length === 0;

    const onlyFailedQualificationAllocation =
      recoverableOfflineFailure
      && liveMachineAllocations.length === 0
      && liveAcceleratorAllocations.length === 1
      && liveAcceleratorAllocations[0]?.bookingId === priorQualification.id;

    if (!noLiveAllocations && !onlyFailedQualificationAllocation) return false;

    if (onlyFailedQualificationAllocation) {
      const released = await tx.acceleratorAllocation.updateMany({
        where: {
          id: liveAcceleratorAllocations[0]!.id,
          bookingId: priorQualification.id,
          status: { in: activeAllocations },
        },
        data: {
          status: ResourceAllocationStatus.RELEASED,
          releasedAt: now,
        },
      });
      if (released.count !== 1) return false;
    }

    const updated = await tx.machine.updateMany({
      where: {
        id: listing.machineId,
        connectivity: MachineConnectivity.ONLINE,
        operational: MachineOperational.DEGRADED,
        moderationStatus: ModerationStatus.CLEAR,
        nativeDesktopStreamingAvailable: true,
      },
      data: { operational: MachineOperational.AVAILABLE },
    });

    return updated.count === 1;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}


async function createWindowsNativeQualificationBooking(
  db: PrismaClient,
  renterId: string,
) {
  if (!windowsNativePrivateQualificationEnabled()) {
    return { error: 'windows_native_qualification_disabled' as const };
  }

  // A never-opened private qualification deliberately leaves the Host DEGRADED.
  // Once its session has timed out and every live authority/resource is gone,
  // re-arm only this private qualification Host from fresh signed physical proof.
  await rearmTimedOutWindowsNativeQualificationHost(db, renterId);

  const now = new Date();
  const existing = await db.booking.findFirst({
    where: {
      buyerId: renterId,
      status: { in: qualificationBookingStatuses },
      endsAt: { gt: now },
      listing: {
        status: ListingStatus.HIDDEN_OFFLINE,
        resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
        machine: { nativeDesktopStreamingAvailable: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      expectedSeconds: true,
    },
  });
  if (existing) return { booking: existing, created: false };

  const candidates = await db.gpuListing.findMany({
    where: {
      status: ListingStatus.HIDDEN_OFFLINE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
      // Qualification is a private, no-payment beta path. Unlike the public
      // marketplace, it intentionally permits the provider account to act as
      // the renter so the two-PC isolation proof does not require a second
      // GPUbnb account. The listing remains HIDDEN_OFFLINE and all Windows
      // native capability checks below still apply.
      machine: {
        connectivity: MachineConnectivity.ONLINE,
        moderationStatus: ModerationStatus.CLEAR,
        nativeDesktopStreamingAvailable: true,
      },
    },
    take: 3,
    select: {
      id: true,
      hourlyLamports: true,
      machine: {
        select: {
          id: true,
          operatingSystem: true,
          operational: true,
          lastHeartbeatAt: true,
          nativeDesktopStreamingGpuUuid: true,
        },
      },
      accelerators: {
        select: {
          accelerator: {
            select: {
              id: true,
              machineId: true,
              hardwareUuid: true,
              vendor: true,
              moderationStatus: true,
              status: true,
            },
          },
        },
      },
    },
  });

  const heartbeatFresh = (lastHeartbeatAt: Date | null) =>
    lastHeartbeatAt !== null
    && lastHeartbeatAt.getTime() <= now.getTime()
    && now.getTime() - lastHeartbeatAt.getTime()
      <= config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS * 1000;

  const eligible = candidates.filter((listing) => {
    const machine = listing.machine;
    const nativeGpuUuid = machine.nativeDesktopStreamingGpuUuid?.trim() ?? '';
    const accelerator = listing.accelerators[0]?.accelerator;
    const os = machine.operatingSystem?.trim().toLowerCase() ?? '';

    return (
      listing.accelerators.length === 1
      && Boolean(accelerator)
      && os.startsWith('windows')
      && WINDOWS_NATIVE_GPU_UUID_RE.test(nativeGpuUuid)
      && heartbeatFresh(machine.lastHeartbeatAt)
      && (
        machine.operational === MachineOperational.AVAILABLE
        || machine.operational === MachineOperational.RESERVED
        || machine.operational === MachineOperational.RUNNING
      )
      && accelerator?.machineId === machine.id
      && accelerator.vendor?.trim().toUpperCase() === 'NVIDIA'
      && accelerator.moderationStatus === ModerationStatus.CLEAR
      && rentableAccelerators.includes(accelerator.status)
      && accelerator.hardwareUuid.toLowerCase() === nativeGpuUuid.toLowerCase()
    );
  });

  if (eligible.length === 0) {
    return { error: 'windows_native_qualification_host_not_ready' as const };
  }
  if (eligible.length !== 1) {
    return { error: 'windows_native_qualification_exactly_one_host_required' as const };
  }

  const target = eligible[0]!;
  const startsAt = now;
  const endsAt = new Date(now.getTime() + WINDOWS_NATIVE_QUALIFICATION_SECONDS * 1000);
  const quotedLamports =
    target.hourlyLamports * BigInt(WINDOWS_NATIVE_QUALIFICATION_SECONDS) / 3600n;

  if (quotedLamports <= 0n) {
    return { error: 'windows_native_qualification_quote_too_small' as const };
  }

  let booking: {
    id: string;
    status: BookingStatus;
    startsAt: Date;
    endsAt: Date;
    expectedSeconds: number;
  };

  try {
    booking = await runBookingTransaction(db, async (tx) => {
      const fresh = await tx.gpuListing.findFirst({
        where: {
          id: target.id,
          status: ListingStatus.HIDDEN_OFFLINE,
          resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
        },
        select: {
          id: true,
          machineId: true,
          machine: {
            select: {
              operatingSystem: true,
              connectivity: true,
              operational: true,
              moderationStatus: true,
              lastHeartbeatAt: true,
              nativeDesktopStreamingAvailable: true,
              nativeDesktopStreamingGpuUuid: true,
            },
          },
          accelerators: {
            select: {
              accelerator: {
                select: {
                  id: true,
                  machineId: true,
                  hardwareUuid: true,
                  vendor: true,
                  moderationStatus: true,
                  status: true,
                },
              },
            },
          },
        },
      });

      if (!fresh) throw new Error('windows_native_qualification_host_not_ready');

      const nativeGpuUuid = fresh.machine.nativeDesktopStreamingGpuUuid?.trim() ?? '';
      const accelerator = fresh.accelerators[0]?.accelerator;
      const os = fresh.machine.operatingSystem?.trim().toLowerCase() ?? '';
      const freshNow = new Date();
      const freshHeartbeat =
        fresh.machine.lastHeartbeatAt !== null
        && fresh.machine.lastHeartbeatAt.getTime() <= freshNow.getTime()
        && freshNow.getTime() - fresh.machine.lastHeartbeatAt.getTime()
          <= config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS * 1000;

      if (
        fresh.accelerators.length !== 1
        || !accelerator
        || !os.startsWith('windows')
        || fresh.machine.connectivity !== MachineConnectivity.ONLINE
        || fresh.machine.moderationStatus !== ModerationStatus.CLEAR
        || fresh.machine.nativeDesktopStreamingAvailable !== true
        || !WINDOWS_NATIVE_GPU_UUID_RE.test(nativeGpuUuid)
        || !freshHeartbeat
        || !(
          fresh.machine.operational === MachineOperational.AVAILABLE
          || fresh.machine.operational === MachineOperational.RESERVED
          || fresh.machine.operational === MachineOperational.RUNNING
        )
        || accelerator.machineId !== fresh.machineId
        || accelerator.vendor?.trim().toUpperCase() !== 'NVIDIA'
        || accelerator.moderationStatus !== ModerationStatus.CLEAR
        || !rentableAccelerators.includes(accelerator.status)
        || accelerator.hardwareUuid.toLowerCase() !== nativeGpuUuid.toLowerCase()
      ) {
        throw new Error('windows_native_qualification_host_not_ready');
      }

      const overlap = await tx.booking.count({
        where: {
          listingId: fresh.id,
          status: { in: qualificationBookingStatuses },
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
      });
      if (overlap !== 0) throw new Error('windows_native_qualification_host_reserved');

      return tx.booking.create({
        data: {
          buyerId: renterId,
          listingId: fresh.id,
          startsAt,
          endsAt,
          quotedLamports,
          expectedSeconds: WINDOWS_NATIVE_QUALIFICATION_SECONDS,
          idempotencyKey: randomUUID(),
          status: BookingStatus.AWAITING_DEPOSIT,
        },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          expectedSeconds: true,
        },
      });
    });
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === 'windows_native_qualification_host_not_ready'
        || error.message === 'windows_native_qualification_host_reserved'
      )
    ) {
      return { error: error.message };
    }
    throw error;
  }

  try {
    await allocateWindowsNativeQualificationBookingResources(db, {
      bookingId: booking.id,
      buyerId: renterId,
    });
  } catch (error) {
    await db.booking.delete({ where: { id: booking.id } }).catch(() => {});
    if (error instanceof ResourceAllocationError) {
      return { error: `windows_native_qualification_${error.code}` };
    }
    throw error;
  }

  return { booking, created: true };
}


async function createWindowsNativeQualificationSession(
  db: PrismaClient,
  bookingId: string,
  renterId: string,
) {
  if (!windowsNativePrivateQualificationEnabled()) {
    return { error: 'windows_native_qualification_disabled' as const };
  }

  try {
    const session = await runBookingTransaction(db, async (tx) => {
      const now = new Date();

      const booking = await tx.booking.findFirst({
        where: {
          id: bookingId,
          buyerId: renterId,
          status: { in: activeBookings },
          endsAt: { gt: now },
        },
        select: {
          id: true,
          endsAt: true,
          listing: {
            select: {
              machineId: true,
              resourceMode: true,
              machine: {
                select: {
                  operatingSystem: true,
                  connectivity: true,
                  operational: true,
                  moderationStatus: true,
                  lastHeartbeatAt: true,
                  nativeDesktopStreamingAvailable: true,
                  nativeDesktopStreamingGpuUuid: true,
                },
              },
            },
          },
        },
      });

      if (!booking) throw new Error('funded_booking_required');

      const machine = booking.listing.machine;
      const nativeGpuUuid = machine.nativeDesktopStreamingGpuUuid?.trim() ?? '';
      const os = machine.operatingSystem?.trim().toLowerCase() ?? '';

      const heartbeatFresh =
        machine.lastHeartbeatAt !== null
        && machine.lastHeartbeatAt.getTime() <= now.getTime()
        && now.getTime() - machine.lastHeartbeatAt.getTime()
          <= config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS * 1000;

      const machineReady =
        os.startsWith('windows')
        && machine.nativeDesktopStreamingAvailable === true
        && WINDOWS_NATIVE_GPU_UUID_RE.test(nativeGpuUuid)
        && machine.connectivity === MachineConnectivity.ONLINE
        && machine.moderationStatus === ModerationStatus.CLEAR
        && (
          machine.operational === MachineOperational.AVAILABLE
          || machine.operational === MachineOperational.RESERVED
          || machine.operational === MachineOperational.RUNNING
        )
        && heartbeatFresh;

      if (!machineReady) {
        throw new Error('windows_native_qualification_host_not_ready');
      }

      let accelerator: {
        machineId: string;
        hardwareUuid: string;
        vendor: string | null;
        moderationStatus: ModerationStatus;
        status: AcceleratorOperationalStatus;
      };

      if (booking.listing.resourceMode === ListingResourceMode.FULL_MACHINE) {
        const machineAllocation = await tx.machineAllocation.findUnique({
          where: { bookingId },
          select: {
            machineId: true,
            status: true,
          },
        });

        if (
          !machineAllocation
          || machineAllocation.machineId !== booking.listing.machineId
          || !activeAllocations.includes(machineAllocation.status)
        ) {
          throw new Error('windows_native_qualification_machine_allocation_required');
        }

        const machineAccelerators = await tx.accelerator.findMany({
          where: { machineId: booking.listing.machineId },
          select: {
            machineId: true,
            hardwareUuid: true,
            vendor: true,
            moderationStatus: true,
            status: true,
          },
        });

        if (machineAccelerators.length !== 1 || !machineAccelerators[0]) {
          throw new Error('windows_native_qualification_exactly_one_gpu_required');
        }

        accelerator = machineAccelerators[0];
      } else {
        const allocations = await tx.acceleratorAllocation.findMany({
          where: {
            bookingId,
            status: { in: activeAllocations },
          },
          select: {
            accelerator: {
              select: {
                machineId: true,
                hardwareUuid: true,
                vendor: true,
                moderationStatus: true,
                status: true,
              },
            },
          },
        });

        const allocation = allocations[0];

        if (allocations.length !== 1 || !allocation) {
          throw new Error('windows_native_qualification_exactly_one_gpu_required');
        }

        accelerator = allocation.accelerator;
      }

      if (
        accelerator.machineId !== booking.listing.machineId
        || accelerator.vendor?.trim().toUpperCase() !== 'NVIDIA'
        || accelerator.moderationStatus !== ModerationStatus.CLEAR
        || !rentableAccelerators.includes(accelerator.status)
        || accelerator.hardwareUuid.toLowerCase() !== nativeGpuUuid.toLowerCase()
      ) {
        throw new Error('windows_native_qualification_gpu_mismatch');
      }

      const existing = await tx.workspaceSession.findFirst({
        where: {
          bookingId,
          renterId,
          runtimeBackend: WorkspaceRuntimeBackend.WINDOWS_NATIVE,
          machineWorkspace: {
            workspace: { slug: 'cloud-desktop' },
          },
        },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          preparationProgress: true,
          preparationStep: true,
        },
      });

      if (existing) {
        if (
          existing.expiresAt > now
          && (
            existing.status === WorkspaceSessionStatus.READY
            || existing.status === WorkspaceSessionStatus.RUNNING
          )
        ) {
          return existing;
        }

        throw new Error('windows_native_qualification_existing_session_not_live');
      }

      const otherLiveSessionCount = await tx.workspaceSession.count({
        where: {
          bookingId,
          status: { in: liveWorkspaceSessions },
        },
      });

      if (otherLiveSessionCount !== 0) {
        throw new Error('windows_native_qualification_other_live_workspace');
      }

      const definition = await tx.workspaceDefinition.findUnique({
        where: { slug: 'cloud-desktop' },
        select: { id: true },
      });

      if (!definition) {
        throw new Error(
          'windows_native_qualification_cloud_desktop_definition_missing',
        );
      }

      const qualificationAnalysis = {
        score: 100,
        state: 'READY',
        reasons: [
          'WINDOWS_NATIVE_PRIVATE_QUALIFICATION',
          'EXACT_ALLOCATED_GPU_UUID_MATCH',
          'SIGNED_NATIVE_STREAMING_CAPABILITY',
        ],
        missing: [],
        reasonCodes: [],
        missingCodes: [],
      };

      const machineWorkspace = await tx.machineWorkspace.upsert({
        where: {
          machineId_workspaceId: {
            machineId: booking.listing.machineId,
            workspaceId: definition.id,
          },
        },
        update: {
          compatibilityScore: 100,
          state: MachineWorkspaceState.READY,
          analysis: qualificationAnalysis,
          analyzedAt: now,
        },
        create: {
          machineId: booking.listing.machineId,
          workspaceId: definition.id,
          compatibilityScore: 100,
          state: MachineWorkspaceState.READY,
          analysis: qualificationAnalysis,
        },
      });

      const spec = workspaceSpec['cloud-desktop'];

      return tx.workspaceSession.create({
        data: {
          bookingId,
          renterId,
          machineId: booking.listing.machineId,
          machineWorkspaceId: machineWorkspace.id,
          status: WorkspaceSessionStatus.READY,
          isolationType: 'WINDOWS_NATIVE',
          runtimeBackend: WorkspaceRuntimeBackend.WINDOWS_NATIVE,
          resourceLimits: {
            maxRamMiB: spec.maxRamMiB,
            maxCpuCores: spec.maxCpuCores,
            storageQuotaMiB: spec.storageQuotaMiB,
            networkAccess: 'RESTRICTED',
            autoStopMinutes: 60,
          },
          connectionType: 'GPUBNB_GATEWAY',
          preparationProgress: 100,
          preparationStep: 'WINDOWS_NATIVE_QUALIFICATION_READY',
          preparationRequestedAt: now,
          preparationStartedAt: now,
          preparationCompletedAt: now,
          readyDeadlineAt: new Date(
            Math.min(
              booking.endsAt.getTime(),
              now.getTime() + 15 * 60_000,
            ),
          ),
          expiresAt: booking.endsAt,
          events: {
            create: {
              actorType: 'RENTER',
              actorId: renterId,
              action: 'WINDOWS_NATIVE_QUALIFICATION_REQUESTED',
              details: {
                qualification: 'stage3',
                gpuUuid: nativeGpuUuid,
              },
            },
          },
        },
        select: {
          id: true,
          status: true,
          preparationProgress: true,
          preparationStep: true,
        },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });

    return { session };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'windows_native_qualification_failed';

    if (
      message === 'funded_booking_required'
      || message.startsWith('windows_native_qualification_')
    ) {
      return { error: message };
    }

    throw error;
  }
}

async function createDesktopWorkspaceSession(
  db: PrismaClient,
  bookingId: string,
  renterId: string,
  slug: DesktopWorkspaceSlug,
) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, buyerId: renterId, status: { in: activeBookings } },
    include: { listing: { select: { machineId: true } } },
  });
  if (!booking) return { error: 'funded_booking_required' as const };

  let machineWorkspace;
  try {
    machineWorkspace = await ensureCompatibleMachineWorkspace(db, booking.listing.machineId, executableSlug(slug));
  } catch (error) {
    return { error: error instanceof Error ? error.message : `${slug}_workspace_incompatible` };
  }

  const existing = await db.workspaceSession.findFirst({
    where: { bookingId, renterId, machineWorkspaceId: machineWorkspace.id },
    select: { id: true, status: true, preparationProgress: true, preparationStep: true },
  });
  if (existing) return { session: existing };

  const spec = workspaceSpec[slug];
  try {
    const session = await db.$transaction(async (tx) => {
      // Same race boundary as the already-qualified renter routes: re-check the
      // commercial booking inside the transaction before creating a runtime.
      const eligible = await tx.booking.updateMany({
        where: { id: bookingId, buyerId: renterId, status: { in: activeBookings }, endsAt: { gt: new Date() } },
        data: { buyerId: renterId },
      });
      if (eligible.count !== 1) throw new Error('funded_booking_required');

      const created = await tx.workspaceSession.create({
        data: {
          bookingId,
          renterId,
          machineId: booking.listing.machineId,
          machineWorkspaceId: machineWorkspace.id,
          status: WorkspaceSessionStatus.PREPARING,
          isolationType: 'DOCKER',
          runtimeBackend: WorkspaceRuntimeBackend.CONTAINER,
          resourceLimits: {
            maxRamMiB: spec.maxRamMiB,
            maxCpuCores: spec.maxCpuCores,
            storageQuotaMiB: spec.storageQuotaMiB,
            networkAccess: 'RESTRICTED',
            autoStopMinutes: 60,
          },
          connectionType: 'GPUBNB_GATEWAY',
          preparationProgress: 5,
          preparationStep: spec.requestedStep,
          preparationRequestedAt: new Date(),
          readyDeadlineAt: new Date(Math.max(Date.now(), booking.startsAt.getTime() - 120_000)),
          expiresAt: booking.endsAt,
          events: {
            create: { actorType: 'RENTER', actorId: renterId, action: spec.requestedEvent },
          },
        },
      });

      const job = await tx.job.create({
        data: {
          bookingId,
          renterId,
          machineId: booking.listing.machineId,
          type: JobType.WORKSPACE_PREPARE,
          parameters: { workspaceSlug: slug, timeoutSeconds: spec.timeoutSeconds },
        },
      });

      return tx.workspaceSession.update({
        where: { id: created.id },
        data: { jobId: job.id, preparationAttempts: { increment: 1 } },
        select: { id: true, status: true, preparationProgress: true, preparationStep: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
    return { session };
  } catch (error) {
    const raced = await db.workspaceSession.findFirst({
      where: { bookingId, renterId, machineWorkspaceId: machineWorkspace.id },
      select: { id: true, status: true, preparationProgress: true, preparationStep: true },
    });
    if (raced) return { session: raced };
    if (error instanceof Error && error.message === 'funded_booking_required') return { error: error.message };
    throw error;
  }
}

export function registerDesktopWorkspaceRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  app.post('/qualification/windows-native/booking', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;

    const result = await createWindowsNativeQualificationBooking(db, session.userId);
    if ('error' in result) return reply.code(409).send({ error: result.error });

    return reply.code(result.created ? 201 : 200).send({
      bookingId: result.booking.id,
      status: result.booking.status,
      startsAt: result.booking.startsAt,
      endsAt: result.booking.endsAt,
      expectedSeconds: result.booking.expectedSeconds,
      created: result.created,
    });
  });

  for (const slug of desktopWorkspaceSlugs) {
    app.post(`/bookings/:bookingId/workspace/${slug}`, async (request, reply) => {
      const session = await requireSession(request, reply, redis);
      if (!session) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const qualification = String(
        (request.query as { qualification?: string }).qualification || '',
      );

      const result = slug === 'cloud-desktop' && qualification === 'windows-native'
        ? await createWindowsNativeQualificationSession(db, bookingId, session.userId)
        : await createDesktopWorkspaceSession(db, bookingId, session.userId, slug);

      if ('error' in result) return reply.code(409).send({ error: result.error });
      return result.session;
    });

    app.get(`/bookings/:bookingId/workspace/${slug}/status`, async (request, reply) => {
      const session = await requireSession(request, reply, redis);
      if (!session) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug } } },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          preparationProgress: true,
          preparationStep: true,
          preparationAttempts: true,
          preparationRequestedAt: true,
          preparationStartedAt: true,
          preparationCompletedAt: true,
          endedAt: true,
          updatedAt: true,
          connectionMetadata: true,
          gatewayLastSeenAt: true,
          job: { select: { status: true, errorCode: true, createdAt: true, updatedAt: true, finishedAt: true } },
          machine: { select: { gpuModel: true, vramMiB: true, connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
          booking: { select: { status: true, startsAt: true, endsAt: true } },
          machineWorkspace: { select: { workspace: { select: { slug: true, name: true } } } },
        },
      });
      if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });

      const policy = evaluateWorkspaceAccess({
        authenticatedUserId: session.userId,
        renterId: session.userId,
        bookingStatus: row.booking.status,
        sessionStatus: row.status,
        expiresAt: row.expiresAt,
        machineConnectivity: row.machine.connectivity,
        machineOperational: row.machine.operational,
        moderationStatus: row.machine.moderationStatus,
        lastHeartbeatAt: row.machine.lastHeartbeatAt,
        heartbeatMaxAgeSeconds: config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS,
      });
      const connection = safeConnection(row.connectionMetadata);
      const live = connection.ready && isWorkspaceGatewayLive(row.gatewayLastSeenAt);
      const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, live);
      const preparationStart = row.preparationStartedAt ?? row.preparationRequestedAt ?? row.job?.createdAt ?? row.updatedAt;
      const preparationEnd = row.preparationCompletedAt ?? row.endedAt ?? row.job?.finishedAt ?? new Date();

      return {
        sessionId: row.id,
        status: row.status,
        workspace: row.machineWorkspace.workspace,
        gpu: { model: row.machine.gpuModel, vramMiB: row.machine.vramMiB },
        startsAt: row.booking.startsAt,
        endsAt: row.booking.endsAt,
        expiresAt: row.expiresAt,
        preparation: {
          progress: row.preparationProgress,
          step: row.preparationStep,
          phase,
          attempts: row.preparationAttempts,
          elapsedSeconds: Math.max(0, Math.round((preparationEnd.getTime() - preparationStart.getTime()) / 1000)),
          updatedAt: row.job?.updatedAt ?? row.updatedAt,
          jobStatus: row.job?.status ?? null,
          errorCode: row.job?.errorCode ?? null,
        },
        canOpen: policy.allowed && live,
        blockedReason: !policy.allowed ? policy.code : !connection.ready ? 'GATEWAY_NOT_READY' : live ? null : 'GATEWAY_STALE',
      };
    });

    app.post(`/bookings/:bookingId/workspace/${slug}/access`, {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const session = await requireSession(request, reply, redis);
      if (!session) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug } } },
        select: {
          id: true,
          renterId: true,
          status: true,
          expiresAt: true,
          connectionMetadata: true,
          gatewayLastSeenAt: true,
          machine: { select: { connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
          booking: { select: { status: true } },
        },
      });
      if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });

      const policy = evaluateWorkspaceAccess({
        authenticatedUserId: session.userId,
        renterId: row.renterId,
        bookingStatus: row.booking.status,
        sessionStatus: row.status,
        expiresAt: row.expiresAt,
        machineConnectivity: row.machine.connectivity,
        machineOperational: row.machine.operational,
        moderationStatus: row.machine.moderationStatus,
        lastHeartbeatAt: row.machine.lastHeartbeatAt,
        heartbeatMaxAgeSeconds: config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS,
      });
      if (!policy.allowed) return reply.code(409).send({ error: policy.code.toLowerCase() });
      const connection = safeConnection(row.connectionMetadata);
      if (!connection.ready || !connection.gatewayPath || !isWorkspaceGatewayLive(row.gatewayLastSeenAt)) {
        return reply.code(409).send({ error: 'workspace_gateway_not_ready' });
      }
      const grant = await issueWorkspaceAccessGrant(redis, {
        userId: session.userId,
        bookingId,
        sessionId: row.id,
        requestId: request.id,
      });
      return { ...grant, openPath: `${connection.gatewayPath}?grant=${encodeURIComponent(grant.token)}` };
    });
  }
}
