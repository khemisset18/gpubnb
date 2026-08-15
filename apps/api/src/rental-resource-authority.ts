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

const LIVE_ALLOCATION_STATUSES: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

const LIVE_SESSION_STATUSES: WorkspaceSessionStatus[] = [
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
  resourceQuarantined: boolean;
  acceleratorModeration: ModerationStatus;
  acceleratorStatus: AcceleratorOperationalStatus;
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

function candidateFromAccelerator(accelerator: {
  hardwareUuid: string;
  vendor: string | null;
  moderationStatus: ModerationStatus;
  status: AcceleratorOperationalStatus;
  miningResource: { id: string; kind: 'CPU' | 'GPU'; quarantined: boolean } | null;
}): CandidateGpu | null {
  if (!accelerator.miningResource || accelerator.miningResource.kind !== 'GPU') return null;
  return {
    resourceId: accelerator.miningResource.id,
    hardwareUuid: accelerator.hardwareUuid,
    vendor: accelerator.vendor,
    resourceQuarantined: accelerator.miningResource.quarantined,
    acceleratorModeration: accelerator.moderationStatus,
    acceleratorStatus: accelerator.status,
  };
}

function validateCandidates(candidates: CandidateGpu[]): string | undefined {
  if (!candidates.length) return 'rental_gpu_resource_mapping_missing';
  for (const candidate of candidates) {
    if (candidate.vendor?.toUpperCase() !== 'NVIDIA') return 'rental_gpu_vendor_not_qualified';
    if (candidate.resourceQuarantined) return 'rental_gpu_resource_quarantined';
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
      machineWorkspace: { workspace: { slug: 'developer' } },
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
                  hardwareUuid: true,
                  vendor: true,
                  moderationStatus: true,
                  status: true,
                  miningResource: { select: { id: true, kind: true, quarantined: true } },
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
                      hardwareUuid: true,
                      vendor: true,
                      moderationStatus: true,
                      status: true,
                      miningResource: { select: { id: true, kind: true, quarantined: true } },
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
    let accelerators;
    if (session.booking.listing.resourceMode === ListingResourceMode.FULL_MACHINE) {
      const machineLive = session.booking.machineAllocation
        && LIVE_ALLOCATION_STATUSES.includes(session.booking.machineAllocation.status);
      accelerators = machineLive ? session.booking.listing.machine.accelerators : [];
    } else {
      accelerators = session.booking.acceleratorAllocations.map((row) => row.accelerator);
    }
    const candidates = accelerators
      .map(candidateFromAccelerator)
      .filter((value): value is CandidateGpu => value !== null)
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
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
