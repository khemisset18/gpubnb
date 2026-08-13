import test from 'node:test';
import assert from 'node:assert/strict';

import { isDataPlaneCanary, readDataPlaneRolloutFlags } from '../src/data-plane-flags.js';

test('new transports default off while migration fallback stays on', () => {
  assert.deepEqual(readDataPlaneRolloutFlags({}), {
    edgeQuicEnabled: false,
    directQuicEnabled: false,
    browserWebTransportEnabled: false,
    legacyFallbackEnabled: true,
    canaryPercent: 0,
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

test('canary assignment is stable, bounded and session-scoped', () => {
  const first = isDataPlaneCanary('session_abc', 25);
  for (let i = 0; i < 100; i += 1) assert.equal(isDataPlaneCanary('session_abc', 25), first);
  assert.equal(isDataPlaneCanary('session_abc', 0), false);
  assert.equal(isDataPlaneCanary('session_abc', 100), true);
  assert.throws(() => isDataPlaneCanary('../escape', 25), /session_id_invalid/);
  assert.throws(() => isDataPlaneCanary('session_abc', -1), /percent_invalid/);
});
