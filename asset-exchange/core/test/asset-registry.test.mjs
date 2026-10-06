import test from "node:test";
import assert from "node:assert/strict";
import {
  listAssetCatalog,
  getAssetCatalogRecord,
  resolveAssetCatalogByIdentity,
  assertAutomaticSettlementEligible
} from "../src/asset-registry.mjs";

test("asset registry has unique ids and canonical keys", () => {
  const records = listAssetCatalog();
  assert.ok(records.length >= 20);
  assert.equal(new Set(records.map((r) => r.registryId)).size, records.length);
  const keys = records.filter((r) => r.assetKey !== null).map((r) => r.assetKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("only reviewed regtest Bitcoin route can auto-settle in V1", () => {
  const automatic = listAssetCatalog().filter((r) => r.capabilities.automaticSettlementSupported);
  assert.deepEqual(automatic.map((r) => r.registryId), ["btc-regtest-native"]);
  assert.equal(automatic[0].routing.settlement, "BITCOIN_P2WSH_HTLC_V1_REGTEST");
});

test("stablecoins are distinct by exact chain and token identifier", () => {
  const usdtEth = getAssetCatalogRecord("usdt-ethereum-mainnet");
  const usdtSol = getAssetCatalogRecord("usdt-solana-mainnet");
  const usdcEth = getAssetCatalogRecord("usdc-ethereum-mainnet");
  const usdcSol = getAssetCatalogRecord("usdc-solana-mainnet");

  assert.notEqual(usdtEth.assetKey, usdtSol.assetKey);
  assert.notEqual(usdcEth.assetKey, usdcSol.assetKey);
  assert.equal(usdtEth.identity.assetId, "0xdac17f958d2ee523a2206206994597c13d831ec7");
  assert.equal(usdtSol.identity.assetId, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
  assert.equal(usdcEth.identity.assetId, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(usdcSol.identity.assetId, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});

test("marketplace-only and experimental assets cannot accidentally auto-settle", () => {
  for (const record of listAssetCatalog()) {
    if (record.supportStatus === "MARKETPLACE_ONLY" || record.supportStatus === "QUARANTINED") {
      assert.equal(record.capabilities.automaticSettlementSupported, false);
      assert.equal(record.routing.settlement, null);
      assert.equal(record.capabilities.newTradesEnabled, false);
    }
  }

  assert.equal(getAssetCatalogRecord("firo-mainnet-native").supportStatus, "QUARANTINED");
  assert.equal(getAssetCatalogRecord("qubic-mainnet-native").identityReady, false);
});

test("resolver is exact and settlement guard fails closed", () => {
  const btc = getAssetCatalogRecord("btc-regtest-native");
  assert.equal(resolveAssetCatalogByIdentity(btc.identity).registryId, btc.registryId);
  assert.equal(assertAutomaticSettlementEligible(btc.identity).registryId, btc.registryId);

  const eth = getAssetCatalogRecord("eth-mainnet-native");
  assert.throws(() => assertAutomaticSettlementEligible(eth.identity));

  assert.equal(resolveAssetCatalogByIdentity({
    ...eth.identity,
    networkId: "sepolia"
  }), null);
});
