import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactStorageError,
  FilesystemArtifactStorage,
  RoutedArtifactStorage,
  S3ArtifactStorage,
  buildArtifactObjectKey,
  validateArtifactKind,
} from '../src/artifact-storage.js';

test('artifact kind only allows a single safe path segment', () => {
  for (const valid of ['result', 'stdout.txt', 'gpu-proof_1']) {
    assert.equal(validateArtifactKind(valid), valid);
  }
  for (const invalid of ['../escape', '..', '.', 'a/b', 'a\\b', '', 'with space']) {
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

test('S3 backend writes deterministic backend-aware keys and reads object bodies', async () => {
  const calls: Array<{ input?: Record<string, unknown>; name: string }> = [];
  const data = Buffer.from('durable-gpu-result');
  const client = {
    async send(command: { input?: Record<string, unknown>; constructor: { name: string } }) {
      calls.push({ input: command.input, name: command.constructor.name });
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
      }
      return {};
    },
  } as never;
  const storage = new S3ArtifactStorage({
    endpoint: 'https://project.storage.supabase.co/storage/v1/s3',
    region: 'local',
    bucket: 'gpubnb-artifacts',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    client,
  });
  const sha = 'c'.repeat(64);
  const key = await storage.write('job123', 'result', sha, data);
  assert.equal(key, `s3:gpubnb-artifacts/job123/result/${sha}`);
  assert.equal(calls[0]?.name, 'PutObjectCommand');
  assert.equal(calls[0]?.input?.Bucket, 'gpubnb-artifacts');
  assert.equal(calls[0]?.input?.Key, `job123/result/${sha}`);
  assert.deepEqual(await storage.read(key), data);
  assert.equal(calls[1]?.name, 'GetObjectCommand');
});

test('S3 backend refuses cross-bucket and malformed object keys', async () => {
  const storage = new S3ArtifactStorage({
    endpoint: 'https://project.storage.supabase.co/storage/v1/s3',
    region: 'local',
    bucket: 'gpubnb-artifacts',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    client: { send: async () => ({}) } as never,
  });
  await assert.rejects(
    () => storage.read('s3:another-bucket/job123/result/' + 'd'.repeat(64)),
    /artifact_bucket_mismatch/,
  );
  await assert.rejects(
    () => storage.read('s3:gpubnb-artifacts/job123/../' + 'd'.repeat(64)),
    /invalid_artifact_storage_key/,
  );
  await assert.rejects(
    () => storage.read('s3:gpubnb-artifacts/job123/result/not-a-sha'),
    /invalid_artifact_storage_key/,
  );
});

test('S3 backend maps object-store 404 to the API storage-not-found contract', async () => {
  const storage = new S3ArtifactStorage({
    endpoint: 'https://project.storage.supabase.co/storage/v1/s3',
    region: 'local',
    bucket: 'gpubnb-artifacts',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    client: {
      send: async () => {
        const error = Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        throw error;
      },
    } as never,
  });
  await assert.rejects(
    () => storage.read('s3:gpubnb-artifacts/job123/result/' + 'f'.repeat(64)),
    (error: unknown) => error instanceof ArtifactStorageError && error.code === 'ENOENT',
  );
});

test('routed storage keeps legacy filesystem reads after S3 write cutover', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-artifacts-'));
  try {
    const filesystem = new FilesystemArtifactStorage(root);
    const oldSha = 'e'.repeat(64);
    const oldData = Buffer.from('legacy');
    const oldKey = await filesystem.write('job-old', 'result', oldSha, oldData);
    const s3 = new S3ArtifactStorage({
      endpoint: 'https://project.storage.supabase.co/storage/v1/s3',
      region: 'local',
      bucket: 'gpubnb-artifacts',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      client: { send: async () => ({}) } as never,
    });
    const routed = new RoutedArtifactStorage(s3, filesystem, s3);
    assert.deepEqual(await routed.read(oldKey), oldData);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
