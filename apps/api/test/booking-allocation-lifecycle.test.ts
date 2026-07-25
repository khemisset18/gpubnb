import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingStatus, ResourceAllocationStatus } from '@prisma/client';
import {
  allocationActionForBookingStatus,
  bookingStatusKeepsResourcesLocked,
  isTerminalBookingStatus,
} from '../src/booking-allocation-lifecycle.js';

test('payment and execution states preserve the resource lock', () => {
  const expected: Array<[BookingStatus, ResourceAllocationStatus]> = [
    [BookingStatus.AWAITING_DEPOSIT, ResourceAllocationStatus.HELD],
    [BookingStatus.FUNDED, ResourceAllocationStatus.CONFIRMED],
    [BookingStatus.STARTING, ResourceAllocationStatus.CONFIRMED],
    [BookingStatus.ACTIVE, ResourceAllocationStatus.ACTIVE],
    [BookingStatus.DEGRADED, ResourceAllocationStatus.ACTIVE],
  ];

  for (const [bookingStatus, allocationStatus] of expected) {
    assert.deepEqual(allocationActionForBookingStatus(bookingStatus), {
      kind: 'transition',
      target: allocationStatus,
    });
    assert.equal(bookingStatusKeepsResourcesLocked(bookingStatus), true);
    assert.equal(isTerminalBookingStatus(bookingStatus), false);
  }
});

test('terminal booking states release or cancel physical resources', () => {
  const expected: Array<[BookingStatus, ResourceAllocationStatus]> = [
    [BookingStatus.COMPLETED, ResourceAllocationStatus.RELEASED],
    [BookingStatus.SETTLED, ResourceAllocationStatus.RELEASED],
    [BookingStatus.REFUNDED, ResourceAllocationStatus.RELEASED],
    [BookingStatus.CANCELLED, ResourceAllocationStatus.CANCELLED],
  ];

  for (const [bookingStatus, allocationStatus] of expected) {
    assert.deepEqual(allocationActionForBookingStatus(bookingStatus), {
      kind: 'transition',
      target: allocationStatus,
    });
    assert.equal(bookingStatusKeepsResourcesLocked(bookingStatus), false);
    assert.equal(isTerminalBookingStatus(bookingStatus), true);
  }
});

test('created and disputed bookings do not silently mutate allocations', () => {
  for (const status of [BookingStatus.CREATED, BookingStatus.DISPUTED]) {
    assert.deepEqual(allocationActionForBookingStatus(status), { kind: 'none' });
  }
});
