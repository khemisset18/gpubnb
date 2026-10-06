import test from "node:test";
import assert from "node:assert/strict";
import { createCancellation, cancellationDigestHex } from "../src/cancellation.mjs";

const base = {
  offerId: "offer-00000001",
  deploymentId: "ae-test-01",
  maker: "maker:test:001",
  offerHash: "a".repeat(64),
  cancelledAtUnixMs: 1000,
  expiryUnixMs: 2000,
  nonce: "cancelNonce000001",
  policyEpoch: 7
};

test("cancellation digest binds offer, maker, deployment, epoch, time and nonce", () => {
  const original = createCancellation(base);
  const digest = cancellationDigestHex(original);
  assert.match(digest, /^[0-9a-f]{64}$/);

  for (const patch of [
    { offerId: "offer-00000002" },
    { deploymentId: "ae-test-02" },
    { maker: "maker:test:002" },
    { offerHash: "b".repeat(64) },
    { cancelledAtUnixMs: 1001 },
    { expiryUnixMs: 2001 },
    { nonce: "cancelNonce000002" },
    { policyEpoch: 8 }
  ]) {
    const changed = createCancellation({ ...base, ...patch });
    assert.notEqual(cancellationDigestHex(changed), digest);
  }
});

test("cancellation rejects unknown fields and malformed replay controls", () => {
  assert.throws(() => createCancellation({ ...base, extra: true }));
  assert.throws(() => createCancellation({ ...base, expiryUnixMs: 1000 }));
  assert.throws(() => createCancellation({ ...base, nonce: "short" }));
  assert.throws(() => createCancellation({ ...base, offerHash: "00" }));
});
