import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const root = new URL('../../../docs/asset-exchange/audits/evidence/', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(new URL('log-normalization.json', root)));

test('normalized log views retain the exact original bytes and documented line-only changes', () => {
  assert.equal(manifest.schema, 'GPUBNB:EVIDENCE:LOG-VIEW:v1');
  assert.equal(manifest.records.length, 2);
  for (const record of manifest.records) {
    const raw = gunzipSync(readFileSync(new URL(record.rawGzip, root)));
    const view = readFileSync(new URL(record.view, root));
    assert.equal(digest(raw), record.originalSha256);
    assert.equal(digest(view), record.normalizedSha256);
    assert.deepEqual(view, Buffer.from(raw.toString('utf8').replace(/[ \t]+(?=\r?$)/gm, '')));
    assert.equal(raw.toString('utf8').split('\n').length - 1, record.lineCount);
    const rawLines = raw.toString('utf8').split('\n');
    const viewLines = view.toString('utf8').split('\n');
    assert.equal(rawLines.length, viewLines.length);
    assert.deepEqual(rawLines.flatMap((line, i) => line === viewLines[i] ? [] : [i + 1]), record.changedLines);
  }
});

test('every original D1 manifest digest still matches original artifact bytes', () => {
  const base = 'doge-d1-20261029/';
  const sums = readFileSync(new URL(base + 'SHA256SUMS.original-artifact', root), 'utf8');
  for (const line of sums.trimEnd().split('\n')) {
    const [expected, name] = line.split('  ');
    const mapping = manifest.records.find(record => record.view === base + name);
    const raw = mapping ? gunzipSync(readFileSync(new URL(mapping.rawGzip, root))) : readFileSync(new URL(base + name, root));
    assert.equal(digest(raw), expected, name);
  }
});
