import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CONTROL_PROTOCOL_VERSION,
  controlChannelAssignment,
  controlChannelBucket,
} from '../src/agent-control-channel.js';

const baseConfig = {
  CONTROL_GATEWAY_PUBLIC_HOST: 'gateway-eu.example.com',
  CONTROL_GATEWAY_PUBLIC_PORT: 4443,
  CONTROL_GATEWAY_TLS_SERVER_NAME: 'gateway-eu.example.com',
  AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: 10_000,
  AGENT_CONTROL_FALLBACK_POLL_SECONDS: 120,
};

test('machine rollout bucket is deterministic and bounded', () => {
  const first = controlChannelBucket('machine_00000001');
  const second = controlChannelBucket('machine_00000001');
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 10_000);
});

test('zero rollout fails closed without publishing an endpoint', () => {
  const assignment = controlChannelAssignment('machine_00000001', {
    ...baseConfig,
    AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: 0,
  });
  assert.deepEqual(assignment, {
    enabled: false,
    protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
    fallbackPollSeconds: 120,
  });
  assert.equal('host' in assignment, false);
});

test('enabled assignment contains transport coordinates only', () => {
  const assignment = controlChannelAssignment('machine_00000001', baseConfig);
  assert.deepEqual(assignment, {
    enabled: true,
    protocolVersion: 1,
    fallbackPollSeconds: 120,
    host: 'gateway-eu.example.com',
    port: 4443,
    serverName: 'gateway-eu.example.com',
  });
  const serialized = JSON.stringify(assignment).toLowerCase();
  for (const forbidden of ['owner', 'email', 'token', 'wallet', 'billing']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('rollout threshold is stable and monotonic for each machine', () => {
  const machineId = 'machine_00000001';
  const bucket = controlChannelBucket(machineId);
  assert.equal(controlChannelAssignment(machineId, {
    ...baseConfig,
    AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: bucket,
  }).enabled, false);
  assert.equal(controlChannelAssignment(machineId, {
    ...baseConfig,
    AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: Math.min(10_000, bucket + 1),
  }).enabled, true);
});
