import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDiagnosticChecks, type DiagnosticCheck } from '../src/diagnostic-run-service.js';

const now = new Date('2026-09-01T00:00:00.000Z').toISOString();

function check(name: string, status: DiagnosticCheck['status'], source: DiagnosticCheck['source'] = 'agent-heartbeat'): DiagnosticCheck {
  return { name, status, value: null, details: '', measuredAt: now, source };
}

const allPass = (): DiagnosticCheck[] => [
  check('agent', 'PASS'),
  check('gpu', 'PASS'),
  check('gpuUuid', 'PASS'),
  check('driver', 'PASS'),
  check('docker', 'PASS'),
  check('nvidiaRuntime', 'PASS'),
  check('cuda', 'PASS'),
  check('ram', 'PASS'),
];

test('a fully passing diagnostic clears the mandatory-check gate', () => {
  const evaluation = evaluateDiagnosticChecks(allPass());
  assert.equal(evaluation.allMandatoryPass, true);
  assert.deepEqual(evaluation.failingChecks, []);
});

test('a FAIL on a mandatory check (GPU) blocks the gate and never gets silently treated as PASS', () => {
  const checks = allPass().map((c) => (c.name === 'gpu' ? check('gpu', 'FAIL') : c));
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.allMandatoryPass, false);
  assert.equal(evaluation.failingChecks.some((c) => c.name === 'gpu'), true);
  assert.equal(evaluation.reasonCode, 'GPU_UNAVAILABLE');
});

test('an UNKNOWN mandatory check is exactly as blocking as FAIL - never promoted to PASS', () => {
  const checks = allPass().map((c) => (c.name === 'docker' ? check('docker', 'UNKNOWN') : c));
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.allMandatoryPass, false);
  assert.equal(evaluation.failingChecks.some((c) => c.name === 'docker'), true);
  assert.equal(evaluation.reasonCode, 'DOCKER_UNAVAILABLE');
});

test('a mandatory check entirely missing from the report is treated as NOT_CHECKED, not as an implicit PASS', () => {
  const checks = allPass().filter((c) => c.name !== 'nvidiaRuntime');
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.allMandatoryPass, false);
  const missing = evaluation.failingChecks.find((c) => c.name === 'nvidiaRuntime');
  assert.ok(missing);
  assert.equal(missing!.status, 'NOT_CHECKED');
});

test('RAM and CUDA are informational only - a WARNING/FAIL on either never blocks the mandatory gate', () => {
  const checks = allPass().map((c) => (c.name === 'ram' ? check('ram', 'WARNING') : c.name === 'cuda' ? check('cuda', 'FAIL') : c));
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.allMandatoryPass, true, 'RAM/CUDA are workspace-compatibility signals, not machine-health blockers');
});

test('the first failing mandatory check (in fixed order) determines the reasonCode', () => {
  const checks = allPass().map((c) => (['gpu', 'docker'].includes(c.name) ? check(c.name, 'FAIL') : c));
  const evaluation = evaluateDiagnosticChecks(checks);
  assert.equal(evaluation.reasonCode, 'GPU_UNAVAILABLE', 'gpu is earlier than docker in MANDATORY_CHECK_NAMES');
});
