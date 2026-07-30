import { AcceleratorOperationalStatus, BookingStatus, ListingStatus, MachineConnectivity, MachineOperational, ModerationStatus, ResourceAllocationStatus } from '@prisma/client';

export type MachineRentalState =
  | 'NOT_LINKED'
  | 'WAITING_FOR_FIRST_HEARTBEAT'
  | 'OFFLINE'
  | 'ONLINE'
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
  | 'SESSION_COMPLETING'
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
  accelerators: Array<{
    status: AcceleratorOperationalStatus;
    moderationStatus: ModerationStatus;
    verifiedAt?: Date | null;
    driverVersion?: string | null;
    cudaVersion?: string | null;
    lastSeenAt?: Date | null;
  }>;
  listings: Array<{ status: ListingStatus }>;
  bookings: Array<{ status: BookingStatus }>;
  allocations: Array<{ status: ResourceAllocationStatus; releasedAt?: Date | null }>;
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

const activeBookingStatuses = new Set<BookingStatus>([
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
]);

const activeAllocationStatuses = new Set<ResourceAllocationStatus>([
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
  const hasGpu = input.accelerators.some((gpu) => gpu.status !== AcceleratorOperationalStatus.MISSING);
  const verifiedGpu = input.accelerators.some((gpu) => gpu.verifiedAt && gpu.moderationStatus === ModerationStatus.CLEAR);
  const activeListing = input.listings.some((listing) => listing.status === ListingStatus.ACTIVE);
  const activeBooking = input.bookings.some((booking) => activeBookingStatuses.has(booking.status));
  const activeAllocation = input.allocations.some((allocation) => activeAllocationStatuses.has(allocation.status) && !allocation.releasedAt);

  let state: MachineRentalState;
  let nextAction: string;
  let blockingReason: string | null = null;

  if (!input.agentPublicKey) {
    state = 'NOT_LINKED'; nextAction = 'LINK_HOST'; blockingReason = 'NO_AGENT_PUBLIC_KEY';
  } else if (input.moderationStatus === ModerationStatus.QUARANTINED || input.accelerators.some((gpu) => gpu.moderationStatus === ModerationStatus.QUARANTINED)) {
    state = 'QUARANTINED'; nextAction = 'CONTACT_SUPPORT_OR_RUN_RECOVERY'; blockingReason = 'RESOURCE_QUARANTINED';
  } else if (!input.lastHeartbeatAt) {
    state = 'WAITING_FOR_FIRST_HEARTBEAT'; nextAction = 'START_HOST_AND_WAIT_FOR_HEARTBEAT'; blockingReason = 'NO_HEARTBEAT_RECEIVED';
  } else if (input.connectivity !== MachineConnectivity.ONLINE || !input.heartbeatFresh) {
    state = 'OFFLINE'; nextAction = 'RESTART_HOST_OR_CHECK_NETWORK'; blockingReason = 'HEARTBEAT_STALE_OR_OFFLINE';
  } else if (!hasGpu) {
    state = 'GPU_NOT_DETECTED'; nextAction = 'INSTALL_DRIVER_OR_CHECK_GPU'; blockingReason = 'NO_GPU_INVENTORY';
  } else if (input.accelerators.every((gpu) => !gpu.driverVersion)) {
    state = 'DRIVER_MISSING'; nextAction = 'INSTALL_NVIDIA_DRIVER'; blockingReason = 'GPU_DRIVER_MISSING';
  } else if (!input.dockerAvailable) {
    state = 'DOCKER_UNAVAILABLE'; nextAction = 'INSTALL_AND_START_DOCKER'; blockingReason = 'DOCKER_UNAVAILABLE';
  } else if (!input.nvidiaRuntimeAvailable) {
    state = 'NVIDIA_RUNTIME_UNAVAILABLE'; nextAction = 'INSTALL_NVIDIA_CONTAINER_TOOLKIT'; blockingReason = 'NVIDIA_RUNTIME_UNAVAILABLE';
  } else if (input.operational === MachineOperational.VERIFYING) {
    state = 'DIAGNOSTIC_RUNNING'; nextAction = 'WAIT_FOR_DIAGNOSTIC';
  } else if (input.operational === MachineOperational.DEGRADED) {
    state = 'DIAGNOSTIC_FAILED'; nextAction = 'RE_RUN_DIAGNOSTIC_AFTER_FIXING_ERRORS'; blockingReason = 'DIAGNOSTIC_FAILED';
  } else if (!input.lastCudaProbeOk || !verifiedGpu) {
    state = 'DIAGNOSTIC_REQUIRED'; nextAction = 'RUN_GPU_DIAGNOSTIC'; blockingReason = 'GPU_DIAGNOSTIC_REQUIRED';
  } else if (!input.verifiedAt) {
    state = 'VERIFICATION_REQUIRED'; nextAction = 'COMPLETE_HOST_VERIFICATION'; blockingReason = 'HOST_NOT_VERIFIED';
  } else if (activeAllocation && input.bookings.some((booking) => booking.status === BookingStatus.ACTIVE)) {
    state = 'SESSION_ACTIVE'; nextAction = 'MONITOR_SESSION';
  } else if (activeAllocation && input.bookings.some((booking) => booking.status === BookingStatus.STARTING)) {
    state = 'SESSION_STARTING'; nextAction = 'WAIT_FOR_SESSION_START';
  } else if (activeAllocation && activeBooking) {
    state = 'RESERVED'; nextAction = 'WAIT_FOR_SESSION_WINDOW';
  } else if (input.operational === MachineOperational.MAINTENANCE) {
    state = 'CLEANUP_REQUIRED'; nextAction = 'VERIFY_CLEANUP_BEFORE_REUSE'; blockingReason = 'CLEANUP_NOT_VERIFIED';
  } else if (activeListing) {
    state = 'LISTING_ACTIVE'; nextAction = 'WAIT_FOR_BOOKING';
  } else {
    state = 'READY_TO_PUBLISH'; nextAction = 'PUBLISH_LISTING';
  }

  const ready = state === 'READY_TO_PUBLISH' || state === 'LISTING_ACTIVE';
  return {
    state,
    nextAction,
    blockingReason,
    lastEvidenceAt,
    canPublish: state === 'READY_TO_PUBLISH',
    canAcceptBooking: ready && !activeAllocation,
    canStartSession: state === 'RESERVED',
  };
}
