import assert from 'node:assert/strict';
import test from 'node:test';

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

function captureSql() {
  let captured: any;
  const db = {
    $queryRaw: async (query: any) => {
      captured = query;
      return [];
    },
  } as any;
  return {
    db,
    text: () => {
      assert.ok(captured, 'expected a Prisma SQL query to be captured');
      assert.ok(Array.isArray(captured.strings), 'expected Prisma SQL strings');
      return captured.strings.join('?').replace(/\s+/g, ' ').trim();
    },
  };
}

test('machine discovery blocks later fast-path sequences behind any earlier live command', async () => {
  const capture = captureSql();
  await gatewayCommandMachineIds(capture.db, 50);
  const sql = capture.text();

  assert.match(sql, /NOT EXISTS \( SELECT 1 FROM "MachineCommand" prior/);
  assert.match(sql, /prior\."machineId" = command\."machineId"/);
  assert.match(sql, /prior\."sequence" < command\."sequence"/);
  assert.match(sql, /prior\."status" IN \('PENDING', 'LEASED'\)/);
  assert.match(sql, /prior\."expiresAt" > CURRENT_TIMESTAMP/);
});

test('claim is one ordered fast-path command per machine even with a larger requested batch', async () => {
  const capture = captureSql();
  await claimGatewayMachineCommands(
    capture.db,
    'machine_00000001',
    'delivery_worker_0001',
    16,
    15,
  );
  const sql = capture.text();

  assert.match(sql, /prior\."sequence" < command\."sequence"/);
  assert.match(sql, /prior\."status" IN \('PENDING', 'LEASED'\)/);
  assert.match(sql, /prior\."expiresAt" > CURRENT_TIMESTAMP/);
  assert.match(sql, /ORDER BY command\."sequence" LIMIT LEAST\(\?, 1\) FOR UPDATE SKIP LOCKED/);
});
