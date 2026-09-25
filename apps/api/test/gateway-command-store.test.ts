import assert from 'node:assert/strict';
import test from 'node:test';

import { productionGatewayCommandEligible } from '../src/gateway-command-store.js';

const fenced = (generation = '17') => ({
  lease: {
    resourceId: 'resource_00000001',
    holderId: 'mining_resource_00000001',
    leaseId: 'lease_000000001',
    fencingToken: generation,
  },
  payload: {
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    runtimeGeneration: generation,
  },
});

test('production fast path accepts direct Developer stop and exact fenced mining', () => {
  assert.equal(productionGatewayCommandEligible('stop_rental', { workspaceSlug: 'developer' }), true);
  assert.equal(productionGatewayCommandEligible('start_mining', fenced()), true);
  assert.equal(productionGatewayCommandEligible('stop_mining', fenced()), true);
});

test('production fast path keeps unfenced or mismatched mining dark', () => {
  assert.equal(productionGatewayCommandEligible('start_mining', { resourceId: 'resource_00000001' }), false);
  assert.equal(productionGatewayCommandEligible('stop_mining', {
    ...fenced(),
    payload: { ...fenced().payload, runtimeGeneration: '18' },
  }), false);
  assert.equal(productionGatewayCommandEligible('start_mining', {
    ...fenced(),
    lease: { ...fenced().lease, resourceId: 'resource_00000002' },
  }), false);
  assert.equal(productionGatewayCommandEligible('start_mining', {
    ...fenced(),
    payload: { ...fenced().payload, hardwareUuid: '' },
  }), false);
  assert.equal(productionGatewayCommandEligible('prepare_rental', fenced()), false);
});

test('non-Developer rental stops remain outside the direct production path', () => {
  assert.equal(productionGatewayCommandEligible('stop_rental', { workspaceSlug: 'compute' }), false);
});