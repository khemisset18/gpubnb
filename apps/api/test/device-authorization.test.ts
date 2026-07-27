import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeviceAuthorizationError,
  authorizeDevice,
  consumeDeviceAuthorization,
  createDeviceAuthorization,
  digestDeviceAuthorizationSecret,
} from '../src/device-authorization.js';

const PUBLIC_KEY = '6QWeT6GxvT9KxJ5C7gU3yR2nM8pD4sA1bF9hL7qZ2XcV';
const FINGERPRINT = 'A'.repeat(64);

test('creates opaque secrets and stores only digests', () => {
  const challenge = createDeviceAuthorization(
    { publicKey: PUBLIC_KEY, machineFingerprint: FINGERPRINT },
    1_000,
  );

  assert.equal(challenge.userCode.length, 10);
  assert.match(challenge.userCode, /^[A-F0-9]{10}$/);
  assert.ok(challenge.deviceCode.length >= 40);
  assert.equal(challenge.record.deviceCodeDigest, digestDeviceAuthorizationSecret(challenge.deviceCode));
  assert.equal(challenge.record.userCodeDigest, digestDeviceAuthorizationSecret(challenge.userCode));
  assert.notEqual(challenge.record.deviceCodeDigest, challenge.deviceCode);
  assert.notEqual(challenge.record.userCodeDigest, challenge.userCode);
  assert.equal(challenge.record.status, 'pending');
  assert.equal(challenge.record.expiresAtUnix, 1_600);
});

test('rejects malformed public keys and fingerprints', () => {
  assert.throws(
    () => createDeviceAuthorization({ publicKey: 'bad', machineFingerprint: FINGERPRINT }),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === 'invalid_public_key',
  );
  assert.throws(
    () => createDeviceAuthorization({ publicKey: PUBLIC_KEY, machineFingerprint: 'bad' }),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === 'invalid_machine_fingerprint',
  );
});

test('requires browser authorization before consumption', () => {
  const challenge = createDeviceAuthorization(
    { publicKey: PUBLIC_KEY, machineFingerprint: FINGERPRINT },
    1_000,
  );

  assert.throws(
    () => consumeDeviceAuthorization(challenge.record, 1_010),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === 'authorization_pending',
  );
});

test('authorizes and consumes exactly once', () => {
  const challenge = createDeviceAuthorization(
    { publicKey: PUBLIC_KEY, machineFingerprint: FINGERPRINT },
    1_000,
  );
  const authorized = authorizeDevice(challenge.record, 'owner-123', 1_050);
  const consumed = consumeDeviceAuthorization(authorized, 1_060);

  assert.equal(consumed.result.ownerId, 'owner-123');
  assert.equal(consumed.result.publicKey, PUBLIC_KEY);
  assert.equal(consumed.result.machineFingerprint, FINGERPRINT.toLowerCase());
  assert.equal(consumed.record.status, 'consumed');
  assert.equal(consumed.record.consumedAtUnix, 1_060);

  assert.throws(
    () => consumeDeviceAuthorization(consumed.record, 1_061),
    (error: unknown) =>
      error instanceof DeviceAuthorizationError && error.code === 'authorization_already_consumed',
  );
});

test('rejects repeated browser authorization', () => {
  const challenge = createDeviceAuthorization(
    { publicKey: PUBLIC_KEY, machineFingerprint: FINGERPRINT },
    1_000,
  );
  const authorized = authorizeDevice(challenge.record, 'owner-123', 1_050);

  assert.throws(
    () => authorizeDevice(authorized, 'owner-456', 1_051),
    (error: unknown) =>
      error instanceof DeviceAuthorizationError && error.code === 'authorization_already_authorized',
  );
});

test('rejects authorization and consumption after expiration', () => {
  const challenge = createDeviceAuthorization(
    { publicKey: PUBLIC_KEY, machineFingerprint: FINGERPRINT },
    1_000,
  );

  assert.throws(
    () => authorizeDevice(challenge.record, 'owner-123', 1_600),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === 'authorization_expired',
  );
  assert.throws(
    () => consumeDeviceAuthorization(challenge.record, 1_600),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === 'authorization_expired',
  );
});
