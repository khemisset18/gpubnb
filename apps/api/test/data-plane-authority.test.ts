import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  DATA_PLANE_AUTHORITY_MAX_TTL_MS,
  canonicalDataPlaneAuthorityClaims,
  canonicalDataPlaneBinding,
  issueDataPlaneAuthority,
  verifyDataPlaneAuthorityForTest,
} from '../src/data-plane-authority.js';

test('control plane issues a short-lived Ed25519 authority scoped to one edge, role and renter session', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = issueDataPlaneAuthority({
    edgeId: 'edge_paris_1',
    role: 'RENTER',
    sessionId: 'session_1',
    machineId: 'machine_1',
    bookingId: 'booking_1',
    renterUserId: 'user_1',
    privateKey,
    nowMs: 1_000_000,
    ttlMs: 30_000,
  });

  assert.equal(envelope.edgeId, 'edge_paris_1');
  assert.equal(envelope.role, 'RENTER');
  assert.equal(envelope.binding.issuedAtMs, 1_000_000);
  assert.equal(envelope.binding.expiresAtMs, 1_030_000);
  assert.match(envelope.binding.nonce, /^[a-f0-9]{64}$/);
  assert.match(envelope.signatureHex, /^[a-f0-9]{128}$/);
  assert.equal(verifyDataPlaneAuthorityForTest(envelope, publicKey), true);
});

test('changing edge, role, machine, booking or renter after signing invalidates authority', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = issueDataPlaneAuthority({
    edgeId: 'edge_paris_1',
    role: 'RENTER',
    sessionId: 'session_1',
    machineId: 'machine_1',
    bookingId: 'booking_1',
    renterUserId: 'user_1',
    privateKey,
    nowMs: 1_000_000,
  });

  assert.equal(
    verifyDataPlaneAuthorityForTest({ ...envelope, edgeId: 'edge_london_1' }, publicKey),
    false,
  );
  assert.equal(verifyDataPlaneAuthorityForTest({ ...envelope, role: 'HOST' }, publicKey), false);
  for (const binding of [
    { ...envelope.binding, machineId: 'machine_2' },
    { ...envelope.binding, bookingId: 'booking_2' },
    { ...envelope.binding, renterUserId: 'user_2' },
  ]) {
    assert.equal(verifyDataPlaneAuthorityForTest({ ...envelope, binding }, publicKey), false);
  }
});

test('authority TTL and identifiers are hard bounded', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const base = {
    edgeId: 'edge_paris_1',
    role: 'RENTER' as const,
    sessionId: 'session_1',
    machineId: 'machine_1',
    bookingId: 'booking_1',
    renterUserId: 'user_1',
    privateKey,
    nowMs: 1_000_000,
  };
  assert.throws(
    () => issueDataPlaneAuthority({ ...base, ttlMs: DATA_PLANE_AUTHORITY_MAX_TTL_MS + 1 }),
    /ttl_invalid/,
  );
  assert.throws(() => issueDataPlaneAuthority({ ...base, edgeId: '../escape' }), /edge_id_invalid/);
  assert.throws(() => issueDataPlaneAuthority({ ...base, sessionId: '../escape' }), /session_id_invalid/);
});

test('canonical binding and authority claim property order are protocol-stable across runtimes', () => {
  const binding = {
    protocolVersion: 1 as const,
    sessionId: 'session_1',
    machineId: 'machine_1',
    bookingId: 'booking_1',
    renterUserId: 'user_1',
    issuedAtMs: 1000,
    expiresAtMs: 2000,
    nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const raw = canonicalDataPlaneBinding(binding).toString('utf8');
  assert.equal(
    raw,
    '{"protocolVersion":1,"sessionId":"session_1","machineId":"machine_1","bookingId":"booking_1","renterUserId":"user_1","issuedAtMs":1000,"expiresAtMs":2000,"nonce":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}',
  );
  assert.equal(
    canonicalDataPlaneAuthorityClaims('edge_paris_1', 'RENTER', binding).toString('utf8'),
    '{"edgeId":"edge_paris_1","role":"RENTER","binding":{"protocolVersion":1,"sessionId":"session_1","machineId":"machine_1","bookingId":"booking_1","renterUserId":"user_1","issuedAtMs":1000,"expiresAtMs":2000,"nonce":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}',
  );
});
