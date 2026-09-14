import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReleaseSupportManifest } from '../../../scripts/release-support-manifest.mjs';

const valid = {
  version: '0.6.7',
  commit: '0123456789abcdef0123456789abcdef01234567',
  artifact: 'gpubnb-host-windows-x64.exe',
  sha256: 'a'.repeat(64),
  signed: true,
  compatibilityProtocol: 1,
  channel: 'host-test-latest',
  rollbackTag: 'host-v0.2.0-beta.85',
};

test('release support manifest binds version, immutable commit, artifact hash, signature and rollback', () => {
  const manifest = buildReleaseSupportManifest(valid);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, valid.version);
  assert.equal(manifest.commit, valid.commit);
  assert.equal(manifest.sha256, valid.sha256);
  assert.equal(manifest.signed, true);
  assert.equal(manifest.compatibilityProtocol, 1);
  assert.equal(manifest.rollback.tag, valid.rollbackTag);
  assert.equal(manifest.rollback.automaticAllowed, false);
});

test('release support manifest refuses ambiguous build identity', () => {
  assert.throws(() => buildReleaseSupportManifest({ ...valid, version: 'dev' }), /version_invalid/);
  assert.throws(() => buildReleaseSupportManifest({ ...valid, commit: 'dev' }), /commit_invalid/);
  assert.throws(() => buildReleaseSupportManifest({ ...valid, commit: '0123456789ab' }), /commit_invalid/);
  assert.throws(() => buildReleaseSupportManifest({ ...valid, sha256: 'bad' }), /sha256_invalid/);
});

test('rollback target and compatibility protocol are mandatory', () => {
  assert.throws(() => buildReleaseSupportManifest({ ...valid, rollbackTag: '' }), /rollback_tag_required/);
  assert.throws(() => buildReleaseSupportManifest({ ...valid, compatibilityProtocol: 0 }), /compatibility_protocol_invalid/);
});
