import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectionQuality,
  selectDataPlaneTransport,
  type DataPlaneFeatureFlags,
  type HostConnectivity,
} from '../src/data-plane-policy.js';

const goodProbe = {
  rttMs: 24,
  jitterMs: 3,
  packetLossPct: 0.05,
  uploadMbps: 250,
  downloadMbps: 700,
  tunnelUptimePct: 99.99,
};

const flags: DataPlaneFeatureFlags = {
  directQuicEnabled: true,
  edgeQuicEnabled: true,
  legacyFallbackEnabled: true,
  browserWebTransportEnabled: false,
};

function host(overrides: Partial<HostConnectivity> = {}): HostConnectivity {
  return {
    directQuicReachable: true,
    directQuicVerifiedAt: new Date('2026-08-13T00:00:00Z'),
    legacyGatewayHealthy: true,
    network: goodProbe,
    edges: [
      { id: 'edge-par-1', region: 'eu-west', healthy: true, ...goodProbe, rttMs: 20 },
      { id: 'edge-fra-1', region: 'eu-central', healthy: true, ...goodProbe, rttMs: 35 },
    ],
    ...overrides,
  };
}

test('native client prefers a freshly verified direct QUIC path', () => {
  const decision = selectDataPlaneTransport(
    host(),
    { kind: 'NATIVE', quicCapable: true, webTransportCapable: false },
    flags,
    new Date('2026-08-13T00:02:00Z'),
  );
  assert.deepEqual(decision, { transport: 'DIRECT_QUIC', reason: 'direct_verified' });
});

test('stale direct verification falls back to the best healthy edge', () => {
  const decision = selectDataPlaneTransport(
    host(),
    { kind: 'NATIVE', quicCapable: true, webTransportCapable: false },
    flags,
    new Date('2026-08-13T00:10:01Z'),
  );
  assert.equal(decision.transport, 'EDGE_QUIC');
  assert.equal(decision.edgeId, 'edge-par-1');
});

test('browser does not use direct QUIC until WebTransport rollout is explicitly enabled', () => {
  const decision = selectDataPlaneTransport(
    host(),
    { kind: 'BROWSER', quicCapable: false, webTransportCapable: true },
    flags,
    new Date('2026-08-13T00:02:00Z'),
  );
  assert.equal(decision.transport, 'EDGE_QUIC');
});

test('browser may use direct path only behind the WebTransport capability flag', () => {
  const decision = selectDataPlaneTransport(
    host(),
    { kind: 'BROWSER', quicCapable: false, webTransportCapable: true },
    { ...flags, browserWebTransportEnabled: true },
    new Date('2026-08-13T00:02:00Z'),
  );
  assert.equal(decision.transport, 'DIRECT_QUIC');
});

test('unhealthy edges are skipped and legacy remains a bounded migration fallback', () => {
  const decision = selectDataPlaneTransport(
    host({
      directQuicReachable: false,
      edges: [{ id: 'edge-par-1', region: 'eu-west', healthy: false, ...goodProbe }],
    }),
    { kind: 'NATIVE', quicCapable: true, webTransportCapable: false },
    flags,
  );
  assert.deepEqual(decision, { transport: 'LEGACY_GATEWAY', reason: 'legacy_fallback' });
});

test('no transport silently succeeds when every path is unavailable', () => {
  assert.throws(
    () =>
      selectDataPlaneTransport(
        host({ directQuicReachable: false, legacyGatewayHealthy: false, edges: [] }),
        { kind: 'NATIVE', quicCapable: true, webTransportCapable: false },
        flags,
      ),
    /data_plane_unavailable/,
  );
});

test('interactive Developer rejects materially unstable host networks before allocation', () => {
  const bad = { ...goodProbe, packetLossPct: 2.5, tunnelUptimePct: 97.5 };
  const quality = connectionQuality(bad);
  assert.equal(quality.eligibleForInteractiveDeveloper, false);
  assert.ok(quality.reasons.includes('packet_loss_too_high'));
  assert.ok(quality.reasons.includes('tunnel_uptime_too_low'));

  assert.throws(
    () =>
      selectDataPlaneTransport(
        host({ network: bad }),
        { kind: 'NATIVE', quicCapable: true, webTransportCapable: false },
        flags,
      ),
    /host_network_not_interactive/,
  );
});

test('invalid telemetry is fail-closed instead of poisoning ranking', () => {
  assert.throws(
    () => connectionQuality({ ...goodProbe, rttMs: Number.NaN }),
    /network_probe_non_finite/,
  );
  assert.throws(
    () => connectionQuality({ ...goodProbe, packetLossPct: 101 }),
    /network_probe_loss_invalid/,
  );
});
