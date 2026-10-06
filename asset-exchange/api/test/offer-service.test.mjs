import test from "node:test";
import assert from "node:assert/strict";
import { createUnsignedOffer, offerDigestHex } from "../../core/src/index.mjs";
import { createOfferService } from "../src/offer-service.mjs";

const actorMaker = { subject: "maker:test:001", sessionId: "session-maker-001", authnMethod: "EXCHANGE_SESSION" };
const fixtureRequestId = (label) => `fixture-${label}-request-0001`;
const actorTaker = { subject: "taker:test:001", sessionId: "session-taker-001", authnMethod: "EXCHANGE_SESSION" };

const rawOffer = {
  offerId: "offer-00000001",
  deploymentId: "ae-test-01",
  maker: actorMaker.subject,
  giveAsset: { chainId: "bitcoin", networkId: "regtest", assetType: "NATIVE", assetId: "BTC_NATIVE", decimals: 8 },
  giveAmountAtomic: "100000000",
  wantAsset: { chainId: "litecoin", networkId: "regtest", assetType: "NATIVE", assetId: "LTC_NATIVE", decimals: 8 },
  wantAmountAtomic: "2500000000",
  expiryUnixMs: 5000,
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
};

function fakeRepository() {
  const calls = [];
  return {
    calls,
    async insertOfferAtomic(input) { calls.push(["insert", input]); return { status: "OPEN", offerId: input.offer.offerId }; },
    async getOfferById(offerId) {
      calls.push(["get", offerId]);
      const offer = createUnsignedOffer(rawOffer);
      return {
        offerId,
        makerSubject: actorMaker.subject,
        state: "OPEN",
        offerHash: offerDigestHex(offer),
        policyEpoch: offer.policyEpoch
      };
    },
    async cancelOfferAtomic(input) { calls.push(["cancel", input]); return { status: "CANCELLED", offerId: input.offerId }; },
    async acceptOfferAtomic(input) { calls.push(["accept", input]); return { status: "CONSUMED", tradeId: input.acceptance.tradeId }; }
  };
}

function service(repo, overrides = {}) {
  return createOfferService({
    repository: repo,
    verifyOfferSignature: async () => true,
    verifyAcceptanceSignature: async () => true,
    verifyCancellationSignature: async () => true,
    deploymentId: "ae-test-01",
    now: () => 1000,
    ...overrides
  });
}

test("publishing requires maker object authorization and verified signature", async () => {
  const repo = fakeRepository();
  const svc = service(repo);

  await assert.rejects(() => svc.publishOffer({
    actor: { ...actorMaker, subject: "other:test:001" },
    offer: createUnsignedOffer(rawOffer),
    signature: "sig",
    idempotencyKey: fixtureRequestId("publish-denied")
  }));

  const rejecting = service(repo, { verifyOfferSignature: async () => false });
  await assert.rejects(() => rejecting.publishOffer({
    actor: actorMaker,
    offer: createUnsignedOffer(rawOffer),
    signature: "sig",
    idempotencyKey: fixtureRequestId("publish-badsig")
  }));

  const result = await svc.publishOffer({
    actor: actorMaker,
    offer: createUnsignedOffer(rawOffer),
    signature: "sig",
    idempotencyKey: fixtureRequestId("publish-good")
  });
  assert.equal(result.status, "OPEN");
});

test("cancel requires stored maker identity and verified signed cancellation intent", async () => {
  const repo = fakeRepository();
  const svc = service(repo);
  const offer = createUnsignedOffer(rawOffer);
  const cancellation = {
    offerId: offer.offerId,
    deploymentId: offer.deploymentId,
    maker: actorMaker.subject,
    offerHash: offerDigestHex(offer),
    cancelledAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "cancelNonce000001",
    policyEpoch: offer.policyEpoch
  };

  await assert.rejects(() => svc.cancelOffer({
    actor: actorTaker,
    cancellation,
    signature: "sig",
    idempotencyKey: fixtureRequestId("cancel-denied")
  }));

  const rejecting = service(repo, { verifyCancellationSignature: async () => false });
  await assert.rejects(() => rejecting.cancelOffer({
    actor: actorMaker,
    cancellation,
    signature: "sig",
    idempotencyKey: fixtureRequestId("cancel-badsig")
  }));

  const result = await svc.cancelOffer({
    actor: actorMaker,
    cancellation,
    signature: "sig",
    idempotencyKey: fixtureRequestId("cancel-good")
  });
  assert.equal(result.status, "CANCELLED");
  const call = repo.calls.find(([name]) => name === "cancel");
  assert.equal(call[1].cancellation.offerHash, offerDigestHex(offer));
  assert.match(call[1].cancellationHash, /^[0-9a-f]{64}$/);
});

