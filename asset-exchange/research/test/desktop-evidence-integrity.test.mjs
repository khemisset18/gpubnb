import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const directory = new URL('../../../docs/asset-exchange/audits/evidence/desktop-applied-20261029/', import.meta.url);
const expected = {
  'typescript.log': '26c3b034487ac272dc3c109eda55c7616519050f74eb9aa2b0de760144dc2ff7',
  'upstream-tests.log': '3ee8ab685c3ee332701e40471a7b1f5168d03dddf12f6eed338ac43c54f67727',
};
const hash = value => createHash('sha256').update(value).digest('hex');
test('normalized desktop evidence preserves the independently pinned original log bytes', () => {
  const manifest = JSON.parse(readFileSync(new URL('log-normalization.json', directory), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(expected).sort());
  for (const [name, digest] of Object.entries(expected)) {
    const compressed = readFileSync(new URL(name + '.original.gz', directory));
    const original = gunzipSync(compressed);
    const view = readFileSync(new URL(name, directory));
    const entry = manifest.files[name];
    assert.equal(hash(original), digest);
    assert.equal(entry.originalSha256, digest);
    assert.equal(entry.sourceCommit, 'c8bdef493c140097c1cc198aa6ec67bdb58ca4d5');
    assert.equal(hash(compressed), entry.gzipSha256);
    assert.equal(hash(view), entry.viewSha256);
    assert.equal(original.length - view.length, 1);
    assert.deepEqual(original.subarray(0, -1), view);
    assert.ok(original.subarray(-2).equals(Buffer.from('\n\n')));
  }
});
