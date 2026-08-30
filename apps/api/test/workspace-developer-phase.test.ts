import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSessionStatus, JobStatus } from '@prisma/client';
import { preparationPhase, safeConnection } from '../src/workspace-renter-routes.js';

// Regression coverage for the incident where the frontend displayed a
// "READY"-looking state for a Developer workspace whose gateway tunnel had
// never registered (connectionMetadata stayed null), so the open call always
// failed with 409 workspace_gateway_not_ready. READY must only ever be
// reported to the renter once the workspace is actually connectable.

test('safeConnection requires a well-formed gatewayPath, not just a truthy object', () => {
  assert.deepEqual(safeConnection(null), { ready: false, gatewayPath: null });
  assert.deepEqual(safeConnection({}), { ready: false, gatewayPath: null });
  assert.deepEqual(safeConnection({ gatewayPath: 42 }), { ready: false, gatewayPath: null });
  assert.deepEqual(safeConnection({ gatewayPath: '/etc/passwd' }), { ready: false, gatewayPath: null });
  assert.deepEqual(safeConnection({ gatewayPath: '/workspace-gateway/../x' }), { ready: false, gatewayPath: null });
  assert.deepEqual(
    safeConnection({ gatewayPath: '/workspace-gateway/abc123' }),
    { ready: true, gatewayPath: '/workspace-gateway/abc123' },
  );
});

test('preparationPhase reports GATEWAY_NOT_READY when status is READY but the gateway has not registered', () => {
  const phase = preparationPhase(WorkspaceSessionStatus.READY, 'CONNECTION_READY', null, false);
  assert.equal(phase, 'GATEWAY_NOT_READY');
});

test('preparationPhase reports the real READY status once the gateway connection is confirmed', () => {
  const phase = preparationPhase(WorkspaceSessionStatus.READY, 'CONNECTION_READY', null, true);
  assert.equal(phase, WorkspaceSessionStatus.READY);
});

test('preparationPhase is unaffected by connectionReady while still PREPARING', () => {
  const withImage = preparationPhase(WorkspaceSessionStatus.PREPARING, 'PULLING_IMAGE', null, false);
  assert.equal(withImage, 'DOWNLOADING_IMAGE');
  const stillFalse = preparationPhase(WorkspaceSessionStatus.PREPARING, 'PULLING_IMAGE', null, true);
  assert.equal(stillFalse, 'DOWNLOADING_IMAGE');
});

test('preparationPhase passes through terminal/running statuses unchanged regardless of connectionReady', () => {
  for (const status of [WorkspaceSessionStatus.RUNNING, WorkspaceSessionStatus.COMPLETED, WorkspaceSessionStatus.FAILED]) {
    assert.equal(preparationPhase(status, null, JobStatus.COMPLETED, false), status);
    assert.equal(preparationPhase(status, null, JobStatus.COMPLETED, true), status);
  }
});
