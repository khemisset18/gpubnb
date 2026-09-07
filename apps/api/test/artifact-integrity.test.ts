import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ArtifactStorageError, verifyArtifactBytes } from '../src/artifact-storage.js';

test('artifact integrity verifier accepts exact SHA-256 and byte count', () => {
  const data = Buffer.from('verified-artifact');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  assert.doesNotThrow(() => verifyArtifactBytes(data, sha, data.length));
});

test('artifact integrity verifier rejects size and checksum corruption', () => {
  const data = Buffer.from('verified-artifact');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  assert.throws(
    () => verifyArtifactBytes(data, sha, data.length + 1),
    (error: unknown) => error instanceof ArtifactStorageError && error.code === 'artifact_integrity_check_failed',
  );
  assert.throws(
    () => verifyArtifactBytes(data, '0'.repeat(64), data.length),
    (error: unknown) => error instanceof ArtifactStorageError && error.code === 'artifact_integrity_check_failed',
  );
});