test("cancel rejects hash, epoch, deployment, timestamp and expiry mismatch before mutation", async () => {
  const repo = fakeRepository();
  const svc = service(repo, { maxClockSkewMs: 50 });
  const offer = createUnsignedOffer(rawOffer);
  const baseCancellation = {
    offerId: offer.offerId,
    deploymentId: offer.deploymentId,
    maker: actorMaker.subject,
    offerHash: offerDigestHex(offer),
    cancelledAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "cancelNonce000001",
    policyEpoch: offer.policyEpoch
  };

  for (const patch of [
    { offerHash: "b".repeat(64) },
    { policyEpoch: offer.policyEpoch + 1 },
    { deploymentId: "ae-other-01" },
    { cancelledAtUnixMs: 1100 },
    { cancelledAtUnixMs: 900, expiryUnixMs: 1000 }
  ]) {
    await assert.rejects(() => svc.cancelOffer({
      actor: actorMaker,
      cancellation: { ...baseCancellation, ...patch },
      signature: "sig",
      idempotencyKey: fixtureRequestId("cancel-mismatch")
    }));
  }

  assert.equal(repo.calls.filter(([name]) => name === "cancel").length, 0);
});

test("acceptance binds taker, offer hash and policy epoch for atomic repository verification", async () => {
  const repo = fakeRepository();
  const svc = service(repo);
  const offer = createUnsignedOffer(rawOffer);

  const acceptance = {
    offerId: offer.offerId,
    tradeId: "trade-00000001",
    deploymentId: "ae-test-01",
    taker: actorTaker.subject,
    offerHash: offerDigestHex(offer),
    acceptedAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "QRSTUVWXYZabcdef",
    policyEpoch: offer.policyEpoch
  };

  const result = await svc.acceptOffer({
    actor: actorTaker,
    acceptance,
    signature: "sig",
    idempotencyKey: fixtureRequestId("accept-good")
  });

  assert.equal(result.status, "CONSUMED");
  const call = repo.calls.find(([name]) => name === "accept");
  assert.equal(call[1].acceptance.offerHash, offerDigestHex(offer));
  assert.equal(call[1].acceptance.policyEpoch, 7);
});

test("acceptance rejects wrong actor and invalid signature before repository mutation", async () => {
  const repo = fakeRepository();
  const offer = createUnsignedOffer(rawOffer);
  const acceptance = {
    offerId: offer.offerId,
    tradeId: "trade-00000001",
    deploymentId: "ae-test-01",
    taker: actorTaker.subject,
    offerHash: offerDigestHex(offer),
    acceptedAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "QRSTUVWXYZabcdef",
    policyEpoch: offer.policyEpoch
  };

  const svc = service(repo);
  await assert.rejects(() => svc.acceptOffer({
    actor: actorMaker,
    acceptance,
    signature: "sig",
    idempotencyKey: fixtureRequestId("accept-wrongactor")
  }));

  const rejecting = service(repo, { verifyAcceptanceSignature: async () => false });
  await assert.rejects(() => rejecting.acceptOffer({
    actor: actorTaker,
    acceptance,
    signature: "sig",
    idempotencyKey: fixtureRequestId("accept-badsig")
  }));

  assert.equal(repo.calls.filter(([name]) => name === "accept").length, 0);
});

test("cross-deployment replay is rejected before persistence", async () => {
  const repo = fakeRepository();
  const svc = service(repo);
  const offer = createUnsignedOffer(rawOffer);
  const acceptance = {
    offerId: offer.offerId,
    tradeId: "trade-00000009",
    deploymentId: "ae-other-01",
    taker: actorTaker.subject,
    offerHash: offerDigestHex(offer),
    acceptedAtUnixMs: 1000,
    expiryUnixMs: 2000,
    nonce: "deploymentReplay01",
    policyEpoch: offer.policyEpoch
  };
  await assert.rejects(() => svc.acceptOffer({
    actor: actorTaker,
    acceptance,
    signature: "sig",
    idempotencyKey: fixtureRequestId("accept-replay")
  }));
  assert.equal(repo.calls.filter(([name]) => name === "accept").length, 0);
});

test("acceptance timestamp cannot be far in the future", async () => {
  const repo = fakeRepository();
  const svc = service(repo, { maxClockSkewMs: 100 });
  const offer = createUnsignedOffer(rawOffer);
  const acceptance = {
    offerId: offer.offerId,
    tradeId: "trade-00000010",
    deploymentId: "ae-test-01",
    taker: actorTaker.subject,
    offerHash: offerDigestHex(offer),
    acceptedAtUnixMs: 1200,
    expiryUnixMs: 2200,
    nonce: "futureTimestamp01",
    policyEpoch: offer.policyEpoch
  };
  await assert.rejects(() => svc.acceptOffer({
    actor: actorTaker,
    acceptance,
    signature: "sig",
    idempotencyKey: fixtureRequestId("accept-future")
  }));
});
