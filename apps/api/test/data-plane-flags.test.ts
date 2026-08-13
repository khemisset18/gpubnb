import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDataPlaneReleaseQualified,
  isDataPlaneCanary,
  readDataPlaneRolloutFlags,
} from '../src/data-plane-flags.js';

const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';

const qualifiedEnv = {
  GPUBNB_RELEASE_SHA: RELEASE_SHA,
  GPUBNB_DATA_PLANE_QUALIFIED_SHA: RELEASE_SHA,
};

test('new transports default off while migration fallback stays on', () => {
  assert.deepEqual(readDataPlaneRolloutFlags({}), {
    edgeQuicEnabled: false,
    directQuicEnabled: false,
    browserWebTransportEnabled: false,
    legacyFallbackEnabled: true,
    canaryPercent: 0,
    qualifiedReleaseSha: null,
  });
});

test('malformed rollout configuration fails closed', () => {
  assert.throws(
    () => readDataPlaneRolloutFlags({ GPUBNB_DATA_PLANE_EDGE_QUIC: 'maybe' }),
    /invalid_boolean/,
  );
  assert.throws(
    () => readDataPlaneRolloutFlags({ GPUBNB_DATA_PLANE_CANARY_PERCENT: '101' }),
    /invalid_percent/,
  );
  assert.throws(
    () => readDataPlaneRolloutFlags({ GPUBNB_DATA_PLANE_CANARY_PERCENT: '5' }),
    /canary_without_transport/,
  );
});

test('browser WebTransport cannot be enabled without the direct transport capability', () => {
  assert.throws(
    () =>
      readDataPlaneRolloutFlags({
        GPUBNB_DATA_PLANE_BROWSER_WEBTRANSPORT: 'true',
        GPUBNB_DATA_PLANE_DIRECT_QUIC: 'false',
      }),
    /requires_direct_quic/,
  );
});

test('EDGE_QUIC and DIRECT_QUIC cannot be enabled without exact-release qualification', () => {
  assert.throws(
    () => readDataPlaneRolloutFlags({ GPUBNB_DATA_PLANE_EDGE_QUIC: 'true' }),
    /GPUBNB_RELEASE_SHA_invalid_sha/,
  );
  assert.throws(
    () =>
      readDataPlaneRolloutFlags({
        GPUBNB_DATA_PLANE_EDGE_QUIC: 'true',
        GPUBNB_RELEASE_SHA: RELEASE_SHA,
      }),
    /GPUBNB_DATA_PLANE_QUALIFIED_SHA_invalid_sha/,
  );
  assert.throws(
    () =>
      readDataPlaneRolloutFlags({
        GPUBNB_DATA_PLANE_EDGE_QUIC: 'true',
        GPUBNB_RELEASE_SHA: RELEASE_SHA,
        GPUBNB_DATA_PLANE_QUALIFIED_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    /data_plane_release_not_qualified/,
  );
});

test('qualified release may enable a bounded canary and records the evidence SHA', () => {
  assert.deepEqual(
    readDataPlaneRolloutFlags({
      ...qualifiedEnv,
      GPUBNB_DATA_PLANE_EDGE_QUIC: 'true',
      GPUBNB_DATA_PLANE_CANARY_PERCENT: '5',
    }),
    {
      edgeQuicEnabled: true,
      directQuicEnabled: false,
      browserWebTransportEnabled: false,
      legacyFallbackEnabled: true,
      canaryPercent: 5,
      qualifiedReleaseSha: RELEASE_SHA,
    },
  );
  assert.equal(assertDataPlaneReleaseQualified(qualifiedEnv), RELEASE_SHA);
});

test('canary assignment is stable, bounded and session-scoped', () => {
  const first = isDataPlaneCanary('session_abc', 25);
  for (let i = 0; i < 100; i += 1) assert.equal(isDataPlaneCanary('session_abc', 25), first);
  assert.equal(isDataPlaneCanary('session_abc', 0), false);
  assert.equal(isDataPlaneCanary('session_abc', 100), true);
  assert.throws(() => isDataPlaneCanary('../escape', 25), /session_id_invalid/);
  assert.throws(() => isDataPlaneCanary('session_abc', -1), /percent_invalid/);
});
