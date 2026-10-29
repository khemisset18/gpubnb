import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateResearchCatalog} from '../src/catalog-validation.mjs';
const base = new URL('../../../docs/asset-exchange/research/2026-10-29/', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, base)));
const catalog = load('PAIR_MATRIX_20_DIRECTIONS.json'), probe = load('BASICSWAP_OFFLINE_TYPE_PROBE.json');
test('the inventory covers all ten pairs and twenty directions with required evidence', () => {
  assert.deepEqual(validateResearchCatalog(catalog, probe), {validatedCatalogStructureOnly: true, uniquePairs: 10, directions: 20, qualified: false});
});
test('a wallet-list promotion of explicitly rejected DOGE-XMR routes is rejected', () => {
  const bad = structuredClone(catalog);
  bad.directions.find(row => row.direction === 'DOGE → XMR').basicswap.status = 'Support observé dans du code maintenu';
  assert.throws(() => validateResearchCatalog(bad, probe), /rejected pair/);
});
test('partial XMR wallet, stale source commits, omitted evidence and duplicate directions cannot become qualification', () => {
  for (const mutate of [
    c => {c.directions.find(row => row.direction === 'BTC → XMR').dcrdex.status = 'Support observé dans du code maintenu';},
    c => {c.sourceCommits.basicswap = '0'.repeat(40);},
    c => {delete c.directions[0].refund;},
    c => {c.directions[1] = c.directions[0];},
    c => {c.notAnActivationManifest = false;},
  ]) {const bad = structuredClone(catalog); mutate(bad); assert.throws(() => validateResearchCatalog(bad, probe));}
});
test('all future RPC requests are source-derived drafts and cannot authorize execution', () => {
  const requests = load('D2_D9_AUTHORIZATION_DRAFTS.json'), rpc = load('DOGE_RPC_SOURCE_INVENTORY.json');
  assert.equal(requests.status, 'PREPARED_NOT_EXECUTABLE');
  assert.deepEqual(requests.phases.map(r => r.phase), ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']);
  for (const request of requests.phases) {
    assert.equal(request.authorization, 'NOT_GRANTED'); assert.equal(request.executionHarnessCommit, null); assert.equal(request.activationAuthorized, false);
    for (const method of request.candidateRpcAllowlist) assert.ok(Object.hasOwn(rpc.methods, method), method);
  }
  assert.equal(Object.hasOwn(rpc.methods, 'testmempoolaccept'), false);
});
