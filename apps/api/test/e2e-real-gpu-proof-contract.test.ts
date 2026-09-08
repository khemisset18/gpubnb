import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

async function source(): Promise<string> {
  return readFile(path.join(repoRoot, 'e2e/run.cjs'), 'utf8');
}

test('real E2E rental observes the Developer workspace created automatically by GPU_PROOF finalization', async () => {
  const e2e = await source();
  const proofRoute = e2e.indexOf('`${API}/bookings/${booking.id}/workspace-sessions`');
  const proofWait = e2e.indexOf("waitUntil('GPU_PROOF completes and finalizes'");
  const developerLookup = e2e.indexOf("machineWorkspace: { workspace: { slug: 'developer' } }");

  assert.ok(proofRoute >= 0, 'E2E must request the production Compute preparation route');
  assert.ok(proofWait > proofRoute, 'E2E must wait for the real GPU_PROOF job created by that route');
  assert.ok(developerLookup > proofWait, 'E2E must discover the auto-created Developer session after GPU_PROOF');
  assert.match(e2e, /workspaceSlug: 'compute'/);
  assert.match(e2e, /type: 'GPU_PROOF'/);
  assert.match(e2e, /proofResult\.gpuDetected !== true \|\| proofResult\.metrics\?\.containerCleaned !== true/);
  assert.match(e2e, /current\.job\?\.type !== 'WORKSPACE_PREPARE'/);
  assert.doesNotMatch(e2e, /fetch\([^\n]*workspace\/developer/);
});

test('GPU_PROOF completion must leave the rental reserved for subsequent Developer activation', async () => {
  const e2e = await source();
  assert.match(e2e, /bookingAfterProof\.status === 'FUNDED'/);
  assert.match(e2e, /bookingAfterProof\.status !== 'STARTING'/);
  assert.match(e2e, /bookingAfterProof\.workspaceActivatedAt !== null/);
  assert.match(e2e, /GPU_PROOF must keep the booking reserved for Developer activation/);
});

test('onboarding bootstrap is explicitly excluded from rental qualification', async () => {
  const e2e = await source();
  assert.match(e2e, /bootstrap is not accepted as rental\s+\/\/ qualification/);
  assert.doesNotMatch(e2e, /This harness doesn't run that separate Compute diagnostic job/);
});
