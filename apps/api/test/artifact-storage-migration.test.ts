import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemArtifactStorage, type ArtifactStorage } from '../src/artifact-storage.js';
import { migrateArtifactsToS3, type ArtifactMigrationRepository, type ArtifactMigrationRow } from '../src/artifact-storage-migration.js';

function rowFor(id: string, storageKey: string, data: Buffer): ArtifactMigrationRow {
  return {
    id,
    jobId: `job_${id}`,
    kind: 'result',
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    sizeBytes: data.length,
    storageKey,
  };
}

class MemoryRepository implements ArtifactMigrationRepository {
  constructor(public rows: ArtifactMigrationRow[]) {}
  async listCandidates(limit: number) { return this.rows.slice(0, limit).map((row) => ({ ...row })); }
  async updateStorageKeyIfUnchanged(id: string, oldStorageKey: string, newStorageKey: string) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.storageKey !== oldStorageKey) return false;
    row.storageKey = newStorageKey;
    return true;
  }
}

class MemoryS3Storage implements ArtifactStorage {
  objects = new Map<string, Buffer>();
  constructor(private readonly mutateRead?: (data: Buffer) => Buffer) {}
  async write(jobId: string, kind: string, sha256: string, data: Buffer) {
    const key = `s3:gpubnb-artifacts/${jobId}/${kind}/${sha256}`;
    this.objects.set(key, Buffer.from(data));
    return key;
  }
  async read(storageKey: string) {
    const data = this.objects.get(storageKey);
    if (!data) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const copy = Buffer.from(data);
    return this.mutateRead ? this.mutateRead(copy) : copy;
  }
}

test('dry-run verifies source but never writes destination or DB', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-'));
  try {
    const fsStorage = new FilesystemArtifactStorage(root);
    const data = Buffer.from('dry-run-artifact');
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const storageKey = await fsStorage.write('job_a', 'result', sha, data);
    const repo = new MemoryRepository([{ ...rowFor('a', storageKey, data), jobId: 'job_a' }]);
    const destination = new MemoryS3Storage();
    const summary = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination, mode: 'dry-run' });
    assert.equal(summary.planned, 1);
    assert.equal(summary.copied, 0);
    assert.equal(summary.updated, 0);
    assert.equal(destination.objects.size, 0);
    assert.equal(repo.rows[0]?.storageKey, storageKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply copies, verifies destination, then conditionally updates DB', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-'));
  try {
    const fsStorage = new FilesystemArtifactStorage(root);
    const data = Buffer.from('apply-artifact');
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const storageKey = await fsStorage.write('job_b', 'result', sha, data);
    const repo = new MemoryRepository([{ ...rowFor('b', storageKey, data), jobId: 'job_b' }]);
    const destination = new MemoryS3Storage();
    const summary = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination, mode: 'apply' });
    assert.equal(summary.copied, 1);
    assert.equal(summary.updated, 1);
    assert.match(repo.rows[0]!.storageKey, /^s3:gpubnb-artifacts\/job_b\/result\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source checksum mismatch blocks copy and metadata update', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-'));
  try {
    const fsStorage = new FilesystemArtifactStorage(root);
    const data = Buffer.from('corrupt-source');
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const storageKey = await fsStorage.write('job_c', 'result', sha, data);
    const row = { ...rowFor('c', storageKey, data), jobId: 'job_c', sha256: '0'.repeat(64) };
    const repo = new MemoryRepository([row]);
    const destination = new MemoryS3Storage();
    const summary = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination, mode: 'apply' });
    assert.equal(summary.failed, 1);
    assert.equal(destination.objects.size, 0);
    assert.equal(repo.rows[0]?.storageKey, storageKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('destination corruption blocks DB update after copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-'));
  try {
    const fsStorage = new FilesystemArtifactStorage(root);
    const data = Buffer.from('destination-check');
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const storageKey = await fsStorage.write('job_d', 'result', sha, data);
    const repo = new MemoryRepository([{ ...rowFor('d', storageKey, data), jobId: 'job_d' }]);
    const destination = new MemoryS3Storage((value) => Buffer.concat([value, Buffer.from('x')]));
    const summary = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination, mode: 'apply' });
    assert.equal(summary.failed, 1);
    assert.equal(summary.copied, 1);
    assert.equal(summary.updated, 0);
    assert.equal(repo.rows[0]?.storageKey, storageKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent metadata change is never overwritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-'));
  try {
    const fsStorage = new FilesystemArtifactStorage(root);
    const data = Buffer.from('concurrent');
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const storageKey = await fsStorage.write('job_e', 'result', sha, data);
    const repo = new MemoryRepository([{ ...rowFor('e', storageKey, data), jobId: 'job_e' }]);
    repo.updateStorageKeyIfUnchanged = async () => false;
    const summary = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination: new MemoryS3Storage(), mode: 'apply' });
    assert.equal(summary.concurrentChanged, 1);
    assert.equal(summary.updated, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('already migrated keys skip and unknown prefixes fail closed', async () => {
  const data = Buffer.from('metadata-only');
  const repo = new MemoryRepository([
    rowFor('s3', 's3:gpubnb-artifacts/job_s3/result/' + 'a'.repeat(64), data),
    rowFor('bad', 'ftp:artifact', data),
  ]);
  const never: ArtifactStorage = { write: async () => { throw new Error('unexpected'); }, read: async () => { throw new Error('unexpected'); } };
  const summary = await migrateArtifactsToS3({ repository: repo, source: never, destination: never, mode: 'apply' });
  assert.equal(summary.skippedS3, 1);
  assert.equal(summary.failed, 1);
});

test('a partial run is resumable because migrated rows are skipped on the next run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpubnb-migrate-'));
  try {
    const fsStorage = new FilesystemArtifactStorage(root);
    const first = Buffer.from('first');
    const second = Buffer.from('second');
    const firstSha = crypto.createHash('sha256').update(first).digest('hex');
    const secondSha = crypto.createHash('sha256').update(second).digest('hex');
    const firstKey = await fsStorage.write('job_f1', 'result', firstSha, first);
    const secondKey = await fsStorage.write('job_f2', 'result', secondSha, second);
    const repo = new MemoryRepository([
      { ...rowFor('f1', firstKey, first), jobId: 'job_f1' },
      { ...rowFor('f2', secondKey, second), jobId: 'job_f2' },
    ]);
    const destination = new MemoryS3Storage();
    const firstRun = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination, mode: 'apply', limit: 1 });
    assert.equal(firstRun.updated, 1);
    const secondRun = await migrateArtifactsToS3({ repository: repo, source: fsStorage, destination, mode: 'apply', limit: 2 });
    assert.equal(secondRun.skippedS3, 1);
    assert.equal(secondRun.updated, 1);
    assert.ok(repo.rows.every((row) => row.storageKey.startsWith('s3:')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
