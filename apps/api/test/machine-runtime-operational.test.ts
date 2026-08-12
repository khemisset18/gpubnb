import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingStatus,
  MachineOperational,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { deriveHeartbeatOperational } from '../src/machine-runtime-operational.js';

test('heartbeat cannot make a funded machine available while work is pending', () => {
  assert.equal(deriveHeartbeatOperational({
    bookingStatus: BookingStatus.FUNDED,
    workspaceStatus: null,
    hasActiveJob: false,
    jobProtocolSupported: true,
  }), MachineOperational.RESERVED);
});

test('active workspace remains RUNNING even when the heartbeat carries no session id', () => {
  assert.equal(deriveHeartbeatOperational({
    bookingStatus: BookingStatus.ACTIVE,
    workspaceStatus: WorkspaceSessionStatus.RUNNING,
    hasActiveJob: true,
    jobProtocolSupported: true,
  }), MachineOperational.RUNNING);
});

test('degraded booking fails closed', () => {
  assert.equal(deriveHeartbeatOperational({
    bookingStatus: BookingStatus.DEGRADED,
    workspaceStatus: WorkspaceSessionStatus.STOPPING,
    hasActiveJob: true,
    jobProtocolSupported: true,
  }), MachineOperational.DEGRADED);
});

test('unsupported agent stays unavailable when no runtime is active', () => {
  assert.equal(deriveHeartbeatOperational({
    bookingStatus: null,
    workspaceStatus: null,
    hasActiveJob: false,
    jobProtocolSupported: false,
  }), MachineOperational.UNAVAILABLE);
});

test('supported idle agent may become available', () => {
  assert.equal(deriveHeartbeatOperational({
    bookingStatus: null,
    workspaceStatus: null,
    hasActiveJob: false,
    jobProtocolSupported: true,
  }), MachineOperational.AVAILABLE);
});
