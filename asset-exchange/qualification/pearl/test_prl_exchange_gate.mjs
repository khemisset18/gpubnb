import test from "node:test";
import assert from "node:assert/strict";
import { createUnsignedOffer } from "../../core/src/offer.mjs";
import {
  getAssetCatalogRecord,
  listAssetCatalog
} from "../../core/src/asset-registry.mjs";
import {
  assertPearlOfferExposureGate,
  createOfferService
} from "../../api/src/offer-service.mjs";

// All values below are public, fake, non-operational unit-test fixtures.
// No wallet, signing, transaction, node, HTTP listener or database.
const actor = Object.freeze({
  subject: "maker:test:prl",
  sessionId: "session-lab-00000001",
  authnMethod: "EXCHANGE_SESSION"
});
const btc = Object.freeze({
  chainId: "bitcoin", networkId: "regtest",
  assetType: "NATIVE", assetId: "BTC_NATIVE", decimals: 8
});
const doge = Object.freeze({
  chainId: "dogecoin", networkId: "mainnet",
  assetType: "NATIVE", assetId: "DOGE_NATIVE", decimals: 8
});
function pearl(networkId = "regtest", assetType = "NATIVE") {
  return { chainId: "pearl", networkId, assetType,
    assetId: "PRL_NATIVE_UNVERIFIED", decimals: 8 };
}
function offer(giveAsset = pearl(), wantAsset = doge) {
  return createUnsignedOffer({
    offerId: "prl-policy-lab-offer-001",
    deploymentId: "ae-test-01",
    maker: actor.subject,
    giveAsset,
    wantAsset,
    giveAmountAtomic: "100000000",
    wantAmountAtomic: "250000000",
    expiryUnixMs: 900000,
    nonce: "ABCDEFGHIJKLMNOP",
    policyEpoch: 7,
    feePolicy: {
      policyId: "default-taker-v1",
      version: 1,
      rateBps: 35,
      payerRole: "TAKER",
      feeAssetKey: [
        giveAsset.chainId, giveAsset.networkId,
        giveAsset.assetType, giveAsset.assetId, giveAsset.decimals
      ].join("|"),
      recipient: "treasury:test"
    }
  });
}
function guardedService(calls) {
  const repository = {
    async insertOfferAtomic() { calls.db++; throw new Error("repository must not be used"); },
    async getOfferById() { calls.db++; throw new Error("repository must not be used"); },
    async cancelOfferAtomic() { calls.db++; throw new Error("repository must not be used"); },
    async acceptOfferAtomic() { calls.db++; throw new Error("repository must not be used"); }
  };
  return createOfferService({
    repository,
    // Functions below never sign. They are poisoned to prove no invocation.
    verifyOfferSignature: async () => { calls.verify++; throw new Error("verifier must not run"); },
    verifyAcceptanceSignature: async () => { calls.verify++; throw new Error("verifier must not run"); },
    verifyCancellationSignature: async () => { calls.verify++; throw new Error("verifier must not run"); },
    deploymentId: "ae-test-01",
    now: () => 1000
  });
}
function blocked(error) {
  return error?.code === "PRL_OFFER_UNQUALIFIED";
}

test("Exchange catalogue identifies native Pearl as PRL, never MTN/PEARL", () => {
  const record = getAssetCatalogRecord("pearl-mainnet-native");
  assert.ok(record);
  assert.equal(record.symbol, "PRL");
  assert.equal(record.canonicalName, "Pearl");
});

test("PRL remains identity-unverified and new offers disabled", () => {
  const record = getAssetCatalogRecord("pearl-mainnet-native");
  assert.equal(record.identityReady, false);
  assert.equal(record.identity, null);
  assert.equal(record.assetKey, null);
  assert.equal(record.supportStatus, "MARKETPLACE_ONLY");
  assert.equal(record.riskLevel, "RESTRICTED");
  assert.equal(record.capabilities.newOffersEnabled, false);
  assert.equal(record.capabilities.newTradesEnabled, false);
  assert.equal(record.capabilities.automaticSettlementSupported, false);
  assert.equal(record.routing.settlement, null);
});

test("catalogue can display Pearl, but cannot publish a new offer", () => {
  const record = getAssetCatalogRecord("pearl-mainnet-native");
  assert.equal(record.capabilities.marketplaceEnabled, true);
  assert.equal(record.capabilities.newOffersEnabled, false);
});

test("non-Pearl asset capabilities remain unchanged", () => {
  const bitcoin = getAssetCatalogRecord("btc-regtest-native");
  assert.equal(bitcoin.symbol, "BTC");
  assert.equal(bitcoin.identityReady, true);
  assert.equal(bitcoin.capabilities.automaticSettlementSupported, true);
  assert.deepEqual(
    listAssetCatalog().filter(r => r.capabilities.automaticSettlementSupported).map(r => r.registryId),
    ["btc-regtest-native"]
  );
});

test("PRL offered on all networks fails before signatures or database", async () => {
  for (const network of ["mainnet", "regtest", "simnet", "testnet"]) {
    const calls = { db: 0, verify: 0 };
    const service = guardedService(calls);
    await assert.rejects(
      () => service.publishOffer({
        actor, offer: offer(pearl(network), doge),
        signature: undefined, idempotencyKey: "prl-lab-idempotency-000001"
      }), blocked, network
    );
    assert.deepEqual(calls, { db: 0, verify: 0 });
  }
});

test("PRL requested as counterparty asset also fails before side effects", async () => {
  const calls = { db: 0, verify: 0 };
  await assert.rejects(
    () => guardedService(calls).publishOffer({
      actor, offer: offer(btc, pearl("mainnet")),
      signature: undefined, idempotencyKey: "prl-lab-idempotency-000002"
    }), blocked
  );
  assert.deepEqual(calls, { db: 0, verify: 0 });
});

test("PRL token and NFT impostor families are also refused", () => {
  for (const kind of ["NATIVE", "TOKEN", "NFT"]) {
    assert.throws(() => assertPearlOfferExposureGate(offer(pearl("mainnet", kind))), blocked);
  }
});

test("shared rprl address domain cannot bypass explicit regtest/simnet block", () => {
  assert.throws(() => assertPearlOfferExposureGate(offer(pearl("regtest"))), blocked);
  assert.throws(() => assertPearlOfferExposureGate(offer(pearl("simnet"))), blocked);
});

test("non-Pearl offer remains unaffected by the Pearl-specific gate", () => {
  assert.doesNotThrow(() => assertPearlOfferExposureGate(offer(btc, doge)));
});

test("PRL guard is pure and leaves canonical public data unchanged", () => {
  const candidate = offer(pearl("mainnet"), btc);
  const original = JSON.stringify(candidate);
  assert.throws(() => assertPearlOfferExposureGate(candidate), blocked);
  assert.equal(JSON.stringify(candidate), original);
});
