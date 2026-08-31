import crypto from 'node:crypto';
import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  ModerationStatus,
  ResourceAllocationStatus,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Redis } from 'ioredis';

import {
  RESOURCE_LEASE_DEFAULT_TTL_SECONDS,
  resourceFenceKey,
  resourceLeaseKey,
  redisHashTag,
  releaseResourceLease,
  type ResourceLeaseSnapshot,
} from './resource-lease.js';
import { gpuMiningResourceKey } from './mining-resource-inventory.js';

const LIVE_ALLOCATION_STATUSES: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

// PREPARING is included: ensureComputePreparation (rental-workflow-transactions.ts)
// creates the GPU_PROOF job directly, with no WORKSPACE_PREPARE job ahead of it - so a
// Compute session never reaches READY (only a completed WORKSPACE_PREPARE job does that,
// and this flow never runs one) before the GPU_PROOF job itself needs to resolve its
// leased GPU. The accelerator allocation this authority reads from is created at booking
// time (allocateBookingResources, independent of session/job status), so the resource is
// already genuinely leased while PREPARING - excluding it made every GPU_PROOF job fail
// closed with rental_resource_authority_missing_for_session before running anything
// (confirmed against production: cmt14q1ro... on cmsiggruy0004df0tn669f6bn).
const LIVE_SESSION_STATUSES: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
];

const RENTABLE_ACCELERATOR_STATUSES: AcceleratorOperationalStatus[] = [
  AcceleratorOperationalStatus.AVAILABLE,
  AcceleratorOperationalStatus.RESERVED,
  AcceleratorOperationalStatus.RUNNING,
];

const RENTAL_LEASE_TTL_SECONDS = RESOURCE_LEASE_DEFAULT_TTL_SECONDS;
const RENTAL_LEASE_TTL_MS = RENTAL_LEASE_TTL_SECONDS * 1000;

const PRIORITY_ACQUIRE_SCRIPT = `
local currentLeaseId = redis.call('HGET', KEYS[1], 'leaseId')
if currentLeaseId then
  local currentHolder = redis.call('HGET', KEYS[1], 'holderId') or ''
  local currentIdempotency = redis.call('HGET', KEYS[1], 'idempotencyKey') or ''
  local currentFence = redis.call('HGET', KEYS[1], 'fencingToken') or '0'
  if currentHolder == ARGV[1] and currentIdempotency == ARGV[2] then
    redis.call('PEXPIRE', KEYS[1], ARGV[4])
    return {2, currentLeaseId, currentFence, ARGV[4]}
  end
end
redis.call('INCR', KEYS[2])
local fencingToken = redis.call('GET', KEYS[2])
redis.call('HSET', KEYS[1],
  'holderId', ARGV[1],
  'idempotencyKey', ARGV[2],
  'leaseId', ARGV[3],
  'fencingToken', fencingToken)
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return {1, ARGV[3], fencingToken, ARGV[4]}
`;

export type RentalGpuResourceAuthority = {
  resourceId: string;
  hardwareUuid: string;
  vendor: 'NVIDIA';
  lease: ResourceLeaseSnapshot;
};

export type RentalSessionAuthority = {
  sessionId: string;
  status: WorkspaceSessionStatus;
  resources: RentalGpuResourceAuthority[];
  blockedReason?: string;
};

export type RentalResourceAuthority = {
  protocolVersion: 1;
  leaseTtlSeconds: number;
  sessions: RentalSessionAuthority[];
};

type CandidateGpu = {
  resourceId: string;
  hardwareUuid: string;
  vendor: string | null;
  resourceEnabled: boolean;
  resourceQuarantined: boolean;
  acceleratorModeration: ModerationStatus;
  acceleratorStatus: AcceleratorOperationalStatus;
};

type AcceleratorForRental = {
  id: string;
  hardwareUuid: string;
  model: string;
  vendor: string | null;
  moderationStatus: ModerationStatus;
  status: AcceleratorOperationalStatus;
  miningResource: {
    id: string;
    kind: 'CPU' | 'GPU';
    enabled: boolean;
    quarantined: boolean;
  } | null;
};

function decodePriorityLease(
  raw: unknown,
  resourceId: string,
  holderId: string,
  idempotencyKey: string,
): ResourceLeaseSnapshot {
  if (!Array.isArray(raw) || raw.length < 4) throw new Error('rental_resource_lease_result_invalid');
  const code = Number(raw[0]);
  if (code !== 1 && code !== 2) throw new Error('rental_resource_lease_result_invalid');
  const leaseId = String(raw[1] ?? '');
  const fencingToken = String(raw[2] ?? '');
  const ttlMs = Number(raw[3]);
  if (!/^lease_[A-Za-z0-9_-]{16,}$/.test(leaseId)) throw new Error('rental_resource_lease_id_invalid');
  if (!/^[1-9]\d{0,18}$/.test(fencingToken) || BigInt(fencingToken) > 9_223_372_036_854_775_807n) {
    throw new Error('rental_resource_fence_invalid');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > RENTAL_LEASE_TTL_MS) {
    throw new Error('rental_resource_lease_ttl_invalid');
  }
  return {
    protocolVersion: 1,
    resourceId,
    holderId,
    idempotencyKey,
    leaseId,
    fencingToken,
    ttlMs,
  };
}

