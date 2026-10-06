import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptance, acceptanceDigestHex } from "../src/index.mjs";

const input = {
  offerId: "offer-00000001",
  tradeId: "trade-00000001",
  taker: "taker:test:001",
  offerHash: "a".repeat(64),
  acceptedAtUnixMs: 1000,
  expiryUnixMs: 2000,
  nonce: "ABCDEFGHIJKLMNOP",
  policyEpoch: 3
};

test("acceptance digest binds offer hash, taker and trade id", () => {
  const a = createAcceptance(input);
  assert.match(acceptanceDigestHex(a), /^[0-9a-f]{64}$/);

  for (const patch of [
    { offerHash: "b".repeat(64) },
    { taker: "taker:test:002" },
    { tradeId: "trade-00000002" }
  ]) {
    const changed = createAcceptance({ ...input, ...patch });
    assert.notEqual(acceptanceDigestHex(a), acceptanceDigestHex(changed));
  }
});

test("acceptance rejects unknown fields and invalid expiry", () => {
  assert.throws(() => createAcceptance({ ...input, hidden: true }));
  assert.throws(() => createAcceptance({ ...input, expiryUnixMs: input.acceptedAtUnixMs }));
});
