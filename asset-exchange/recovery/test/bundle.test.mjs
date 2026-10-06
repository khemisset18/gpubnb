import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptRecoveryEnvelope, encryptRecoveryPayload } from "../src/bundle.mjs";

function payload() {
  return {
    metadata: {
      bundleVersion: 1,
      deploymentId: "ae-test-01",
      tradeId: "trade-00000001",
      protocolId: "GPUBNB-ASSET-EXCHANGE-UTXO-HTLC-V1",
      protocolVersion: 1,
      partyRole: "MAKER",
      chainProfiles: ["bitcoin-regtest-v1"],
      recoveryActions: ["REFUND","RECONCILE"],
      createdAtUnixMs: 2000000000000
    },
    artifacts: [{
      artifactType: "SIGNED_REFUND_TX",
      chainProfile: "bitcoin-regtest-v1",
      encoding: "HEX",
      data: "00ff"
    }]
  };
}

test("AES-256-GCM recovery envelope round-trips without exposing plaintext", () => {
  const key = randomBytes(32);
  const envelope = encryptRecoveryPayload(payload(), key);
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes("trade-00000001"), false);
  assert.equal(serialized.includes("00ff"), false);

  const recovered = decryptRecoveryEnvelope(envelope, key);
  assert.equal(recovered.metadata.tradeId, "trade-00000001");
  assert.equal(recovered.artifacts[0].data, "00ff");
});

test("tampered ciphertext, tag, AAD or wrong key fails authentication", () => {
  const key = randomBytes(32);
  const envelope = encryptRecoveryPayload(payload(), key);

  const tamperedCiphertext = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) + (envelope.ciphertext.endsWith("A") ? "B" : "A") };
  assert.throws(() => decryptRecoveryEnvelope(tamperedCiphertext, key));

  const tamperedTag = { ...envelope, tag: envelope.tag.slice(0, -1) + (envelope.tag.endsWith("A") ? "B" : "A") };
  assert.throws(() => decryptRecoveryEnvelope(tamperedTag, key));

  const tamperedAad = { ...envelope, aadHash: "0".repeat(64) };
  assert.throws(() => decryptRecoveryEnvelope(tamperedAad, key));

  assert.throws(() => decryptRecoveryEnvelope(envelope, randomBytes(32)));
});

test("recovery encryption refuses wallet custody fields before encryption", () => {
  const bad = payload();
  bad.artifacts[0] = {
    artifactType: "CHAIN_RECOVERY_RECIPE",
    chainProfile: "bitcoin-regtest-v1",
    encoding: "JSON",
    data: "{}",
    privateKey: "forbidden"
  };
  assert.throws(() => encryptRecoveryPayload(bad, randomBytes(32)));
});

test("recovery key must be exactly 32 bytes and is never serialized", () => {
  assert.throws(() => encryptRecoveryPayload(payload(), randomBytes(31)));
  const key = randomBytes(32);
  const envelope = encryptRecoveryPayload(payload(), key);
  assert.equal(JSON.stringify(envelope).includes(key.toString("base64url")), false);
});
