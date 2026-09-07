import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactStorageError,
  FilesystemArtifactStorage,
  buildArtifactObjectKey,
  validateArtifactKind,
} from '../src/artifact-storage.js';

test('artifact kind only allows a single safe path segment', () => {
  for (const valid of ['result', 'stdout.txt', 'gpu-proof_1']) {
    assert.equal(validateArtifactKind(valid), valid);
  }
  for (const invalid of ['../escape', '..', 'a/b', 'a\\b', '', 'with space']) {
    assert.throws(() => validateArtifactKind(invalid), ArtifactStorageError);
  }
});

test('artifact object key is deterministic and path-safe', () => {
  const sha = 'a'.repeat(64);
  assert.equal(buildArtifactObjectKey('job_123', 'result', sha), `job_123/result/${sha}`);
  assert.throws(() => buildArtifactObjectKey('../job', 'result', sha), /invalid_artifact_job_id/);
});

test('filesystem backend writes backend-aware keys and reads legacy keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-artifacts-'));
  try {
    const storage = new FilesystemArtifactStorage(root);
    const sha = 'b'.repeat(64);
    const data = Buffer.from('gpu-result');
    const storageKey = await storage.write('job123', 'result', sha, data);
    assert.equal(storageKey, `fs:job123/result/${sha}`);
    assert.deepEqual(await storage.read(storageKey), data);
    assert.deepEqual(await storage.read(`job123/result/${sha}`), data, 'legacy unprefixed keys must remain readable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem backend rejects path escape and unknown backend', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-artifacts-'));
  try {
    const storage = new FilesystemArtifactStorage(root);
    await assert.rejects(() => storage.read('../outside'), /artifact_path_escape/);
    await assert.rejects(() => storage.read('s3:bucket/key'), /unsupported_artifact_storage_backend/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
