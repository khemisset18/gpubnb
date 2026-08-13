import crypto, { type KeyLike } from 'node:crypto';

import { GPUBNB_DATA_PLANE_VERSION, type DataPlaneSessionBinding } from './data-plane-protocol.js';

export const DATA_PLANE_AUTHORITY_MAX_TTL_MS = 60_000;
export const DATA_PLANE_AUTHORITY_DEFAULT_TTL_MS = 30_000;

export type DataPlaneAuthorityRole = 'HOST' | 'RENTER';

export interface DataPlaneAuthorityEnvelope {
  edgeId: string;
  role: DataPlaneAuthorityRole;
  binding: DataPlaneSessionBinding;
  signatureHex: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;

function validateId(name: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`data_plane_authority_${name}_invalid`);
}

function validateRole(role: DataPlaneAuthorityRole): void {
  if (role !== 'HOST' && role !== 'RENTER') throw new Error('data_plane_authority_role_invalid');
}

function canonicalBindingObject(binding: DataPlaneSessionBinding) {
  if (binding.protocolVersion !== GPUBNB_DATA_PLANE_VERSION) {
    throw new Error('data_plane_authority_version_invalid');
  }
  validateId('session_id', binding.sessionId);
  validateId('machine_id', binding.machineId);
  validateId('booking_id', binding.bookingId);
  validateId('renter_user_id', binding.renterUserId);
  if (!/^[a-f0-9]{64}$/i.test(binding.nonce)) throw new Error('data_plane_authority_nonce_invalid');
  if (!Number.isSafeInteger(binding.issuedAtMs) || !Number.isSafeInteger(binding.expiresAtMs)) {
    throw new Error('data_plane_authority_time_invalid');
  }
  if (binding.expiresAtMs <= binding.issuedAtMs) throw new Error('data_plane_authority_expiry_invalid');
  if (binding.expiresAtMs - binding.issuedAtMs > DATA_PLANE_AUTHORITY_MAX_TTL_MS) {
    throw new Error('data_plane_authority_ttl_too_long');
  }

  return {
    protocolVersion: binding.protocolVersion,
    sessionId: binding.sessionId,
    machineId: binding.machineId,
    bookingId: binding.bookingId,
    renterUserId: binding.renterUserId,
    issuedAtMs: binding.issuedAtMs,
    expiresAtMs: binding.expiresAtMs,
    nonce: binding.nonce.toLowerCase(),
  };
}

export function canonicalDataPlaneBinding(binding: DataPlaneSessionBinding): Buffer {
  return Buffer.from(JSON.stringify(canonicalBindingObject(binding)), 'utf8');
}

export function canonicalDataPlaneAuthorityClaims(
  edgeId: string,
  role: DataPlaneAuthorityRole,
  binding: DataPlaneSessionBinding,
): Buffer {
  validateId('edge_id', edgeId);
  validateRole(role);
  const canonical = {
    edgeId,
    role,
    binding: canonicalBindingObject(binding),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

export function issueDataPlaneAuthority(input: {
  edgeId: string;
  role: DataPlaneAuthorityRole;
  sessionId: string;
  machineId: string;
  bookingId: string;
  renterUserId: string;
  privateKey: KeyLike;
  nowMs?: number;
  ttlMs?: number;
}): DataPlaneAuthorityEnvelope {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DATA_PLANE_AUTHORITY_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('data_plane_authority_now_invalid');
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > DATA_PLANE_AUTHORITY_MAX_TTL_MS) {
    throw new Error('data_plane_authority_ttl_invalid');
  }
  validateId('edge_id', input.edgeId);
  validateRole(input.role);

  const binding: DataPlaneSessionBinding = {
    protocolVersion: GPUBNB_DATA_PLANE_VERSION,
    sessionId: input.sessionId,
    machineId: input.machineId,
    bookingId: input.bookingId,
    renterUserId: input.renterUserId,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    nonce: crypto.randomBytes(32).toString('hex'),
  };
  const message = canonicalDataPlaneAuthorityClaims(input.edgeId, input.role, binding);
  const signature = crypto.sign(null, message, input.privateKey);
  if (signature.length !== 64) throw new Error('data_plane_authority_signature_invalid');
  return { edgeId: input.edgeId, role: input.role, binding, signatureHex: signature.toString('hex') };
}

export function verifyDataPlaneAuthorityForTest(
  envelope: DataPlaneAuthorityEnvelope,
  publicKey: KeyLike,
): boolean {
  if (!/^[a-f0-9]{128}$/i.test(envelope.signatureHex)) return false;
  try {
    return crypto.verify(
      null,
      canonicalDataPlaneAuthorityClaims(envelope.edgeId, envelope.role, envelope.binding),
      publicKey,
      Buffer.from(envelope.signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}
