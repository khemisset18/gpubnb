import crypto, { type KeyObject } from 'node:crypto';

import {
  DATA_PLANE_AUTHORITY_DEFAULT_TTL_MS,
  issueDataPlaneAuthority,
  type DataPlaneAuthorityEnvelope,
} from './data-plane-authority.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_SERVER_NAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_EDGE_ADDR = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/;
const MAX_CA_PEM_BYTES = 64 * 1024;
const MAX_PRIVATE_KEY_PEM_BYTES = 16 * 1024;

export interface DataPlaneHostRuntimeConfig {
  edgeId: string;
  edgeAddr: string;
  serverName: string;
  caCertPem: string;
  privateKey: KeyObject;
}

export interface DataPlaneHostBootstrap {
  protocol: 'gpubnb-dp/1';
  edgeId: string;
  edgeAddr: string;
  serverName: string;
  caCertPem: string;
  authority: DataPlaneAuthorityEnvelope;
  authorityExpiresAtMs: number;
}

export interface DataPlaneHostSessionScope {
  sessionId: string;
  machineId: string;
  bookingId: string;
  renterUserId: string;
}

function decodeBase64(name: string, value: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${name}_base64_invalid`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > maxBytes) {
    throw new Error(`${name}_size_invalid`);
  }
  return decoded;
}

function validateEdgeAddress(value: string): void {
  const match = SAFE_EDGE_ADDR.exec(value);
  if (!match) throw new Error('data_plane_edge_addr_invalid');
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('data_plane_edge_addr_invalid');
  }
}

export function dataPlaneHostBootstrapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GPUBNB_DATA_PLANE_EDGE_ENABLED === 'true';
}

export function loadDataPlaneHostRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DataPlaneHostRuntimeConfig | null {
  if (!dataPlaneHostBootstrapEnabled(env)) return null;

  const edgeId = String(env.GPUBNB_DATA_PLANE_EDGE_ID ?? '').trim();
  const edgeAddr = String(env.GPUBNB_DATA_PLANE_EDGE_ADDR ?? '').trim();
  const serverName = String(env.GPUBNB_DATA_PLANE_EDGE_SERVER_NAME ?? '').trim();
  const caB64 = String(env.GPUBNB_DATA_PLANE_EDGE_CA_CERT_PEM_B64 ?? '').trim();
  const privateKeyB64 = String(env.GPUBNB_DATA_PLANE_AUTHORITY_PRIVATE_KEY_PEM_B64 ?? '').trim();

  if (!SAFE_ID.test(edgeId)) throw new Error('data_plane_edge_id_invalid');
  validateEdgeAddress(edgeAddr);
  if (!SAFE_SERVER_NAME.test(serverName)) throw new Error('data_plane_edge_server_name_invalid');

  const caCertPem = decodeBase64(
    'data_plane_edge_ca_cert',
    caB64,
    MAX_CA_PEM_BYTES,
  ).toString('utf8');
  if (!caCertPem.includes('-----BEGIN CERTIFICATE-----') || !caCertPem.includes('-----END CERTIFICATE-----')) {
    throw new Error('data_plane_edge_ca_cert_pem_invalid');
  }

  const privateKeyPem = decodeBase64(
    'data_plane_authority_private_key',
    privateKeyB64,
    MAX_PRIVATE_KEY_PEM_BYTES,
  );
  let privateKey: KeyObject;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new Error('data_plane_authority_private_key_invalid');
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('data_plane_authority_private_key_not_ed25519');
  }

  return { edgeId, edgeAddr, serverName, caCertPem, privateKey };
}

export function issueHostTunnelBootstrap(
  runtime: DataPlaneHostRuntimeConfig,
  scope: DataPlaneHostSessionScope,
  nowMs = Date.now(),
): DataPlaneHostBootstrap {
  for (const [name, value] of Object.entries(scope)) {
    if (!SAFE_ID.test(value)) throw new Error(`data_plane_host_scope_${name}_invalid`);
  }
  const authority = issueDataPlaneAuthority({
    edgeId: runtime.edgeId,
    role: 'HOST',
    sessionId: scope.sessionId,
    machineId: scope.machineId,
    bookingId: scope.bookingId,
    renterUserId: scope.renterUserId,
    privateKey: runtime.privateKey,
    nowMs,
    ttlMs: DATA_PLANE_AUTHORITY_DEFAULT_TTL_MS,
  });
  return {
    protocol: 'gpubnb-dp/1',
    edgeId: runtime.edgeId,
    edgeAddr: runtime.edgeAddr,
    serverName: runtime.serverName,
    caCertPem: runtime.caCertPem,
    authority,
    authorityExpiresAtMs: authority.binding.expiresAtMs,
  };
}
