import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else files.push(full);
  }
  return files;
}

test('no new Render API/gateway hardcodes are added while legacy deployment drift is being removed', async () => {
  const roots = [
    path.join(repoRoot, 'apps/web'),
    path.join(repoRoot, 'scripts'),
    path.join(repoRoot, '.github/workflows'),
  ];
  const files = [
    path.join(repoRoot, 'netlify.toml'),
    ...(await Promise.all(roots.map(listFiles))).flat(),
  ];

  const matches: string[] = [];
  for (const file of files) {
    if (!/\.(?:js|mjs|cjs|ts|toml|yml|yaml|html)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    if (source.includes('gpubnb.onrender.com') || source.includes('.onrender.com')) {
      matches.push(path.relative(repoRoot, file).replace(/\\/g, '/'));
    }
  }

  // These are known legacy/provider-coupled locations from the current repository.
  // They are a removal list, not approved architecture. Remove an entry when that
  // file becomes provider-neutral. Any NEW location fails this test immediately.
  const legacyLocations = [
    '.github/workflows/deployment-readiness.yml',
    'apps/web/config.js',
    'apps/web/netlify.toml',
    'apps/web/workspace-developer-flow.test.js',
    'netlify.toml',
    'scripts/generate-web-build-info.mjs',
  ];

  assert.deepEqual(
    matches.sort(),
    legacyLocations.sort(),
    `provider hardcode drift changed; migrate/remove legacy entries deliberately instead of adding a new hosting-vendor dependency: ${matches.join(', ')}`,
  );
});
