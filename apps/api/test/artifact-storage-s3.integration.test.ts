import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3ArtifactStorage } from '../src/artifact-storage.js';

const enabled = process.env.ARTIFACT_S3_INTEGRATION === '1';

test('S3-compatible backend performs a real put/get round trip', { skip: !enabled }, async () => {
  const endpoint = process.env.ARTIFACT_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
  const region = process.env.ARTIFACT_S3_REGION ?? 'us-east-1';
  const accessKeyId = process.env.ARTIFACT_S3_ACCESS_KEY_ID ?? 'gpubnb-ci-access';
  const secretAccessKey = process.env.ARTIFACT_S3_SECRET_ACCESS_KEY ?? 'gpubnb-ci-secret-key';
  const bucket = `gpubnb-ci-${Date.now()}`;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const storage = new S3ArtifactStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, client });
  const sha = 'a'.repeat(64);
  const data = Buffer.from('gpubnb-real-s3-roundtrip');
  const objectKey = `job123/result/${sha}`;

  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  try {
    const storageKey = await storage.write('job123', 'result', sha, data);
    assert.equal(storageKey, `s3:${bucket}/${objectKey}`);
    assert.deepEqual(await storage.read(storageKey), data);
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => undefined);
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    client.destroy();
  }
});
