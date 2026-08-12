import {
  BookingStatus,
  MachineOperational,
  WorkspaceSessionStatus,
} from '@prisma/client';

const RUNNING_SESSION_STATUSES = new Set<WorkspaceSessionStatus>([
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
]);

const RESERVED_SESSION_STATUSES = new Set<WorkspaceSessionStatus>([
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
]);

/**
 * Heartbeats are proof of connectivity, not authority to release a machine.
 * Operational state is therefore derived from server-owned runtime state first.
 * This prevents a heartbeat with no session id from making a machine AVAILABLE
 * while a booking/job/workspace is still active.
 */
export function deriveHeartbeatOperational(input: {
  bookingStatus: BookingStatus | null;
  workspaceStatus: WorkspaceSessionStatus | null;
  hasActiveJob: boolean;
  jobProtocolSupported: boolean;
}): MachineOperational {
  if (input.bookingStatus === BookingStatus.DEGRADED) {
    return MachineOperational.DEGRADED;
  }

  if (
    input.bookingStatus === BookingStatus.ACTIVE ||
    (input.workspaceStatus !== null && RUNNING_SESSION_STATUSES.has(input.workspaceStatus))
  ) {
    return MachineOperational.RUNNING;
  }

  if (
    input.bookingStatus === BookingStatus.FUNDED ||
    input.bookingStatus === BookingStatus.STARTING ||
    input.hasActiveJob ||
    (input.workspaceStatus !== null && RESERVED_SESSION_STATUSES.has(input.workspaceStatus))
  ) {
    return MachineOperational.RESERVED;
  }

  return input.jobProtocolSupported
    ? MachineOperational.AVAILABLE
    : MachineOperational.UNAVAILABLE;
}
