import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceleratorOperationalStatus, BookingStatus, ListingStatus, MachineConnectivity, MachineOperational, ModerationStatus, ResourceAllocationStatus } from '@prisma/client';
import { computeMachineState, type MachineStateInput } from '../src/machine-state-service.js';

const now = new Date('2026-07-30T00:00:00.000Z');

function readyMachine(overrides: Partial<MachineStateInput> = {}): MachineStateInput {
  return {
    agentPublicKey: 'agent-key',
    connectivity: MachineConnectivity.ONLINE,
    operational: MachineOperational.AVAILABLE,
    moderationStatus: ModerationStatus.CLEAR,
    lastHeartbeatAt: now,
    lastCudaProbeOk: true,
    dockerAvailable: true,
    nvidiaRuntimeAvailable: true,
    verifiedAt: now,
    heartbeatFresh: true,
    accelerators: [{
      status: AcceleratorOperationalStatus.AVAILABLE,
      moderationStatus: ModerationStatus.CLEAR,
      verifiedAt: now,
      driverVersion: '560.94',
      cudaVersion: '12.6',
      lastSeenAt: now,
    }],
    listings: [],
    bookings: [],
    allocations: [],
    ...overrides,
  };
}

test('machine state blocks publishing before the host is linked', () => {
  const view = computeMachineState(readyMachine({ agentPublicKey: null }));
  assert.equal(view.state, 'NOT_LINKED');
  assert.equal(view.canPublish, false);
  assert.equal(view.blockingReason, 'NO_AGENT_PUBLIC_KEY');
});

test('machine state requires Docker and NVIDIA runtime before publication', () => {
  assert.equal(computeMachineState(readyMachine({ dockerAvailable: false })).state, 'DOCKER_UNAVAILABLE');
  assert.equal(computeMachineState(readyMachine({ nvidiaRuntimeAvailable: false })).state, 'NVIDIA_RUNTIME_UNAVAILABLE');
});

test('machine state exposes ready to publish and active listing gates', () => {
  const ready = computeMachineState(readyMachine());
  assert.equal(ready.state, 'READY_TO_PUBLISH');
  assert.equal(ready.canPublish, true);
  assert.equal(ready.canAcceptBooking, true);

  const listed = computeMachineState(readyMachine({ listings: [{ status: ListingStatus.ACTIVE }] }));
  assert.equal(listed.state, 'LISTING_ACTIVE');
  assert.equal(listed.canPublish, false);
  assert.equal(listed.canAcceptBooking, true);
});

test('machine state reports reserved and session active from allocation source of truth', () => {
  const allocation = { status: ResourceAllocationStatus.ACTIVE, releasedAt: null };
  const reserved = computeMachineState(readyMachine({
    allocations: [allocation],
    bookings: [{ status: BookingStatus.FUNDED }],
  }));
  assert.equal(reserved.state, 'RESERVED');
  assert.equal(reserved.canStartSession, true);

  const active = computeMachineState(readyMachine({
    allocations: [allocation],
    bookings: [{ status: BookingStatus.ACTIVE }],
  }));
  assert.equal(active.state, 'SESSION_ACTIVE');
  assert.equal(active.canAcceptBooking, false);
});

test('machine state fail-closes quarantined resources', () => {
  const view = computeMachineState(readyMachine({ moderationStatus: ModerationStatus.QUARANTINED }));
  assert.equal(view.state, 'QUARANTINED');
  assert.equal(view.canPublish, false);
  assert.equal(view.canAcceptBooking, false);
});
