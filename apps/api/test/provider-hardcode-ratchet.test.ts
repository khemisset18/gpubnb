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

test('active web/build/deployment configuration contains no Render API or gateway hardcodes', async () => {
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

  assert.deepEqual(
    matches.sort(),
    [],
    `active provider hardcode detected; public origins must come from build/deployment configuration instead: ${matches.join(', ')}`,
  );
});
