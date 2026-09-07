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

test('provider-neutral topology requires migration, API and delivery worker roles', async () => {
  const topology = JSON.parse(await read('deploy/runtime-processes.json')) as {
    image: { dockerfile: string; buildContext: string; runtimeUser: string };
    processes: Record<string, {
      kind: string;
      command: string;
      healthPath?: string;
      requires?: string[];
      requiredBefore?: string[];
      responsibilities?: string[];
    }>;
  };

  assert.equal(topology.image.dockerfile, 'apps/api/Dockerfile');
  assert.equal(topology.image.buildContext, '.');
  assert.equal(topology.image.runtimeUser, 'app');

  assert.equal(topology.processes['database-migrate']?.kind, 'one-shot');
  assert.equal(topology.processes['database-migrate']?.command, './node_modules/.bin/prisma migrate deploy');
  assert.deepEqual(topology.processes['database-migrate']?.requiredBefore?.sort(), ['api', 'delivery-worker']);

  assert.equal(topology.processes.api?.kind, 'service');
  assert.equal(topology.processes.api?.command, 'node dist/server.js');
  assert.equal(topology.processes.api?.healthPath, '/ready');
  assert.deepEqual(topology.processes.api?.requires?.sort(), ['postgres', 'redis']);
  assert.ok(topology.processes.api?.responsibilities?.includes('workspace-gateway'));

  assert.equal(topology.processes['delivery-worker']?.kind, 'worker');
  assert.equal(topology.processes['delivery-worker']?.command, 'node dist/delivery-worker.js');
  assert.deepEqual(topology.processes['delivery-worker']?.requires?.sort(), ['postgres', 'redis']);
  assert.ok(topology.processes['delivery-worker']?.responsibilities?.includes('outbox-delivery'));
  assert.ok(topology.processes['delivery-worker']?.responsibilities?.includes('machine-command-delivery'));
});

test('Docker image contains both API and worker build outputs and runs non-root', async () => {
  const dockerfile = await read('apps/api/Dockerfile');
  const packageJson = JSON.parse(await read('apps/api/package.json')) as { scripts?: Record<string, string> };
  const worker = await read('apps/api/src/delivery-worker.ts');

  assert.match(dockerfile, /COPY --from=build \/app\/api\/dist \.\/dist/);
  assert.match(dockerfile, /USER app/);
  assert.equal(packageJson.scripts?.start, 'node dist/server.js');
  assert.equal(packageJson.scripts?.['start:delivery'], 'node dist/delivery-worker.js');
  assert.match(worker, /delivery_worker_started/);
});

test('runtime topology contains no hosting-provider hostname or provider-only process kind', async () => {
  const source = await read('deploy/runtime-processes.json');
  assert.doesNotMatch(source, /onrender\.com|render\.yaml|netlify|fly\.io|railway|heroku/i);
});
