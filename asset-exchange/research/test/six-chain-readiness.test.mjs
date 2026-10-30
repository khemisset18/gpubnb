import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { listAssetCatalog } from '../../core/src/asset-registry.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const review = JSON.parse(readFileSync(resolve(repo, 'docs/asset-exchange/research/2026-10-30/SIX_CHAIN_READINESS.json'), 'utf8'));

test('six-chain research inventory is source-bound and cannot assert qualified routes', () => {
  assert.deepEqual(review.chains.map(c => c.symbol).sort(), ['BCH','BTC','DOGE','LTC','SOL','XMR']);
  assert.equal(review.crossChainQualifiedDirections, 0);
  for (const chain of review.chains) {
    assert.equal(chain.swapQualified, false);
    assert.deepEqual(chain.executableOperations, []);
    assert.equal(chain.productionSettlement, 'BLOCKED');
    assert.ok(chain.missing.length > 0);
    for (const field of ['mechanism','lock','refund','compatibility','reorgRisk','timeAndConfirmations']) assert.ok(chain[field].length > 20);
  }
  for (const record of review.sourceFiles) {
    assert.equal(createHash('sha256').update(readFileSync(resolve(repo, record.path))).digest('hex'), record.sha256, record.path);
  }
});

test('SOL rental escrow is distinct from swap support; mainnet capabilities remain disabled', () => {
  const sol = review.chains.find(c => c.symbol === 'SOL');
  assert.equal(sol.status, 'NOT STARTED');
  assert.match(sol.mechanism, /rental usage escrow/);
  for (const asset of listAssetCatalog().filter(a => ['SOL','BTC','DOGE','LTC','BCH','XMR'].includes(a.symbol))) {
    if (asset.identity?.networkId === 'regtest') continue;
    assert.equal(asset.capabilities.automaticSettlementSupported, false, asset.registryId);
    assert.equal(asset.routing.settlement, null, asset.registryId);
  }
});

test('Monero remains a separate protocol and direct DOGE route is not invented', () => {
  const xmr = review.chains.find(c => c.symbol === 'XMR');
  assert.equal(xmr.status, 'BLOCKED');
  assert.match(xmr.mechanism, /no classical Bitcoin HTLC/);
  assert.match(xmr.compatibility, /rejects direct DOGE–XMR both ways/);
});
