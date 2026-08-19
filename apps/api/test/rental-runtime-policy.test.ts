import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RENTAL_HEARTBEAT_OFFLINE_SECONDS,
  rentalHeartbeatOfflineSeconds,
} from '../src/rental-runtime-policy.js';

test('rental heartbeat policy defaults without importing production config', () => {
  assert.equal(rentalHeartbeatOfflineSeconds({}), DEFAULT_RENTAL_HEARTBEAT_OFFLINE_SECONDS);
  assert.equal(DEFAULT_RENTAL_HEARTBEAT_OFFLINE_SECONDS, 60);
});

test('rental heartbeat policy honors the same validated range as app config', () => {
  assert.equal(rentalHeartbeatOfflineSeconds({ HEARTBEAT_OFFLINE_SECONDS: '15' }), 15);
  assert.equal(rentalHeartbeatOfflineSeconds({ HEARTBEAT_OFFLINE_SECONDS: '90' }), 90);
  assert.equal(rentalHeartbeatOfflineSeconds({ HEARTBEAT_OFFLINE_SECONDS: '300' }), 300);
});

test('invalid rental heartbeat policy fails closed', () => {
  assert.throws(() => rentalHeartbeatOfflineSeconds({ HEARTBEAT_OFFLINE_SECONDS: '14' }), /invalid_rental_heartbeat_offline_seconds/);
  assert.throws(() => rentalHeartbeatOfflineSeconds({ HEARTBEAT_OFFLINE_SECONDS: '301' }), /invalid_rental_heartbeat_offline_seconds/);
  assert.throws(() => rentalHeartbeatOfflineSeconds({ HEARTBEAT_OFFLINE_SECONDS: 'abc' }), /invalid_rental_heartbeat_offline_seconds/);
});
