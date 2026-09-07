import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { FilesystemArtifactStorage, S3ArtifactStorage } from '../src/artifact-storage.js';
import { migrateArtifactsToS3, type ArtifactMigrationRepository, type ArtifactMigrationRow } from '../src/artifact-storage-migration.js';

const enabled = process.env.ARTIFACT_S3_INTEGRATION === '1';

test('historical filesystem artifact migrates through a real S3-compatible server', { skip: !enabled }, async () => {
  const endpoint = process.env.ARTIFACT_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
  const region = process.env.ARTIFACT_S3_REGION ?? 'us-east-1';
  const accessKeyId = process.env.ARTIFACT_S3_ACCESS_KEY_ID ?? 'gpubnb-ci-access';
  const secretAccessKey = process.env.ARTIFACT_S3_SECRET_ACCESS_KEY ?? 'gpubnb-ci-secret-key';
  const bucket = `gpubnb-migrate-${Date.now()}`;
  const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-s3-'));
  const source = new FilesystemArtifactStorage(root);
  const destination = new S3ArtifactStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, client });
  const data = Buffer.from('historical-gpubnb-artifact');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const oldStorageKey = await source.write('job_migrate', 'result', sha256, data);
  const row: ArtifactMigrationRow = {
    id: 'artifact_migrate',
    jobId: 'job_migrate',
    kind: 'result',
    sha256,
    sizeBytes: data.length,
    storageKey: oldStorageKey,
  };
  const repository: ArtifactMigrationRepository = {
    async listCandidates() { return [{ ...row }]; },
    async updateStorageKeyIfUnchanged(id, expected, replacement) {
      if (id !== row.id || row.storageKey !== expected) return false;
      row.storageKey = replacement;
      return true;
    },
  };

  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  try {
    const summary = await migrateArtifactsToS3({ repository, source, destination, mode: 'apply' });
    assert.equal(summary.failed, 0);
    assert.equal(summary.copied, 1);
    assert.equal(summary.updated, 1);
    assert.equal(summary.verified, 2);
    assert.equal(row.storageKey, `s3:${bucket}/job_migrate/result/${sha256}`);
    assert.deepEqual(await destination.read(row.storageKey), data);
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `job_migrate/result/${sha256}` })).catch(() => undefined);
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    client.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
