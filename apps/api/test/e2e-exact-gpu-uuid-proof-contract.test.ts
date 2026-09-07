import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

test('main real-GPU harness proves the Developer container sees exactly the leased hardware UUID', async () => {
  const shell = await readFile(path.join(repoRoot, 'e2e/run.sh'), 'utf8');
  const proof = await readFile(path.join(repoRoot, 'e2e/watch-exact-gpu-uuid.cjs'), 'utf8');

  const watcher = shell.indexOf('node watch-exact-gpu-uuid.cjs "$DATABASE_URL"');
  const scenario = shell.indexOf('node run.cjs setup');
  const wait = shell.indexOf('wait "$UUID_PROOF_PID"');
  assert.ok(watcher >= 0 && watcher < scenario && wait > scenario, 'UUID proof must observe the live workspace concurrently and be awaited before success');

  for (const required of [
    "machineWorkspace: { workspace: { slug: 'developer' } }",
    "status: { in: ['PREPARING', 'READY', 'RUNNING'] }",
    "status: { in: ['HELD', 'CONFIRMED', 'ACTIVE'] }",
    'releasedAt: null',
    'allocations.length !== 1',
    "'--query-gpu=uuid'",
    "'--format=csv,noheader'",
    'visibleUuids.length !== 1 || visibleUuids[0] !== leasedGpuUuid',
    'accelerator: { select: { hardwareUuid: true } }',
    '[exact-gpu-uuid-proof] PASS',
  ]) {
    assert.ok(proof.includes(required), `exact GPU UUID proof is missing: ${required}`);
  }
});
