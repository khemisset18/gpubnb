import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const atRoot = (name: string) => path.join(repoRoot, name);

const legacyRootCopies = [
  'server.ts',
  'auth.ts',
  'config.ts',
  'settlement.ts',
  'tsconfig.json',
  'index.html',
  'app.js',
  'config.js',
  'styles.css',
];

test('maintained API and web sources have no executable legacy copies at repository root', async () => {
  for (const file of legacyRootCopies) {
    await assert.rejects(
      () => access(atRoot(file)),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT'),
      `${file} must not be reintroduced at repository root; use apps/api or apps/web`,
    );
  }
});

test('repository entry points route to maintained API and web trees', async () => {
  const packageJson = JSON.parse(await readFile(atRoot('package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.dev, 'npm --prefix apps/api run dev');
  assert.equal(packageJson.scripts.build, 'npm --prefix apps/api run build');
  assert.equal(packageJson.scripts.start, 'npm --prefix apps/api run start');
  assert.equal(packageJson.scripts.test, 'npm --prefix apps/api run test');

  const netlify = await readFile(atRoot('netlify.toml'), 'utf8');
  assert.match(netlify, /publish = "apps\/web"/);

  const topology = JSON.parse(await readFile(atRoot('deploy/runtime-processes.json'), 'utf8')) as {
    image: { dockerfile: string };
    processes: { api: { command: string }; 'delivery-worker': { command: string } };
  };
  assert.equal(topology.image.dockerfile, 'apps/api/Dockerfile');
  assert.equal(topology.processes.api.command, 'node dist/server.js');
  assert.equal(topology.processes['delivery-worker'].command, 'node dist/delivery-worker.js');
});

test('root agent.py remains an explicit compatibility launcher, not a duplicate implementation', async () => {
  const launcher = await readFile(atRoot('agent.py'), 'utf8');
  assert.match(launcher, /Compatibility launcher/);
  assert.match(launcher, /agent_dir \/ "agent\.py"/);
  assert.doesNotMatch(launcher, /class\s+GpuBnbAgent/);
});
