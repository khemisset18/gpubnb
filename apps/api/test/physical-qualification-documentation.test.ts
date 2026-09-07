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

test('current physical qualification remains fail-closed until the real two-PC flow is proven', async () => {
  const current = await read('docs/CURRENT_PHYSICAL_QUALIFICATION.md');
  assert.match(current, /Status: \*\*NOT YET PASSED for the current release\*\*/);
  for (const required of [
    'GPU_PROOF',
    'Ouvrir mon espace',
    'nvidia-smi',
    'runtime-cleanliness',
    'Git commit SHA',
    'workspace session ID',
    'leased accelerator hardware UUID',
    'Automated qualification is green, but current-release physical PC A ↔ PC B qualification is pending',
  ]) {
    assert.ok(current.includes(required), `current physical qualification contract is missing: ${required}`);
  }
});