async function acquireRentalLease(
  redis: Redis,
  sessionId: string,
  resourceId: string,
): Promise<ResourceLeaseSnapshot> {
  const holderId = `rental:${sessionId}`;
  const idempotencyKey = `rental:${sessionId}:${resourceId}`;
  const leaseId = `lease_${crypto.randomBytes(18).toString('base64url')}`;
  const leaseKey = resourceLeaseKey(resourceId);
  const fenceKey = resourceFenceKey(resourceId);
  if (redisHashTag(leaseKey) !== redisHashTag(fenceKey)) throw new Error('rental_resource_cross_slot_keys');
  const raw = await redis.eval(
    PRIORITY_ACQUIRE_SCRIPT,
    2,
    leaseKey,
    fenceKey,
    holderId,
    idempotencyKey,
    leaseId,
    String(RENTAL_LEASE_TTL_MS),
  );
  return decodePriorityLease(raw, resourceId, holderId, idempotencyKey);
}

async function ensureMiningResourceMapping(
  db: PrismaClient,
  machineId: string,
  accelerator: AcceleratorForRental,
): Promise<NonNullable<AcceleratorForRental['miningResource']>> {
  if (accelerator.miningResource) return accelerator.miningResource;

  const resourceKey = gpuMiningResourceKey(machineId, accelerator.hardwareUuid);
  const resource = await db.miningResource.upsert({
    where: { machineId_resourceKey: { machineId, resourceKey } },
    create: {
      id: crypto.randomUUID(),
      machineId,
      kind: 'GPU',
      resourceKey,
      displayName: accelerator.model,
      acceleratorId: accelerator.id,
      enabled: true,
      quarantined: false,
      lastSeenAt: new Date(),
    },
    update: {
      displayName: accelerator.model,
      lastSeenAt: new Date(),
    },
    select: {
      id: true,
      acceleratorId: true,
      kind: true,
      enabled: true,
      quarantined: true,
    },
  });

  if (resource.kind !== 'GPU') throw new Error('rental_gpu_resource_mapping_conflict');
  if (resource.acceleratorId && resource.acceleratorId !== accelerator.id) {
    throw new Error('rental_gpu_resource_mapping_conflict');
  }
  if (!resource.acceleratorId) {
    return db.miningResource.update({
      where: { id: resource.id },
      data: { acceleratorId: accelerator.id },
      select: {
        id: true,
        kind: true,
        enabled: true,
        quarantined: true,
      },
    });
  }

  return {
    id: resource.id,
    kind: resource.kind,
    enabled: resource.enabled,
    quarantined: resource.quarantined,
  };
}

function candidateFromAccelerator(
  accelerator: AcceleratorForRental,
  miningResource: NonNullable<AcceleratorForRental['miningResource']>,
): CandidateGpu | null {
  if (miningResource.kind !== 'GPU') return null;
  return {
    resourceId: miningResource.id,
    hardwareUuid: accelerator.hardwareUuid,
    vendor: accelerator.vendor,
    resourceEnabled: miningResource.enabled,
    resourceQuarantined: miningResource.quarantined,
    acceleratorModeration: accelerator.moderationStatus,
    acceleratorStatus: accelerator.status,
  };
}

function validateCandidates(candidates: CandidateGpu[]): string | undefined {
  if (!candidates.length) return 'rental_gpu_resource_mapping_missing';
  for (const candidate of candidates) {
    if (candidate.vendor?.toUpperCase() !== 'NVIDIA') return 'rental_gpu_vendor_not_qualified';
    if (candidate.resourceQuarantined) return 'rental_gpu_resource_quarantined';
    if (!candidate.resourceEnabled) return 'rental_gpu_resource_disabled';
    if (candidate.acceleratorModeration !== ModerationStatus.CLEAR) return 'rental_gpu_accelerator_not_clear';
    if (!RENTABLE_ACCELERATOR_STATUSES.includes(candidate.acceleratorStatus)) {
      return 'rental_gpu_accelerator_not_rentable';
    }
  }
  return undefined;
}

