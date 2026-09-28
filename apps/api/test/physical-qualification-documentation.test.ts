import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

async function read(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

test('historical two-machine result cannot be mistaken for current release qualification', async () => {
  const historical = await read('docs/BETA_TEST_TWO_MACHINES_RESULT.md');
  assert.match(historical, /PREUVE HISTORIQUE UNIQUEMENT/);
  assert.match(historical, /PAS UNE QUALIFICATION DE LA RELEASE ACTUELLE/);
  assert.match(historical, /GPU_PROOF/);
  assert.match(historical, /WORKSPACE_PREPARE/);
  assert.match(historical, /CURRENT_PHYSICAL_QUALIFICATION\.md/);
});

test('current physical qualification records the beta.85 Host/Workspace pass without overstating the deployment lock', async () => {
  const current = await read('docs/CURRENT_PHYSICAL_QUALIFICATION.md');
  const baseline = await read('docs/PHYSICAL_BASELINE_2026-09-11_BETA85.md');

  assert.match(
    current,
    /HOST\/WORKSPACE PHYSICAL BASELINE PASSED on `host-v0\.2\.0-beta\.85` \/ Agent `0\.6\.6`; full all-component release identity lock remains pending/,
  );

  for (const required of [
    '4615a880752a8a97c161c4a37f0f50bf6f1bca03',
    'baseline/physical-pass-beta85-2026-09-11',
    'GPU_PROOF',
    'Ouvrir mon espace',
    'nvidia-smi',
    'runtime-cleanliness',
    'Git commit SHA',
    'workspace session ID',
    'leased accelerator hardware UUID',
    'full all-component deployment lock',
  ]) {
    assert.ok(current.includes(required), `current physical qualification contract is missing: ${required}`);
  }

  for (const required of [
    'host-v0.2.0-beta.85',
    'Agent version: `0.6.6`',
    '4615a880752a8a97c161c4a37f0f50bf6f1bca03',
    'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
    'NVIDIA GeForce GTX 1650',
    '592.82',
    '4096 MiB',
    'gpubnb-dev-*',
    'gpubnb-dev-proxy-*',
    'gpubnb-workspace-*',
    'gpubnb-workspace-internal-*',
    'No ProgramData deletion',
    '#190',
    '#191',
  ]) {
    assert.ok(baseline.includes(required), `beta.85 physical baseline is missing: ${required}`);
  }

  assert.match(baseline, /not a claim that every fault-injection scenario or every deployment component has been requalified/i);
  assert.match(baseline, /did not independently re-capture a complete API\/frontend deployment identity bundle/i);
});
