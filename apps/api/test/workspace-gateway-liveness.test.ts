import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_GATEWAY_LIVENESS_MAX_AGE_SECONDS,
  isWorkspaceGatewayLive,
} from '../src/workspace-gateway-liveness.js';

test('workspace gateway liveness tolerates several missed 10s reports but expires stale registrations', () => {
  const now = new Date('2026-09-07T00:00:45.000Z');

  assert.equal(WORKSPACE_GATEWAY_LIVENESS_MAX_AGE_SECONDS, 45);
  assert.equal(isWorkspaceGatewayLive(new Date('2026-09-07T00:00:01.000Z'), now), true);
  assert.equal(isWorkspaceGatewayLive(new Date('2026-09-07T00:00:00.000Z'), now), true);
  assert.equal(isWorkspaceGatewayLive(new Date('2026-09-06T23:59:59.999Z'), now), false);
  assert.equal(isWorkspaceGatewayLive(null, now), false);
});

test('future gateway timestamps are fail-closed', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  assert.equal(isWorkspaceGatewayLive(new Date('2026-09-07T00:00:00.001Z'), now), false);
});
