import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { registerArtifactTransportGuards } from '../src/artifact-transport-guards.js';

const machineId = 'cjld2cjxh0000qzrmn831i7rn';
const sha256 = 'a'.repeat(64);

async function artifactTestApp() {
  const app = Fastify();
  registerArtifactTransportGuards(app);
  app.post('/jobs/:id/artifacts', async (request) => ({
    ok: true,
    binary: Buffer.isBuffer(request.body),
    sizeBytes: Buffer.isBuffer(request.body) ? request.body.length : -1,
  }));
  await app.ready();
  return app;
}

function artifactUrl(kind: string, sizeBytes: number): string {
  const query = new URLSearchParams({ machineId, kind, sha256, sizeBytes: String(sizeBytes) });
  return `/jobs/job-1/artifacts?${query.toString()}`;
}

test('application/octet-stream is parsed as a Buffer for artifact uploads', async (t) => {
  const app = await artifactTestApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: artifactUrl('result', 3),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('abc'),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, binary: true, sizeBytes: 3 });
});

test('artifact kind must be a single safe path segment', async (t) => {
  const app = await artifactTestApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: artifactUrl('../escape', 3),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('abc'),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'invalid_artifact_metadata' });
});

test('declared artifact size must match the authenticated binary body', async (t) => {
  const app = await artifactTestApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: artifactUrl('result', 999),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('abc'),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'artifact_size_mismatch' });
});

test('artifact route rejects non-binary parsed bodies', async (t) => {
  const app = await artifactTestApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: artifactUrl('result', 2),
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'binary_body_required' });
});
