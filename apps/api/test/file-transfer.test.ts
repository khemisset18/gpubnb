import test from 'node:test'; import assert from 'node:assert/strict'; import crypto from 'node:crypto'; import path from 'node:path'; import fsp from 'node:fs/promises';

const storageDir = path.resolve('./data/test-artifacts');

test('writes and reads an artifact file', async () => {
  const jobId = 'test-job-1';
  const sha256 = crypto.createHash('sha256').update('test-data').digest('hex');
  const storageKey = `${jobId}/result/${sha256}`;
  const filePath = path.join(storageDir, storageKey);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, 'test-data');
  const read = await fsp.readFile(filePath, 'utf-8');
  assert.equal(read, 'test-data');
});

test('sha256 hash is 64 hex chars', () => {
  const data = Buffer.from('artifact content');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('creates nested directory structure for storage key', async () => {
  const key = 'job-123/result/abc123';
  const fullPath = path.join(storageDir, key);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  const fs = await import('node:fs');
  assert.ok(fs.existsSync(path.dirname(fullPath)));
});
