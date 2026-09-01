import {
  AcceleratorOperationalStatus,
  BookingStatus,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  ResourceAllocationStatus,
} from '@prisma/client';

export type MachineRentalState =
  | 'NOT_LINKED'
  | 'WAITING_FOR_FIRST_HEARTBEAT'
  | 'OFFLINE'
  | 'AGENT_OUTDATED'
  | 'GPU_NOT_DETECTED'
  | 'DRIVER_MISSING'
  | 'DOCKER_UNAVAILABLE'
  | 'NVIDIA_RUNTIME_UNAVAILABLE'
  | 'DIAGNOSTIC_REQUIRED'
  | 'DIAGNOSTIC_RUNNING'
  | 'DIAGNOSTIC_FAILED'
  | 'VERIFICATION_REQUIRED'
  | 'READY_TO_PUBLISH'
  | 'LISTING_ACTIVE'
  | 'RESERVED'
  | 'SESSION_STARTING'
  | 'SESSION_ACTIVE'
  | 'CLEANUP_REQUIRED'
  | 'QUARANTINED';

export type MachineStateInput = {
  agentPublicKey?: string | null;
  connectivity: MachineConnectivity;
  operational: MachineOperational;
  moderationStatus: ModerationStatus;
  lastHeartbeatAt?: Date | null;
  lastCudaProbeOk: boolean;
  dockerAvailable: boolean;
  nvidiaRuntimeAvailable: boolean;
  verifiedAt?: Date | null;
  heartbeatFresh: boolean;
  /** Machine.quarantineReasonCode - the real, stable cause when moderationStatus
   * is QUARANTINED. Falls back to the generic RESOURCE_QUARANTINED blockingReason
   * below when absent (e.g. a machine quarantined before this field existed). */
  quarantineReasonCode?: string | null;
  /** Whether this machine's currently-reported agentVersion satisfies the
   * minimum protocol version (see job-execution-lease.ts's
   * supportsJobLeaseProtocol) - callers pass the already-computed boolean so
   * this module never has to know about job-lease version parsing. A
   * protocol-incompatible agent cannot actually execute a job even though
   * heartbeats/GPU/Docker checks may all otherwise look healthy. */
  jobProtocolSupported: boolean;
  accelerators: Array<{
    status: AcceleratorOperationalStatus;
    moderationStatus: ModerationStatus;
    verifiedAt?: Date | null;
    driverVersion?: string | null;
    lastSeenAt?: Date | null;
  }>;
  listings: Array<{ status: ListingStatus }>;
  machineAllocations: Array<{
    status: ResourceAllocationStatus;
    releasedAt?: Date | null;
    bookingStatus: BookingStatus;
  }>;
};

export type MachineStateView = {
  state: MachineRentalState;
  nextAction: string;
  blockingReason: string | null;
  lastEvidenceAt: Date | null;
  canPublish: boolean;
  canAcceptBooking: boolean;
  canStartSession: boolean;
};

const liveBookingStatuses = new Set<BookingStatus>([
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
]);

const liveAllocationStatuses = new Set<ResourceAllocationStatus>([
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
]);

function latestDate(values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    if (!latest || value > latest) return value;
    return latest;
  }, null);
}