export async function buildRentalResourceAuthority(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
): Promise<RentalResourceAuthority> {
  const sessions = await db.workspaceSession.findMany({
    where: {
      machineId,
      status: { in: LIVE_SESSION_STATUSES },
      // Every executable workspace routes exclusivity/preemption through this
      // authority, even Data (which never attaches --gpus to its container -
      // see workspace_gateway.py's slug-conditional launch): every booking on
      // this marketplace still reserves a specific accelerator for its
      // duration, and only this authority tracks that lease/fencing state.
      // This used to be hardcoded to 'developer' only, which meant
      // `/agent/mining/:machineId/rental-authority` could never resolve a
      // Compute session and always answered
      // rental_resource_authority_missing_for_session for the one path renters
      // actually use.
      machineWorkspace: { workspace: { slug: { in: ['developer', 'compute', 'data', 'ai', 'video', 'audio'] } } },
    },
    select: {
      id: true,
      status: true,
      booking: {
        select: {
          machineAllocation: { select: { status: true } },
          acceleratorAllocations: {
            where: { status: { in: LIVE_ALLOCATION_STATUSES } },
            select: {
              accelerator: {
                select: {
                  id: true,
                  hardwareUuid: true,
                  model: true,
                  vendor: true,
                  moderationStatus: true,
                  status: true,
                  miningResource: { select: { id: true, kind: true, enabled: true, quarantined: true } },
                },
              },
            },
          },
          listing: {
            select: {
              resourceMode: true,
              machine: {
                select: {
                  accelerators: {
                    select: {
                      id: true,
                      hardwareUuid: true,
                      model: true,
                      vendor: true,
                      moderationStatus: true,
                      status: true,
                      miningResource: { select: { id: true, kind: true, enabled: true, quarantined: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  const prepared: Array<{ sessionId: string; status: WorkspaceSessionStatus; candidates: CandidateGpu[]; blockedReason?: string }> = [];
  const ownerByResource = new Map<string, string>();

  for (const session of sessions) {
    let accelerators: AcceleratorForRental[];
    if (session.booking.listing.resourceMode === ListingResourceMode.FULL_MACHINE) {
      const machineLive = session.booking.machineAllocation
        && LIVE_ALLOCATION_STATUSES.includes(session.booking.machineAllocation.status);
      accelerators = machineLive ? session.booking.listing.machine.accelerators : [];
    } else {
      accelerators = session.booking.acceleratorAllocations.map((row) => row.accelerator);
    }

    const candidates: CandidateGpu[] = [];
    for (const accelerator of accelerators) {
      const miningResource = await ensureMiningResourceMapping(db, machineId, accelerator);
      const candidate = candidateFromAccelerator(accelerator, miningResource);
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((left, right) => left.resourceId.localeCompare(right.resourceId));

    let blockedReason = validateCandidates(candidates);
    if (!blockedReason && new Set(candidates.map((candidate) => candidate.resourceId)).size !== candidates.length) {
      blockedReason = 'rental_gpu_resource_duplicate';
    }
    if (!blockedReason) {
      for (const candidate of candidates) {
        const previous = ownerByResource.get(candidate.resourceId);
        if (previous && previous !== session.id) {
          throw new Error('rental_gpu_resource_authority_conflict');
        }
        ownerByResource.set(candidate.resourceId, session.id);
      }
    }
    prepared.push({ sessionId: session.id, status: session.status, candidates, ...(blockedReason ? { blockedReason } : {}) });
  }

  const authoritySessions: RentalSessionAuthority[] = [];
  for (const session of prepared) {
    if (session.blockedReason) {
      authoritySessions.push({
        sessionId: session.sessionId,
        status: session.status,
        resources: [],
        blockedReason: session.blockedReason,
      });
      continue;
    }
    const resources: RentalGpuResourceAuthority[] = [];
    for (const candidate of session.candidates) {
      const lease = await acquireRentalLease(redis, session.sessionId, candidate.resourceId);
      resources.push({
        resourceId: candidate.resourceId,
        hardwareUuid: candidate.hardwareUuid,
        vendor: 'NVIDIA',
        lease,
      });
    }
    authoritySessions.push({ sessionId: session.sessionId, status: session.status, resources });
  }

  return {
    protocolVersion: 1,
    leaseTtlSeconds: RENTAL_LEASE_TTL_SECONDS,
    sessions: authoritySessions,
  };
}

export async function releaseRentalResourceAuthority(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  sessionId: string,
  leases: Array<{ resourceId: string; holderId: string; leaseId: string; fencingToken: string }>,
  now = new Date(),
): Promise<{ released: number }> {
  const session = await db.workspaceSession.findFirst({
    where: { id: sessionId, machineId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!session) throw new Error('rental_session_not_found');
  const stoppable = session.status === WorkspaceSessionStatus.STOP_REQUESTED
    || session.status === WorkspaceSessionStatus.STOPPING
    || session.expiresAt <= now;
  if (!stoppable) throw new Error('rental_session_not_releasable');

  let released = 0;
  for (const lease of leases) {
    if (lease.holderId !== `rental:${sessionId}`) throw new Error('rental_resource_holder_mismatch');
    const result = await releaseResourceLease(redis, lease);
    if (result.accepted || result.reason === 'MISSING') released += 1;
    else throw new Error('rental_resource_lease_stale');
  }
  return { released };
}
