import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';

import {
  claimGatewayMachineCommands,
  gatewayCommandMachineIds,
  productionGatewayCommandEligible,
} from '../src/gateway-command-store.js';

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

function queryCapturingDb() {
  const queries: string[] = [];
  const db = {
    $queryRaw: async (query: { sql?: string; strings?: readonly string[] }) => {
      queries.push(query.sql ?? (query.strings ?? []).join('?'));
      return [];
    },
  } as unknown as PrismaClient;
  return { db, queries };
}

test('gateway discovery only exposes the earliest active fast-path command per machine', async () => {
  const { db, queries } = queryCapturingDb();
  await gatewayCommandMachineIds(db);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /NOT EXISTS/);
  assert.match(queries[0], /prior\."machineId" = command\."machineId"/);
  assert.match(queries[0], /prior\."sequence" < command\."sequence"/);
  assert.match(queries[0], /prior\."status" IN \('PENDING', 'LEASED'\)/);
  assert.match(queries[0], /prior\."expiresAt" > CURRENT_TIMESTAMP/);
});

test('gateway claim cannot skip a lower active fast-path sequence under concurrent workers', async () => {
  const { db, queries } = queryCapturingDb();
  await claimGatewayMachineCommands(db, 'machine_00000001', 'worker_00000001');
  assert.equal(queries.length, 1);
  assert.match(queries[0], /NOT EXISTS/);
  assert.match(queries[0], /prior\."sequence" < command\."sequence"/);
  assert.match(queries[0], /FOR UPDATE SKIP LOCKED/);
});


test('rental fast path remains claimable while mining rollout is disabled', async () => {
  const discovery = queryCapturingDb();
  await gatewayCommandMachineIds(discovery.db, 100, false);
  assert.match(discovery.queries[0], /stop_rental/);
  assert.doesNotMatch(discovery.queries[0], /start_mining|stop_mining/);

  const claim = queryCapturingDb();
  await claimGatewayMachineCommands(claim.db, 'machine_00000001', 'worker_00000001', 16, 15, false);
  assert.match(claim.queries[0], /stop_rental/);
  assert.doesNotMatch(claim.queries[0], /start_mining|stop_mining/);
  assert.match(claim.queries[0], /prior\."commandType" = 'stop_rental'/);
});
