import {
  ListingResourceMode,
  ListingStatus,
  ModerationStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { computeMachineState, type MachineStateView } from './machine-state-service.js';
import { requirePublishableRentalGpu } from './rental-gpu-catalog.js';

export type RentalListingErrorCode =
  | 'machine_not_found'
  | 'machine_not_publishable'
  | 'accelerator_not_found'
  | 'accelerator_not_publishable'
  | 'invalid_price'
  | 'listing_conflict';

export class RentalListingError extends Error {
  constructor(
    public readonly code: RentalListingErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'RentalListingError';
  }
}

export type CreateExactGpuListingInput = {
  ownerId: string;
  machineId: string;
  acceleratorId: string;
  title: string;
  description: string;
  hourlySol: number;
  now: Date;
  heartbeatStaleAfterSeconds: number;
};

const machineStateSelect = {
  id: true,
  agentPublicKey: true,
  connectivity: true,
  operational: true,
  moderationStatus: true,
  lastHeartbeatAt: true,
  lastCudaProbeOk: true,
  dockerAvailable: true,
  nvidiaRuntimeAvailable: true,
  verifiedAt: true,
  accelerators: {
    select: {
      status: true,
      moderationStatus: true,
      verifiedAt: true,
      driverVersion: true,
      lastSeenAt: true,
    },
  },
  listings: { select: { status: true } },
  machineAllocations: {
    where: { releasedAt: null },
    select: {
      status: true,
      releasedAt: true,
      booking: { select: { status: true } },
    },
  },
} satisfies Prisma.MachineSelect;

type MachineStateRow = Prisma.MachineGetPayload<{ select: typeof machineStateSelect }>;

function projectMachineState(
  machine: MachineStateRow,
  now: Date,
  heartbeatStaleAfterSeconds: number,
): MachineStateView {
  const heartbeatFresh = Boolean(
    machine.lastHeartbeatAt &&
      machine.lastHeartbeatAt.getTime() >= now.getTime() - heartbeatStaleAfterSeconds * 1000,
  );
  return computeMachineState({
    agentPublicKey: machine.agentPublicKey,
    connectivity: machine.connectivity,
    operational: machine.operational,
    moderationStatus: machine.moderationStatus,
    lastHeartbeatAt: machine.lastHeartbeatAt,
    lastCudaProbeOk: machine.lastCudaProbeOk,
    dockerAvailable: machine.dockerAvailable,
    nvidiaRuntimeAvailable: machine.nvidiaRuntimeAvailable,
    verifiedAt: machine.verifiedAt,
    heartbeatFresh,
    accelerators: machine.accelerators,
    listings: machine.listings,
    machineAllocations: machine.machineAllocations.map((allocation) => ({
      status: allocation.status,
      releasedAt: allocation.releasedAt,
      bookingStatus: allocation.booking.status,
    })),
  });
}

export async function listOwnerRentalMachines(
  db: PrismaClient,
  ownerId: string,
  now: Date,
  heartbeatStaleAfterSeconds: number,
) {
  const rows = await db.machine.findMany({
    where: { ownerId },
    select: {
      ...machineStateSelect,
      agentVersion: true,
      operatingSystem: true,
      osVersion: true,
      gpuModel: true,
      vramMiB: true,
      driverVersion: true,
      cudaVersion: true,
    },
    orderBy: { lastHeartbeatAt: 'desc' },
  });

  return rows.map((machine) => ({
    id: machine.id,
    agentVersion: machine.agentVersion,
    operatingSystem: machine.operatingSystem,
    osVersion: machine.osVersion,
    connectivity: machine.connectivity,
    operational: machine.operational,
    moderationStatus: machine.moderationStatus,
    lastHeartbeatAt: machine.lastHeartbeatAt,
    gpuModel: machine.gpuModel,
    vramMiB: machine.vramMiB,
    driverVersion: machine.driverVersion,
    cudaVersion: machine.cudaVersion,
    lastCudaProbeOk: machine.lastCudaProbeOk,
    verifiedAt: machine.verifiedAt,
    state: projectMachineState(machine, now, heartbeatStaleAfterSeconds),
  }));
}

function transactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034');
}

export async function createExactGpuListing(
  db: PrismaClient,
  input: CreateExactGpuListingInput,
) {
  const hourlyLamports = BigInt(Math.round(input.hourlySol * 1_000_000_000));
  if (hourlyLamports < 1n) throw new RentalListingError('invalid_price');

  try {
    return await db.$transaction(async (tx) => {
      // Machine-scoped locking intentionally serializes listing publication with
      // resource allocation, which uses the same advisory-lock key. This prevents
      // publish/booking races and duplicate listing creation across GPUs on one host.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.machineId}, 0))`;

      const machine = await tx.machine.findFirst({
        where: {
          id: input.machineId,
          ownerId: input.ownerId,
          moderationStatus: ModerationStatus.CLEAR,
        },
        select: machineStateSelect,
      });
      if (!machine) throw new RentalListingError('machine_not_found');

      const state = projectMachineState(machine, input.now, input.heartbeatStaleAfterSeconds);
      if (!state.canPublish) {
        throw new RentalListingError('machine_not_publishable', {
          state: state.state,
          blockingReason: state.blockingReason,
        });
      }

      const selected = await requirePublishableRentalGpu(
        tx,
        input.machineId,
        input.ownerId,
        input.acceleratorId,
        input.now,
        input.heartbeatStaleAfterSeconds,
      );
      if (selected.kind === 'machine_not_found') throw new RentalListingError('machine_not_found');
      if (selected.kind === 'accelerator_not_found') throw new RentalListingError('accelerator_not_found');
      if (selected.kind === 'accelerator_not_publishable') {
        throw new RentalListingError('accelerator_not_publishable', {
          blockingReason: selected.gpu.blockingReason,
        });
      }

      const listing = await tx.gpuListing.create({
        data: {
          ownerId: input.ownerId,
          machineId: input.machineId,
          title: input.title,
          description: input.description,
          hourlyLamports,
          status: ListingStatus.ACTIVE,
          resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
          // SELECTED_ACCELERATORS cardinality is represented by ListingAccelerator
          // rows. The DB reserves minimum/maximumAccelerators for COMPUTE_POOL only.
          accelerators: { create: { acceleratorId: input.acceleratorId } },
        },
        select: {
          id: true,
          status: true,
          resourceMode: true,
          hourlyLamports: true,
          accelerators: {
            select: {
              accelerator: {
                select: {
                  id: true,
                  hardwareUuid: true,
                  vendor: true,
                  model: true,
                  vramMiB: true,
                  verifiedAt: true,
                },
              },
            },
          },
        },
      });

      return {
        ...listing,
        hourlyLamports: listing.hourlyLamports.toString(),
        accelerator: listing.accelerators[0]?.accelerator ?? null,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error) {
    if (error instanceof RentalListingError) throw error;
    if (transactionConflict(error)) throw new RentalListingError('listing_conflict');
    throw error;
  }
}
