import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorOperationalStatus,
  BookingStatus,
  DiagnosticRunStatus,
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
    jobProtocolSupported: true,
    lastHeartbeatAt: now,
    lastCudaProbeOk: true,
    dockerAvailable: true,
    nvidiaRuntimeAvailable: true,
    verifiedAt: now,
    heartbeatFresh: true,
    latestDiagnosticStatus: DiagnosticRunStatus.COMPLETED,
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

test('an agent whose reported protocol version is too old is AGENT_OUTDATED, not silently treated as ready', () => {
  const view = computeMachineState(readyMachine({ jobProtocolSupported: false }));
  assert.equal(view.state, 'AGENT_OUTDATED');
  assert.equal(view.blockingReason, 'AGENT_PROTOCOL_VERSION_TOO_OLD');
  assert.equal(view.canPublish, false);
  assert.equal(view.canAcceptBooking, false);
});

test('generic DEGRADED with a successful latest diagnostic never masquerades as DIAGNOSTIC_FAILED', () => {
  const view = computeMachineState(readyMachine({
    operational: MachineOperational.DEGRADED,
    latestDiagnosticStatus: DiagnosticRunStatus.COMPLETED,
  }));
  assert.equal(view.state, 'DEGRADED');
  assert.equal(view.blockingReason, 'MACHINE_DEGRADED');
  assert.equal(view.canPublish, false);
  assert.equal(view.canAcceptBooking, false);
});

test('an actual failed diagnostic is projected as DIAGNOSTIC_FAILED', () => {
  const view = computeMachineState(readyMachine({
    operational: MachineOperational.DEGRADED,
    latestDiagnosticStatus: DiagnosticRunStatus.FAILED,
  }));
  assert.equal(view.state, 'DIAGNOSTIC_FAILED');
  assert.equal(view.blockingReason, 'DIAGNOSTIC_FAILED');
  assert.equal(view.canPublish, false);
});

test('a timed-out diagnostic is an evidence-backed diagnostic failure', () => {
  const view = computeMachineState(readyMachine({
    latestDiagnosticStatus: DiagnosticRunStatus.TIMED_OUT,
  }));
  assert.equal(view.state, 'DIAGNOSTIC_FAILED');
  assert.equal(view.blockingReason, 'DIAGNOSTIC_TIMED_OUT');
});

test('a running diagnostic remains distinct from generic degradation', () => {
  const view = computeMachineState(readyMachine({
    operational: MachineOperational.DEGRADED,
    latestDiagnosticStatus: DiagnosticRunStatus.RUNNING,
  }));
  assert.equal(view.state, 'DIAGNOSTIC_RUNNING');
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
