import {
  ListingStatus,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';

// These statuses mean the owner still intends this machine to be available to
// GPUbnb. HIDDEN_OFFLINE is included deliberately: it is an automatic safety
// state after missed heartbeats, not an owner pause. Once the Agent reconnects,
// healthy listings can be reactivated to ACTIVE, so the Host should not be
// allowed to fall straight back into system sleep during that recovery window.
export const KEEP_AWAKE_LISTING_STATUSES: ListingStatus[] = [
  ListingStatus.PENDING_GPU_VERIFICATION,
  ListingStatus.ACTIVE,
  ListingStatus.RESERVED,
  ListingStatus.HIDDEN_OFFLINE,
];

// RESERVED is included here even though rental GPU authority itself begins at
// PREPARING: power availability must cover the whole hand-off from reservation
// through cleanup so the machine cannot sleep between marketplace admission and
// the first workspace preparation job.
export const KEEP_AWAKE_SESSION_STATUSES: WorkspaceSessionStatus[] = [
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
];

export type HostPowerPolicyReason =
  | 'live_session'
  | 'marketplace_available'
  | 'not_available';

export type HostPowerPolicy = {
  protocolVersion: 1;
  keepAwake: boolean;
  reason: HostPowerPolicyReason;
  liveSessionCount: number;
  availabilityListingCount: number;
};

export function deriveHostPowerPolicy(
  liveSessionCount: number,
  availabilityListingCount: number,
): HostPowerPolicy {
  const sessions = Math.max(0, Math.trunc(liveSessionCount));
  const listings = Math.max(0, Math.trunc(availabilityListingCount));
  if (sessions > 0) {
    return {
      protocolVersion: 1,
      keepAwake: true,
      reason: 'live_session',
      liveSessionCount: sessions,
      availabilityListingCount: listings,
    };
  }
  if (listings > 0) {
    return {
      protocolVersion: 1,
      keepAwake: true,
      reason: 'marketplace_available',
      liveSessionCount: sessions,
      availabilityListingCount: listings,
    };
  }
  return {
    protocolVersion: 1,
    keepAwake: false,
    reason: 'not_available',
    liveSessionCount: sessions,
    availabilityListingCount: listings,
  };
}

export async function buildHostPowerPolicy(
  db: PrismaClient,
  machineId: string,
): Promise<HostPowerPolicy> {
  const [liveSessionCount, availabilityListingCount] = await Promise.all([
    db.workspaceSession.count({
      where: {
        machineId,
        status: { in: KEEP_AWAKE_SESSION_STATUSES },
      },
    }),
    db.gpuListing.count({
      where: {
        machineId,
        status: { in: KEEP_AWAKE_LISTING_STATUSES },
      },
    }),
  ]);
  return deriveHostPowerPolicy(liveSessionCount, availabilityListingCount);
}
