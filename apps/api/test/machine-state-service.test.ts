import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorOperationalStatus,
  BookingStatus,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  ResourceAllocationStatus,
} from '@prisma/client';
import { computeMachineState, type MachineStateInput } from '../src/machine-state-service.js';

const now = new Date('2026-08-18T00:00:00.000Z');

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
      driverVersion: '592.82',
      lastSeenAt: now,
    }],
    listings: [],
    machineAllocations: [],
    ...overrides,
  };
}

test('host readiness blocks publication before link and heartbeat', () => {
  const notLinked = computeMachineState(readyMachine({ agentPublicKey: null }));
  assert.equal(notLinked.state, 'NOT_LINKED');
  assert.equal(notLinked.canPublish, false);

  const noHeartbeat = computeMachineState(readyMachine({ lastHeartbeatAt: null }));
  assert.equal(noHeartbeat.state, 'WAITING_FOR_FIRST_HEARTBEAT');
  assert.equal(noHeartbeat.blockingReason, 'NO_HEARTBEAT_RECEIVED');
});

test('host readiness requires Docker, NVIDIA runtime and verified GPU evidence', () => {
  assert.equal(computeMachineState(readyMachine({ dockerAvailable: false })).state, 'DOCKER_UNAVAILABLE');
  assert.equal(computeMachineState(readyMachine({ nvidiaRuntimeAvailable: false })).state, 'NVIDIA_RUNTIME_UNAVAILABLE');
  assert.equal(computeMachineState(readyMachine({ lastCudaProbeOk: false })).state, 'DIAGNOSTIC_REQUIRED');
  assert.equal(computeMachineState(readyMachine({ verifiedAt: null })).state, 'VERIFICATION_REQUIRED');
});

test('an active listing does not block another verified GPU on a multi-GPU host', () => {
  const view = computeMachineState(readyMachine({ listings: [{ status: ListingStatus.ACTIVE }] }));
  assert.equal(view.state, 'LISTING_ACTIVE');
  assert.equal(view.canPublish, true);
  assert.equal(view.canAcceptBooking, true);
});

test('full-machine allocation drives reserved and active session states', () => {
  const reserved = computeMachineState(readyMachine({
    machineAllocations: [{
      status: ResourceAllocationStatus.CONFIRMED,
      releasedAt: null,
      bookingStatus: BookingStatus.FUNDED,
    }],
  }));
  assert.equal(reserved.state, 'RESERVED');
  assert.equal(reserved.canStartSession, true);

  const active = computeMachineState(readyMachine({
    machineAllocations: [{
      status: ResourceAllocationStatus.ACTIVE,
      releasedAt: null,
      bookingStatus: BookingStatus.ACTIVE,
    }],
  }));
  assert.equal(active.state, 'SESSION_ACTIVE');
  assert.equal(active.canPublish, false);
});

test('quarantine always fails closed', () => {
  const machine = computeMachineState(readyMachine({ moderationStatus: ModerationStatus.QUARANTINED }));
  assert.equal(machine.state, 'QUARANTINED');
  assert.equal(machine.canPublish, false);
  assert.equal(machine.canAcceptBooking, false);

  const gpu = computeMachineState(readyMachine({
    accelerators: [{
      status: AcceleratorOperationalStatus.QUARANTINED,
      moderationStatus: ModerationStatus.QUARANTINED,
      verifiedAt: now,
      driverVersion: '592.82',
      lastSeenAt: now,
    }],
  }));
  assert.equal(gpu.state, 'QUARANTINED');
});

test('quarantine surfaces the real stable reasonCode instead of a generic label', () => {
  const withReason = computeMachineState(readyMachine({
    moderationStatus: ModerationStatus.QUARANTINED,
    quarantineReasonCode: 'GPU_HEALTH_CHECK_FAILED',
  }));
  assert.equal(withReason.state, 'QUARANTINED');
  assert.equal(withReason.blockingReason, 'GPU_HEALTH_CHECK_FAILED');

  // A machine quarantined before this field existed (or whose reason code was
  // never recorded) must never be presented as if no reason exists.
  const withoutReason = computeMachineState(readyMachine({
    moderationStatus: ModerationStatus.QUARANTINED,
    quarantineReasonCode: null,
  }));
  assert.equal(withoutReason.blockingReason, 'UNKNOWN');
});

test('an offline (stale-heartbeat) machine is never READY, independent of quarantine', () => {
  const stale = computeMachineState(readyMachine({ heartbeatFresh: false }));
  assert.equal(stale.state, 'OFFLINE');
  assert.equal(stale.canPublish, false);
  assert.equal(stale.canAcceptBooking, false);
});
