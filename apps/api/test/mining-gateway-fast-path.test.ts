import assert from 'node:assert/strict';
import test from 'node:test';

import { productionGatewayCommandEligible } from '../src/gateway-command-store.js';

const fenced = {
  lease: {
    resourceId: 'resource_00000001',
    holderId: 'mining_resource_00000001',
    leaseId: 'lease_000000001',
    fencingToken: '9',
  },
  payload: {
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    runtimeGeneration: '9',
  },
};

test('production gateway eligibility includes only fenced mining commands', () => {
  assert.equal(productionGatewayCommandEligible('start_mining', fenced), true);
  assert.equal(productionGatewayCommandEligible('stop_mining', fenced), true);
  assert.equal(productionGatewayCommandEligible('start_mining', { payload: fenced.payload }), false);
  assert.equal(productionGatewayCommandEligible('stop_mining', { lease: fenced.lease, payload: { ...fenced.payload, runtimeGeneration: '10' } }), false);
  assert.equal(productionGatewayCommandEligible('prepare_rental', fenced), false);
});

test('Developer stop rental remains the only rental command on this fast path', () => {
  assert.equal(productionGatewayCommandEligible('stop_rental', { workspaceSlug: 'developer' }), true);
  assert.equal(productionGatewayCommandEligible('stop_rental', { workspaceSlug: 'compute' }), false);
  assert.equal(productionGatewayCommandEligible('start_rental', { workspaceSlug: 'developer' }), false);
});