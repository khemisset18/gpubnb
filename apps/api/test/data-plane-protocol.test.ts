import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_PLANE_LIMITS,
  GPUBNB_DATA_PLANE_VERSION,
  isInteractiveReady,
  validateOpenStream,
  validateSessionBinding,
  type DataPlaneSessionBinding,
} from '../src/data-plane-protocol.js';

function binding(overrides: Partial<DataPlaneSessionBinding> = {}): DataPlaneSessionBinding {
  return {
    protocolVersion: GPUBNB_DATA_PLANE_VERSION,
    sessionId: 'session_123',
    machineId: 'machine_123',
    bookingId: 'booking_123',
    renterUserId: 'user_123',
    issuedAtMs: 1_000_000,
    expiresAtMs: 1_000_000 + 60_000,
    nonce: '0123456789abcdef0123456789abcdef',
    ...overrides,
  };
}

test('session binding is scoped, versioned and bounded in time', () => {
  assert.doesNotThrow(() => validateSessionBinding(binding(), 1_030_000));
  assert.throws(
    () => validateSessionBinding(binding({ protocolVersion: 2 as 1 }), 1_030_000),
    /data_plane_version_mismatch/,
  );
  assert.throws(
    () => validateSessionBinding(binding({ sessionId: '../escape' }), 1_030_000),
    /sessionId_invalid/,
  );
  assert.throws(
    () =>
      validateSessionBinding(
        binding({ expiresAtMs: 1_000_000 + DATA_PLANE_LIMITS.maxSessionLifetimeMs + 1 }),
        1_030_000,
      ),
    /lifetime_invalid/,
  );
  assert.throws(() => validateSessionBinding(binding(), 1_060_000), /not_current/);
});

test('stream metadata is fail-closed and arbitrary ports require APP_PORT kind', () => {
  assert.doesNotThrow(() => validateOpenStream({ type: 'OPEN_STREAM', streamId: 1, kind: 'VSCODE_MANAGEMENT' }));
  assert.doesNotThrow(() => validateOpenStream({ type: 'OPEN_STREAM', streamId: 2, kind: 'APP_PORT', targetPort: 8000 }));
  assert.throws(
    () => validateOpenStream({ type: 'OPEN_STREAM', streamId: 3, kind: 'TERMINAL', targetPort: 22 }),
    /target_port_forbidden/,
  );
  assert.throws(
    () => validateOpenStream({ type: 'OPEN_STREAM', streamId: 4, kind: 'APP_PORT', targetPort: 70000 }),
    /target_port_invalid/,
  );
});

test('Developer is interactive only when Management and ExtensionHost are both live', () => {
  assert.equal(isInteractiveReady(['VSCODE_MANAGEMENT']), false);
  assert.equal(isInteractiveReady(['VSCODE_EXTENSION_HOST']), false);
  assert.equal(isInteractiveReady(['VSCODE_MANAGEMENT', 'VSCODE_EXTENSION_HOST']), true);
  assert.equal(
    isInteractiveReady(['CONTROL', 'VSCODE_MANAGEMENT', 'VSCODE_EXTENSION_HOST', 'TERMINAL']),
    true,
  );
});
