import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workerSource = readFile(new URL('../src/delivery-worker.ts', import.meta.url), 'utf8');
const rentalSource = readFile(new URL('../src/rental-resource-routes.ts', import.meta.url), 'utf8');

test('delivery worker keeps mining claims behind the dedicated rollout while rental remains generic', async () => {
  const source = await workerSource;
  assert.match(source, /gatewayCommandMachineIds\(db, 100, dispatchConfig\.miningRolloutBps > 0\)/);
  assert.match(source, /const allowMining = miningCommandGatewayAssigned\(machineId, dispatchConfig\)/);
  assert.match(source, /claimGatewayMachineCommands\(db, machineId, workerId, 16, 15, allowMining\)/);
  assert.match(source, /if \(!commandGatewayAssigned\(machineId, dispatchConfig\)\) continue/);
});

test('rental cleanup never auto-resumes mining from the generic MachineCommand rollout alone', async () => {
  const source = await rentalSource;
  assert.match(source, /miningCommandGatewayAssigned\(machineId, commandDispatchConfigFromEnv\(\)\)/);
  const gate = source.indexOf('if (!remoteControlEnabled)');
  const resume = source.indexOf('requestSystemMiningAutoResume(db, redis, {');
  assert.ok(gate >= 0 && resume > gate, 'mining rollout gate must precede auto-resume production');
  assert.match(source, /Preserve resumeAfterRentalPending/);
});
