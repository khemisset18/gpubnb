import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresOfferRepository, withTransaction } from "../src/postgres-offer-repository.mjs";
import { createUnsignedOffer, createAcceptance, offerDigestHex, acceptanceDigestHex } from "../../core/src/index.mjs";\n\nconst fixtureRequestId = (label) => `fixture-${label}-request-0001`;

function fakePool(script = []) {
  const calls = [];
  const rowsByCall = [...script];
  const client = {
    async query(arg) {
      calls.push(arg);
      if (typeof arg === "string") {
        if (arg === "BEGIN" || arg === "COMMIT" || arg === "ROLLBACK") return { rows: [] };
      }
      const next = rowsByCall.shift();
      if (next instanceof Error) throw next;
      return next ?? { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  return {
    calls,
    async connect() { calls.push("CONNECT"); return client; }
  };
}

test("withTransaction uses one client and commits before release", async () => {
  const pool = fakePool([{ rows: [{ ok: true }] }]);
  const out = await withTransaction(pool, async (client) => client.query({ text: "SELECT 1", values: [] }));
  assert.equal(out.rows[0].ok, true);
  assert.deepEqual(pool.calls.slice(0, 5), [
    "CONNECT",
    "BEGIN",
    { text: "SELECT 1", values: [] },
    "COMMIT",
    "RELEASE"
  ]);
});

test("withTransaction rolls back on failure", async () => {
  const pool = fakePool([new Error("boom")]);
  await assert.rejects(() => withTransaction(pool, async (client) => client.query({ text: "SELECT fail", values: [] })));
  assert.deepEqual(pool.calls.slice(0, 5), [
    "CONNECT",
    "BEGIN",
    { text: "SELECT fail", values: [] },
    "ROLLBACK",
    "RELEASE"
  ]);
});

test("repository calls parameterized publish function and never interpolates offer data", async () => {
  const pool = fakePool([{ rows: [{ status: "OPEN", offer_id: "offer-00000001" }] }]);
  const repository = createPostgresOfferRepository({ pool, deploymentId: "ae-test-01" });
  const offer = createUnsignedOffer({
    offerId: "offer-00000001",
    deploymentId: "ae-test-01",
    maker: "maker:test:001",
    giveAsset: { chainId: "bitcoin", networkId: "regtest", assetType: "NATIVE", assetId: "BTC_NATIVE", decimals: 8 },
    giveAmountAtomic: "100000000",
    wantAsset: { chainId: "litecoin", networkId: "regtest", assetType: "NATIVE", assetId: "LTC_NATIVE", decimals: 8 },
    wantAmountAtomic: "2500000000",
    expiryUnixMs: 2000000000000,
    nonce: "ABCDEFGHIJKLMNOP",
    policyEpoch: 7,
    feePolicy: {
      policyId: "default-taker-v1",
      version: 1,
      rateBps: 35,
      payerRole: "TAKER",
      feeAssetKey: "bitcoin|regtest|NATIVE|BTC_NATIVE|8",
      recipient: "treasury:test"
    }
  });

  const result = await repository.insertOfferAtomic({
    actorSubject: offer.maker,
    offer,
    offerHash: offerDigestHex(offer),
    signature: "sig",
    idempotencyKey: fixtureRequestId("publish")
  });

  assert.equal(result.status, "OPEN");
  const query = pool.calls.find((call) => typeof call === "object" && call?.text?.includes("publish_offer_atomic"));
  assert.ok(query);
  assert.equal(query.text.includes(offer.maker), false);
  assert.equal(query.values[0], "ae-test-01");
  assert.equal(query.values[2], offer.maker);
});

test("repository accept call binds deployment, offer hash and acceptance hash as parameters", async () => {
  const pool = fakePool([{ rows: [{ status: "CONSUMED", trade_id: "trade-00000001" }] }]);
  const repository = createPostgresOfferRepository({ pool, deploymentId: "ae-test-01" });
  const acceptance = createAcceptance({
    offerId: "offer-00000001",
    tradeId: "trade-00000001",
    deploymentId: "ae-test-01",
    taker: "taker:test:001",
    offerHash: "a".repeat(64),
    acceptedAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "ABCDEFGHIJKLMNOP",
    policyEpoch: 7
  });

  const result = await repository.acceptOfferAtomic({
    actorSubject: acceptance.taker,
    acceptance,
    acceptanceHash: acceptanceDigestHex(acceptance),
    signature: "sig",
    idempotencyKey: fixtureRequestId("accept")
  });

  assert.equal(result.tradeId, "trade-00000001");
  const query = pool.calls.find((call) => typeof call === "object" && call?.text?.includes("accept_offer_atomic"));
  assert.equal(query.values[0], "ae-test-01");
  assert.equal(query.values[4], acceptance.offerHash);
  assert.equal(query.values[6], acceptanceDigestHex(acceptance));
});
