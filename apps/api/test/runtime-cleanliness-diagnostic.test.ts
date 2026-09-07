import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { QuarantineReasonCode } from '@prisma/client';
import { evaluateDiagnosticChecks, type DiagnosticCheck } from '../src/diagnostic-run-service.js';

const measuredAt = '2026-09-07T19:00:00.000Z';

function pass(name: string): DiagnosticCheck {
  return { name, status: 'PASS', value: 'ok', details: 'ok', measuredAt, source: 'server' };
}

const oldMandatory = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation'];

test('an old agent with no runtimeCleanup proof cannot clear quarantine', () => {
  const evaluation = evaluateDiagnosticChecks(oldMandatory.map(pass));
  assert.equal(evaluation.allMandatoryPass, false);
  assert.equal(evaluation.failingChecks[0]?.name, 'runtimeCleanup');
  assert.equal(evaluation.failingChecks[0]?.status, 'NOT_CHECKED');
  assert.equal(evaluation.reasonCode, QuarantineReasonCode.WORKSPACE_CLEANUP_FAILED);
});

test('runtime cleanup failure maps to WORKSPACE_CLEANUP_FAILED', () => {
  const checks = [
    pass('agent'), pass('gpu'), pass('gpuUuid'), pass('driver'), pass('docker'), pass('nvidiaRuntime'),
    { ...pass('runtimeCleanup'), status: 'FAIL' as const, value: '1 ressource inattendue' },
    pass('allocation'),
  ];
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.allMandatoryPass, false);
  assert.deepEqual(evaluation.failingChecks.map((check) => check.name), ['runtimeCleanup']);
  assert.equal(evaluation.reasonCode, QuarantineReasonCode.WORKSPACE_CLEANUP_FAILED);
});

test('runtime cleanliness plus every existing mandatory check can pass', () => {
  const checks = [
    pass('agent'), pass('gpu'), pass('gpuUuid'), pass('driver'), pass('docker'), pass('nvidiaRuntime'),
    pass('runtimeCleanup'), pass('allocation'),
  ];
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.allMandatoryPass, true);
  assert.deepEqual(evaluation.failingChecks, []);
});

test('diagnostic wiring derives runtime cleanliness server-side from bounded evidence', async () => {
  const routes = await readFile(new URL('../src/machine-diagnostics-routes.ts', import.meta.url), 'utf8');
  const agent = await readFile(new URL('../../../agent/gpubnb_agent/cli.py', import.meta.url), 'utf8');
  const inventory = await readFile(new URL('../../../agent/gpubnb_agent/runtime_cleanliness.py', import.meta.url), 'utf8');

  assert.match(routes, /expectedRuntimeSessionIds/);
  assert.match(routes, /unexpectedContainers: z\.array\([^\n]+\)\.max\(64\)/);
  assert.match(routes, /name: 'runtimeCleanup'/);
  assert.match(routes, /unexpectedRuntimeResources\.length === 0 \? 'PASS' : 'FAIL'/);
  assert.doesNotMatch(routes, /runtimeCleanliness\.clean/);

  assert.match(agent, /inspect_runtime_cleanliness/);
  assert.match(agent, /runtime_expectation_supplied/);
  assert.match(agent, /runtimeCleanliness/);

  assert.match(inventory, /names_for_session/);
  assert.match(inventory, /proxy_name_for_session/);
  assert.match(inventory, /network_name_for_session/);
  assert.doesNotMatch(inventory, /\["rm"|\["volume", "rm"|\["network", "rm"/);
  assert.doesNotMatch(inventory, /"clean"\s*:/);
});
