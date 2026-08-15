import type { ResourceLeaseSnapshot } from './resource-lease.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,191}$/;
const SAFE_GPU_UUID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/;

export type MiningPerformanceMode = 'ECO' | 'BALANCED' | 'FULL';

export type MiningResourceStartInput = {
  machineId: string;
  resourceId: string;
  hardwareUuid: string;
  profileId: string;
  poolUrl: string;
  walletAddress: string;
  workerName: string;
  performanceMode: MiningPerformanceMode;
};

export type FencedMiningCommand = {
  lease: {
    resourceId: string;
    holderId: string;
    leaseId: string;
    fencingToken: string;
  };
  payload: Record<string, unknown>;
};

function validateIdentity(value: string, field: string, pattern = SAFE_ID): void {
  if (!pattern.test(value)) throw new Error(`${field}_invalid`);
}

function exactFence(lease: ResourceLeaseSnapshot, resourceId: string): string {
  if (lease.resourceId !== resourceId) throw new Error('mining_resource_lease_mismatch');
  if (!/^[1-9]\d{0,18}$/.test(lease.fencingToken)) throw new Error('mining_resource_fence_invalid');
  // Never coerce to Number: i64 fencing tokens can exceed JS safe integer range.
  return lease.fencingToken;
}

function leaseBinding(lease: ResourceLeaseSnapshot): FencedMiningCommand['lease'] {
  return {
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

export function buildFencedStartMining(
  input: MiningResourceStartInput,
  lease: ResourceLeaseSnapshot,
): FencedMiningCommand {
  validateIdentity(input.machineId, 'machine_id');
  validateIdentity(input.resourceId, 'resource_id');
  validateIdentity(input.hardwareUuid, 'hardware_uuid', SAFE_GPU_UUID);
  validateIdentity(input.profileId, 'profile_id');
  validateIdentity(input.workerName, 'worker_name');
  const generation = exactFence(lease, input.resourceId);
  return {
    lease: leaseBinding(lease),
    payload: {
      resourceId: input.resourceId,
      hardwareUuid: input.hardwareUuid,
      runtimeGeneration: generation,
      profileId: input.profileId,
      poolUrl: input.poolUrl,
      walletAddress: input.walletAddress,
      workerName: input.workerName,
      performanceMode: input.performanceMode,
    },
  };
}

export function buildFencedStopMining(
  input: Pick<MiningResourceStartInput, 'machineId' | 'resourceId' | 'hardwareUuid'>,
  lease: ResourceLeaseSnapshot,
): FencedMiningCommand {
  validateIdentity(input.machineId, 'machine_id');
  validateIdentity(input.resourceId, 'resource_id');
  validateIdentity(input.hardwareUuid, 'hardware_uuid', SAFE_GPU_UUID);
  const generation = exactFence(lease, input.resourceId);
  return {
    lease: leaseBinding(lease),
    payload: {
      resourceId: input.resourceId,
      hardwareUuid: input.hardwareUuid,
      runtimeGeneration: generation,
    },
  };
}
