import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pearlNetworkProfile, validatePearlNetworkIdentity, PEARL_SOURCE_COMMIT } from '../src/pearl-network.mjs';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/pearl-source-identity.json', import.meta.url)));
const observed = network => ({ chainId: 'pearl', ...fixture.networks[network] });

test('Pearl source-derived profiles match all six pinned network records without activation', () => {
  assert.equal(PEARL_SOURCE_COMMIT, fixture.commit);
  for (const network of Object.keys(fixture.networks)) {
    assert.deepEqual(pearlNetworkProfile(network), fixture.networks[network]);
    const result = validatePearlNetworkIdentity(network, observed(network));
    assert.equal(result.qualificationStatus, 'BLOCKED');
    assert.equal(result.automaticSettlement, false);
    assert.ok(Object.isFrozen(pearlNetworkProfile(network)));
  }
});
test('every cross-network substitution rejects, including identical regtest/simnet genesis and HRP', () => {
  assert.equal(fixture.networks.regtest.genesisHash, fixture.networks.simnet.genesisHash);
  assert.equal(fixture.networks.regtest.addressHrp, fixture.networks.simnet.addressHrp);
  for (const expected of Object.keys(fixture.networks)) for (const actual of Object.keys(fixture.networks)) {
    if (expected !== actual) assert.throws(() => validatePearlNetworkIdentity(expected, observed(actual)));
  }
});
test('Pearl rejects homonymous tokens, Bitcoin genesis, custom signet magic and missing fields', () => {
  for (const changes of [{ chainId: 'bitcoin' }, { genesisHash: '0'.repeat(64) }, { wireMagicHex: '00000000' }, { addressHrp: 'bc' }, { networkId: 'mainnet' }]) {
    assert.throws(() => validatePearlNetworkIdentity('signet', { ...observed('signet'), ...changes }));
  }
  const missing = observed('regtest'); delete missing.wireMagicHex;
  assert.throws(() => validatePearlNetworkIdentity('regtest', missing));
  for (const id of ['constructor', '__proto__', 'test', null, {}]) assert.throws(() => pearlNetworkProfile(id));
});
test('identity validation rejects getters and inherited data without invoking getters', () => {
  const input = observed('regtest');
  Object.defineProperty(input, 'genesisHash', { get() { throw new Error('getter invoked'); } });
  assert.throws(() => validatePearlNetworkIdentity('regtest', input), error => error.code === 'PEARL_IDENTITY_FIELDS');
  assert.throws(() => validatePearlNetworkIdentity('regtest', Object.create(observed('regtest'))));
});
