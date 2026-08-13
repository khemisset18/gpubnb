import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  dataPlaneHostBootstrapEnabled,
  issueHostTunnelBootstrap,
  loadDataPlaneHostRuntimeConfig,
} from '../src/data-plane-host-bootstrap.js';
import { verifyDataPlaneAuthorityForTest } from '../src/data-plane-authority.js';

function runtimeEnv() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    GPUBNB_DATA_PLANE_EDGE_ENABLED: 'true',
    GPUBNB_DATA_PLANE_EDGE_ID: 'edge_paris_1',
    GPUBNB_DATA_PLANE_EDGE_ADDR: 'edge-paris.internal:4433',
    GPUBNB_DATA_PLANE_EDGE_SERVER_NAME: 'edge-paris.internal',
    GPUBNB_DATA_PLANE_EDGE_CA_CERT_PEM_B64: Buffer.from(
      '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n',
    ).toString('base64'),
    GPUBNB_DATA_PLANE_AUTHORITY_PRIVATE_KEY_PEM_B64: Buffer.from(
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
    ).toString('base64'),
  };
}

test('Host bootstrap is disabled by default and requires an explicit true flag', () => {
  assert.equal(dataPlaneHostBootstrapEnabled({}), false);
  assert.equal(dataPlaneHostBootstrapEnabled({ GPUBNB_DATA_PLANE_EDGE_ENABLED: 'false' }), false);
  assert.equal(loadDataPlaneHostRuntimeConfig({}), null);
});

test('enabled Host bootstrap fails closed on partial or unsafe configuration', () => {
  assert.throws(
    () => loadDataPlaneHostRuntimeConfig({ GPUBNB_DATA_PLANE_EDGE_ENABLED: 'true' }),
    /edge_id_invalid/,
  );
  const badAddress = runtimeEnv();
  badAddress.GPUBNB_DATA_PLANE_EDGE_ADDR = 'edge.example:99999';
  assert.throws(() => loadDataPlaneHostRuntimeConfig(badAddress), /edge_addr_invalid/);

  const nonEd = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const badKey = runtimeEnv();
  badKey.GPUBNB_DATA_PLANE_AUTHORITY_PRIVATE_KEY_PEM_B64 = Buffer.from(
    nonEd.export({ format: 'pem', type: 'pkcs8' }),
  ).toString('base64');
  assert.throws(() => loadDataPlaneHostRuntimeConfig(badKey), /not_ed25519/);
});

test('bootstrap returns a fresh HOST authority without exposing the private signing key', () => {
  const env = runtimeEnv();
  const runtime = loadDataPlaneHostRuntimeConfig(env);
  assert.ok(runtime);
  const publicKey = crypto.createPublicKey(runtime.privateKey);
  const bootstrap = issueHostTunnelBootstrap(
    runtime,
    {
      sessionId: 'session_1',
      machineId: 'machine_1',
      bookingId: 'booking_1',
      renterUserId: 'user_1',
    },
    1_000_000,
  );
  assert.equal(bootstrap.authority.role, 'HOST');
  assert.equal(bootstrap.edgeId, 'edge_paris_1');
  assert.equal(bootstrap.authorityExpiresAtMs, 1_030_000);
  assert.equal(verifyDataPlaneAuthorityForTest(bootstrap.authority, publicKey), true);
  assert.equal(JSON.stringify(bootstrap).includes('PRIVATE KEY'), false);

  const next = issueHostTunnelBootstrap(
    runtime,
    {
      sessionId: 'session_1',
      machineId: 'machine_1',
      bookingId: 'booking_1',
      renterUserId: 'user_1',
    },
    1_000_001,
  );
  assert.notEqual(next.authority.binding.nonce, bootstrap.authority.binding.nonce);
});
