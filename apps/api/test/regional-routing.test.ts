import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gatewayUtilizationBps,
  rankRegionalGateways,
  selectRegionalGateway,
  type RegionalGatewayCandidate,
} from '../src/regional-routing.js';

const candidates: RegionalGatewayCandidate[] = [
  {
    gatewayId: 'gateway_eu_0001',
    region: 'eu-west',
    state: 'READY',
    observedRttMs: 28,
    activeConnections: 40_000,
    maxConnections: 100_000,
    errorRateBps: 5,
  },
  {
    gatewayId: 'gateway_us_0001',
    region: 'us-east',
    state: 'READY',
    observedRttMs: 75,
    activeConnections: 10_000,
    maxConnections: 100_000,
    errorRateBps: 1,
  },
  {
    gatewayId: 'gateway_eu_0002',
    region: 'eu-west',
    state: 'DRAINING',
    observedRttMs: 8,
    activeConnections: 5_000,
    maxConnections: 100_000,
    errorRateBps: 0,
  },
];

test('routing prefers locality while never assigning a draining gateway', () => {
  const selected = selectRegionalGateway({
    machineId: 'machine_00000001',
    candidates,
    preferredRegions: ['eu-west', 'us-east'],
  });
  assert.equal(selected.gatewayId, 'gateway_eu_0001');
  assert.equal(selected.region, 'eu-west');
  assert.ok(rankRegionalGateways({ machineId: 'machine_00000001', candidates }).every((item) => item.state === 'READY'));
});

test('routing rejects saturated or unhealthy connection gateways', () => {
  const saturated: RegionalGatewayCandidate[] = candidates.map((candidate) => ({ ...candidate }));
  saturated[0] = { ...saturated[0]!, activeConnections: 96_000 };
  const selected = selectRegionalGateway({
    machineId: 'machine_00000002',
    candidates: saturated,
    preferredRegions: ['eu-west', 'us-east'],
  });
  assert.equal(selected.gatewayId, 'gateway_us_0001');

  assert.throws(
    () => selectRegionalGateway({
      machineId: 'machine_00000003',
      candidates: saturated.map((candidate) => ({ ...candidate, state: 'OFFLINE' as const })),
    }),
    /no_regional_gateway_capacity/,
  );
});

test('capacity arithmetic is bounded and rejects incoherent snapshots', () => {
  assert.equal(gatewayUtilizationBps(50_000, 100_000), 5_000);
  assert.throws(() => gatewayUtilizationBps(101, 100), /capacity_incoherent/);
});