export function computeMachineState(input: MachineStateInput): MachineStateView {
  const lastEvidenceAt = latestDate([
    input.lastHeartbeatAt,
    input.verifiedAt,
    ...input.accelerators.flatMap((gpu) => [gpu.lastSeenAt, gpu.verifiedAt]),
  ]);
  const presentAccelerators = input.accelerators.filter(
    (gpu) => gpu.status !== AcceleratorOperationalStatus.MISSING,
  );
  const hasGpu = presentAccelerators.length > 0;
  const hasDriver = presentAccelerators.some((gpu) => Boolean(gpu.driverVersion));
  const hasVerifiedGpu = presentAccelerators.some(
    (gpu) => gpu.verifiedAt && gpu.moderationStatus === ModerationStatus.CLEAR,
  );
  const activeListing = input.listings.some((listing) => listing.status === ListingStatus.ACTIVE);
  const liveMachineAllocation = input.machineAllocations.find(
    (allocation) =>
      liveAllocationStatuses.has(allocation.status) &&
      !allocation.releasedAt &&
      liveBookingStatuses.has(allocation.bookingStatus),
  );

  let state: MachineRentalState;
  let nextAction: string;
  let blockingReason: string | null = null;

  if (!input.agentPublicKey) {
    state = 'NOT_LINKED';
    nextAction = 'LINK_HOST';
    blockingReason = 'NO_AGENT_PUBLIC_KEY';
  } else if (
    input.moderationStatus !== ModerationStatus.CLEAR ||
    presentAccelerators.some((gpu) => gpu.moderationStatus === ModerationStatus.QUARANTINED)
  ) {
    state = 'QUARANTINED';
    nextAction = 'RUN_QUARANTINE_DIAGNOSTIC';
    blockingReason = input.moderationStatus !== ModerationStatus.CLEAR
      ? (input.quarantineReasonCode ?? 'UNKNOWN')
      : 'RESOURCE_QUARANTINED';
  } else if (!input.lastHeartbeatAt) {
    state = 'WAITING_FOR_FIRST_HEARTBEAT';
    nextAction = 'START_HOST_AND_WAIT_FOR_HEARTBEAT';
    blockingReason = 'NO_HEARTBEAT_RECEIVED';
  } else if (input.connectivity !== MachineConnectivity.ONLINE || !input.heartbeatFresh) {
    state = 'OFFLINE';
    nextAction = 'RESTART_HOST_OR_CHECK_NETWORK';
    blockingReason = 'HEARTBEAT_STALE_OR_OFFLINE';
  } else if (!input.jobProtocolSupported) {
    state = 'AGENT_OUTDATED';
    nextAction = 'UPDATE_AGENT';
    blockingReason = 'AGENT_PROTOCOL_VERSION_TOO_OLD';
  } else if (!hasGpu) {
    state = 'GPU_NOT_DETECTED';
    nextAction = 'INSTALL_DRIVER_OR_CHECK_GPU';
    blockingReason = 'NO_GPU_INVENTORY';
  } else if (!hasDriver) {
    state = 'DRIVER_MISSING';
    nextAction = 'INSTALL_NVIDIA_DRIVER';
    blockingReason = 'GPU_DRIVER_MISSING';
  } else if (!input.dockerAvailable) {
    state = 'DOCKER_UNAVAILABLE';
    nextAction = 'INSTALL_AND_START_DOCKER';
    blockingReason = 'DOCKER_UNAVAILABLE';
  } else if (!input.nvidiaRuntimeAvailable) {
    state = 'NVIDIA_RUNTIME_UNAVAILABLE';
    nextAction = 'INSTALL_NVIDIA_CONTAINER_TOOLKIT';
    blockingReason = 'NVIDIA_RUNTIME_UNAVAILABLE';
  } else if (input.operational === MachineOperational.VERIFYING) {
    state = 'DIAGNOSTIC_RUNNING';
    nextAction = 'WAIT_FOR_DIAGNOSTIC';
  } else if (input.operational === MachineOperational.DEGRADED) {
    state = 'DIAGNOSTIC_FAILED';
    nextAction = 'RE_RUN_DIAGNOSTIC_AFTER_FIXING_ERRORS';
    blockingReason = 'DIAGNOSTIC_FAILED';
  } else if (!input.lastCudaProbeOk || !hasVerifiedGpu) {
    state = 'DIAGNOSTIC_REQUIRED';
    nextAction = 'RUN_GPU_DIAGNOSTIC';
    blockingReason = 'GPU_DIAGNOSTIC_REQUIRED';
  } else if (!input.verifiedAt) {
    state = 'VERIFICATION_REQUIRED';
    nextAction = 'COMPLETE_HOST_VERIFICATION';
    blockingReason = 'HOST_NOT_VERIFIED';
  } else if (liveMachineAllocation?.bookingStatus === BookingStatus.ACTIVE) {
    state = 'SESSION_ACTIVE';
    nextAction = 'MONITOR_SESSION';
  } else if (liveMachineAllocation?.bookingStatus === BookingStatus.STARTING) {
    state = 'SESSION_STARTING';
    nextAction = 'WAIT_FOR_SESSION_START';
  } else if (liveMachineAllocation) {
    state = 'RESERVED';
    nextAction = 'WAIT_FOR_SESSION_WINDOW';
  } else if (input.operational === MachineOperational.MAINTENANCE) {
    state = 'CLEANUP_REQUIRED';
    nextAction = 'VERIFY_CLEANUP_BEFORE_REUSE';
    blockingReason = 'CLEANUP_NOT_VERIFIED';
  } else if (activeListing) {
    state = 'LISTING_ACTIVE';
    nextAction = 'MANAGE_LISTINGS';
  } else {
    state = 'READY_TO_PUBLISH';
    nextAction = 'SELECT_GPU_AND_PUBLISH';
  }

  const hostHealthy = state === 'READY_TO_PUBLISH' || state === 'LISTING_ACTIVE';
  return {
    state,
    nextAction,
    blockingReason,
    lastEvidenceAt,
    // Machine readiness is intentionally independent from per-GPU availability.
    // A multi-GPU host may publish another verified free accelerator while a
    // different accelerator already has an active listing.
    canPublish: hostHealthy,
    canAcceptBooking: hostHealthy,
    canStartSession: state === 'RESERVED',
  };
}
