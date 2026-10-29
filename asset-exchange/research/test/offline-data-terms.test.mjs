import test from 'node:test';
import assert from 'node:assert/strict';
import {dataHash, canonical} from '../src/offline-data.mjs';
import {validateOfflineTerms} from '../src/offline-terms.mjs';
const assets = ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR'];
function fixtures() {
  const manifest = {schemaVersion: 1, simulationOnly: true, qualified: false, profiles: assets.map(asset => ({
    asset, network: 'synthetic-offline', genesis: dataHash({synthetic: asset}), decimals: asset === 'XMR' ? 12 : 8,
    maximumAtomic: '18446744073709551615', profileVersion: 1}))};
  const manifestDigest = dataHash(manifest);
  const leg = (asset) => { const p = manifest.profiles.find(p => p.asset === asset); return {
    asset, network: p.network, genesis: p.genesis, profileDigest: dataHash(p), amountAtomic: '9007199254740993', feeReserveAtomic: '1', refundDestination: dataHash({destination: asset})}; };
  const terms = (a, b) => ({schemaVersion: 1, tradeId: 'trade-fixture:1', manifestDigest, legA: leg(a), legB: leg(b), createdAt: 1000,
    expiresAt: 1200, route: [a, b].includes('DOGE') && [a, b].includes('XMR') ? 'NO_REVIEWED_ROUTE' : 'RESEARCH_ONLY'});
  return {manifest, manifestDigest, terms};
}
test('all twenty directions bind exact synthetic profiles and integer amounts without execution', () => {
  const {manifest, manifestDigest, terms} = fixtures(); let count = 0;
  for (const a of assets) for (const b of assets) if (a !== b) {
    const result = validateOfflineTerms(terms(a, b), manifest, manifestDigest, 1100); count++;
    assert.equal(result.direction, `${a}->${b}`); assert.equal(result.qualified, false);
    assert.equal(result.simulationOnly, true); assert.deepEqual(result.executableOperations, []);
    assert.equal(result.admissibleForExecution, false); assert.ok(Object.isFrozen(result));
    assert.equal(result.status, [a, b].includes('DOGE') && [a, b].includes('XMR') ? 'BLOCKED_NO_REVIEWED_ROUTE' : 'OFFLINE_TERMS_BOUND');
  }
  assert.equal(count, 20);
});
test('amount format, overflow, precision loss and exhausted reserves are rejected', () => {
  const {manifest, manifestDigest, terms} = fixtures();
  for (const amount of [1, 9007199254740992, '01', '-1', '+1', '1.0', '1e8', '0', '18446744073709551616']) {
    const t = terms('BTC', 'DOGE'); t.legA.amountAtomic = amount;
    assert.throws(() => validateOfflineTerms(t, manifest, manifestDigest, 1100));
  }
  const t = terms('BTC', 'DOGE'); t.legA.amountAtomic = '18446744073709551615';
  assert.throws(() => validateOfflineTerms(t, manifest, manifestDigest, 1100), /amount or reserve/);
});
test('network, genesis, manifest and profile changes fail closed', () => {
  const {manifest, manifestDigest, terms} = fixtures();
  for (const [key, value] of [['network', 'mainnet'], ['genesis', 'f'.repeat(64)], ['profileDigest', 'f'.repeat(64)], ['asset', 'ETH']]) {
    const t = terms('BTC', 'DOGE'); t.legA[key] = value;
    assert.throws(() => validateOfflineTerms(t, manifest, manifestDigest, 1100));
  }
  const modified = structuredClone(manifest); modified.profiles[0].maximumAtomic = '1';
  assert.throws(() => validateOfflineTerms(terms('BTC', 'DOGE'), modified, manifestDigest, 1100), /manifest digest mismatch/);
});
test('unsupported route promotion and stale or future consent are rejected', () => {
  const {manifest, manifestDigest, terms} = fixtures();
  const unsupported = terms('DOGE', 'XMR'); unsupported.route = 'RESEARCH_ONLY';
  assert.throws(() => validateOfflineTerms(unsupported, manifest, manifestDigest, 1100), /promotion/);
  for (const now of [999, 1200, 1201]) assert.throws(() => validateOfflineTerms(terms('BTC', 'DOGE'), manifest, manifestDigest, now), /future, stale/);
  const same = terms('BTC', 'BTC'); assert.throws(() => validateOfflineTerms(same, manifest, manifestDigest, 1100), /same-asset/);
});
test('unknown fields and non-JSON values cannot be silently committed', () => {
  const {manifest, manifestDigest, terms} = fixtures(); const t = terms('BTC', 'DOGE'); t.walletPassword = 'synthetic-forbidden-field';
  assert.throws(() => validateOfflineTerms(t, manifest, manifestDigest, 1100), /unexpected/);
  for (const value of [NaN, Infinity, undefined, new Date(), new Map(), 1n, [, 1], JSON.parse('{"__proto__":1}')]) assert.throws(() => canonical(value));
  let called = false; const accessor = {}; Object.defineProperty(accessor, 'x', {enumerable: true, get() { called = true; return 1; }});
  assert.throws(() => canonical(accessor), /data properties/); assert.equal(called, false);
  assert.equal(dataHash({b: 1, a: 2}), dataHash({a: 2, b: 1}));
});

test('array commitments reject symbols, hidden extras and accessors without reading them', () => {
  const withSymbol = [1]; withSymbol[Symbol('hidden')] = 'ignored-data';
  const hiddenExtra = [1]; Object.defineProperty(hiddenExtra, 'hidden', {value: 'ignored-data'});
  const extraIndex = [1]; Object.defineProperty(extraIndex, '01', {value: 'ambiguous-index'});
  const hiddenIndex = [1]; Object.defineProperty(hiddenIndex, '0', {value: 1, enumerable: false});
  let read = false;
  const accessorIndex = [1]; Object.defineProperty(accessorIndex, '0', {enumerable: true, get() { read = true; return 1; }});
  const hiddenAccessor = [1]; Object.defineProperty(hiddenAccessor, 'hidden', {get() { read = true; return 1; }});
  const inheritedHook = [1]; Object.setPrototypeOf(inheritedHook, {map() { read = true; return []; }});
  for (const value of [withSymbol, hiddenExtra, extraIndex, hiddenIndex, accessorIndex, hiddenAccessor, inheritedHook]) {
    assert.throws(() => canonical(value), /array/);
  }
  assert.equal(read, false);
  assert.deepEqual(canonical(Object.freeze([1, null, {a: 'value'}])), [1, null, {a: 'value'}]);
});
