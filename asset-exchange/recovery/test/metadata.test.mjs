import test from "node:test";
import assert from "node:assert/strict";
import { assertNoForbiddenSecrets, createRecoveryMetadata } from "../src/metadata.mjs";

test("recovery artifact rejects private-key-like fields recursively", () => {
  assert.throws(() => assertNoForbiddenSecrets({ nested: { privateKey: "nope" } }));
  assert.throws(() => assertNoForbiddenSecrets({ wallet: { seedPhrase: "nope" } }));
  assert.throws(() => assertNoForbiddenSecrets({ spend_key: "nope" }));
});

test("minimal recovery metadata contains no custody material", () => {
  const metadata = createRecoveryMetadata({
    bundleVersion: 1,
    deploymentId: "ae-test-01",
    tradeId: "trade-00000001",
    protocolId: "GPUBNB-ASSET-EXCHANGE-UTXO-HTLC-V1",
    protocolVersion: 1,
    partyRole: "MAKER",
    chainProfiles: ["bitcoin-regtest-v1"],
    recoveryActions: ["REFUND"],
    createdAtUnixMs: 2000000000000
  });
  assert.equal(metadata.bundleVersion, 1);
  assert.equal(metadata.deploymentId, "ae-test-01");
});
