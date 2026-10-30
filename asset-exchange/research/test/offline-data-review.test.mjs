import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical, dataHash, digest, text, uint} from '../src/offline-data.mjs';
import {offlineChainRequirements, validateOfflineChainDescriptor} from '../src/chain-boundaries.mjs';

test('a terminal newline cannot bypass the exact digest boundary', () => {
  assert.throws(() => digest('a'.repeat(64) + '\n', 'digest'), /invalid/);
});
test('canonical integer strings cannot use terminal whitespace accepted by BigInt', () => {
  for (const value of ['1\n', '0\n', '01', '1 ', ' 1']) assert.throws(() => uint(value, 'amount'), /invalid/);
});
test('full text match rejects JavaScript dollar-anchor terminal-newline behavior', () => {
  assert.throws(() => text('public\n', /^[a-z]+$/, 'id'), /invalid/);
  assert.equal(text('public', /^[a-z]+$/, 'id'), 'public');
});
test('small shared data graphs cannot cause unbounded canonical expansion', () => {
  let tree = 0; for (let i = 0; i < 8; i++) tree = [tree, tree, tree, tree];
  assert.throws(() => canonical(tree), /aggregate/);
});
test('canonical object keys are bounded independently from values', () => {
  assert.throws(() => canonical({['x'.repeat(257)]: 0}), /key/);
});
test('aggregate strings cannot bypass individual field bounds', () => {
  assert.throws(() => canonical(Array(5).fill(Array(128).fill('x'.repeat(4096)))), /aggregate/);
});
test('all six descriptor boundaries reject newline-suffixed identity digests', () => {
  for (const asset of ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR', 'SOL']) {
    const r = offlineChainRequirements(asset), d = {schemaVersion: 1, asset, network: 'synthetic-offline', genesis: 'a'.repeat(64),
      sourceCommit: asset === 'DOGE' ? 'e0a1c157791544e818c901bd9341896965afbf9d' : 'b'.repeat(40),
      mechanism: r.mechanism, signingDomain: r.signingDomain, feeUnit: r.feeUnit, profileDigest: 'c'.repeat(64) + '\n'};
    assert.throws(() => validateOfflineChainDescriptor(d), /invalid/);
    d.profileDigest = 'c'.repeat(64); d.sourceCommit += '\n'; assert.throws(() => validateOfflineChainDescriptor(d));
  }
});
test('normal canonical bytes and hashes retain the independently specified vector', () => {
  const raw = '{"a":1,"b":"public"}';
  assert.equal(JSON.stringify(canonical({b: 'public', a: 1})), raw);
  assert.equal(dataHash({b: 'public', a: 1}), createHash('sha256').update(raw).digest('hex'));
});
