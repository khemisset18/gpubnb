import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

test('main real-GPU harness proves exact per-session Docker cleanup before EXIT teardown', async () => {
  const run = await readFile(path.join(repoRoot, 'e2e/run.sh'), 'utf8');
  const proof = await readFile(path.join(repoRoot, 'e2e/verify-runtime-cleanup.cjs'), 'utf8');

  const runCjs = run.indexOf('node run.cjs setup');
  const cleanupProof = run.indexOf('node verify-runtime-cleanup.cjs "$DATABASE_URL"');
  assert.ok(runCjs >= 0 && cleanupProof > runCjs, 'cleanup proof must run after the real E2E orchestrator succeeds');

  for (const required of [
    "developer.status !== 'COMPLETED'",
    "metadata.runtimeId.startsWith('gpubnb-dev-')",
    'runtimeId !== names.container',
    'gpubnb-dev-proxy-',
    'gpubnb-workspace-',
    'gpubnb-workspace-internal-',
    "['ps', '-a', '--format', '{{.Names}}']",
    "['volume', 'ls', '--format', '{{.Name}}']",
    "['network', 'ls', '--format', '{{.Name}}']",
    'per-session Docker cleanup incomplete',
    '[cleanup-proof] PASS',
  ]) {
    assert.ok(proof.includes(required), `cleanup proof is missing: ${required}`);
  }
});
