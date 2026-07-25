import { BookingStatus, ResourceAllocationStatus } from '@prisma/client';

export type AllocationLifecycleAction =
  | { kind: 'none' }
  | { kind: 'transition'; target: ResourceAllocationStatus };

const BOOKING_TO_ALLOCATION: Readonly<Partial<Record<BookingStatus, ResourceAllocationStatus>>> = {
  [BookingStatus.AWAITING_DEPOSIT]: ResourceAllocationStatus.HELD,
  [BookingStatus.FUNDED]: ResourceAllocationStatus.CONFIRMED,
  [BookingStatus.STARTING]: ResourceAllocationStatus.CONFIRMED,
  [BookingStatus.ACTIVE]: ResourceAllocationStatus.ACTIVE,
  [BookingStatus.DEGRADED]: ResourceAllocationStatus.ACTIVE,
  [BookingStatus.COMPLETED]: ResourceAllocationStatus.RELEASED,
  [BookingStatus.SETTLED]: ResourceAllocationStatus.RELEASED,
  [BookingStatus.REFUNDED]: ResourceAllocationStatus.RELEASED,
  [BookingStatus.CANCELLED]: ResourceAllocationStatus.CANCELLED,
};

const TERMINAL_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  BookingStatus.COMPLETED,
  BookingStatus.SETTLED,
  BookingStatus.REFUNDED,
  BookingStatus.CANCELLED,
]);

const RESOURCE_LOCKING_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  BookingStatus.AWAITING_DEPOSIT,
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
  BookingStatus.DEGRADED,
]);

/**
 * Single source of truth for synchronizing booking state with physical resource locks.
 * CREATED deliberately performs no transition: resource allocation is created explicitly
 * during booking acceptance, after validation and before the payment window is exposed.
 */
export function allocationActionForBookingStatus(status: BookingStatus): AllocationLifecycleAction {
  const target = BOOKING_TO_ALLOCATION[status];
  return target ? { kind: 'transition', target } : { kind: 'none' };
}

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.has(status);
}

export function bookingStatusKeepsResourcesLocked(status: BookingStatus): boolean {
  return RESOURCE_LOCKING_BOOKING_STATUSES.has(status);
}
