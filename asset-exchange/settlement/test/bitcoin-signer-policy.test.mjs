import test from "node:test";
import assert from "node:assert/strict";
import { assertDecodedPsbtMatchesSignerIntent, bitcoinPsbtDigestHex, bitcoinSignerIntentDigestHex, createBitcoinSignerIntent } from "../src/bitcoin-signer-policy.mjs";

const decoded = {
  tx: {
    version: 2,
    locktime: 500,
    vin: [{
      txid: "11".repeat(32),
      vout: 0,
      sequence: 0xfffffffd
    }],
    vout: [{
      value: 0.0099,
      scriptPubKey: { hex: "0014" + "22".repeat(20) }
    }]
  },
  inputs: [{
    witness_utxo: {
      amount: 0.01,
      scriptPubKey: { hex: "0020" + "33".repeat(32) }
    },
    sighash: "ALL"
  }]
};

const psbtBase64 = Buffer.concat([Buffer.from([0x70,0x73,0x62,0x74,0xff]), Buffer.from("fixture-v1")]).toString("base64");
const psbtDigestHex = bitcoinPsbtDigestHex(psbtBase64);

const base = {
  deploymentId: "ae-test-01",
  tradeId: "trade-00000001",
  role: "REFUND",
  network: "regtest",
  signerFingerprint: "deadbeef",
  settlementTermsDigestHex: "44".repeat(32),
  psbtDigestHex,
  txVersion: 2,
  lockTime: 500,
  sighashType: 0x01,
  inputs: [{
    txid: "11".repeat(32),
    vout: 0,
    amountSats: "1000000",
    scriptPubKeyHex: "0020" + "33".repeat(32),
    sequence: 0xfffffffd
  }],
  outputs: [{
    scriptPubKeyHex: "0014" + "22".repeat(20),
    amountSats: "990000",
    purpose: "REFUND"
  }],
  feeSats: "10000",
  maxFeeSats: "20000"
};

test("signer intent binds fingerprint, exact values, fee, locktime and SIGHASH_ALL", () => {
  const intent = createBitcoinSignerIntent(base);
  assert.equal(intent.signerFingerprint, "deadbeef");
  assert.equal(intent.feeSats, "10000");
  assert.match(bitcoinSignerIntentDigestHex(base), /^[0-9a-f]{64}$/);
  assert.equal(assertDecodedPsbtMatchesSignerIntent(decoded, base, psbtBase64), true);
});

test("PSBT output substitution is rejected before external signer call", () => {
  const tampered = structuredClone(decoded);
  tampered.tx.vout[0].scriptPubKey.hex = "0014" + "99".repeat(20);
  assert.throws(() => assertDecodedPsbtMatchesSignerIntent(tampered, base, psbtBase64));
});

test("input amount, sequence and sighash substitution are rejected", () => {
  const amount = structuredClone(decoded);
  amount.inputs[0].witness_utxo.amount = 0.009;
  assert.throws(() => assertDecodedPsbtMatchesSignerIntent(amount, base, psbtBase64));

  const sequence = structuredClone(decoded);
  sequence.tx.vin[0].sequence = 0xffffffff;
  assert.throws(() => assertDecodedPsbtMatchesSignerIntent(sequence, base, psbtBase64));

  const sighash = structuredClone(decoded);
  sighash.inputs[0].sighash = "NONE";
  assert.throws(() => assertDecodedPsbtMatchesSignerIntent(sighash, base, psbtBase64));
});

test("fee cannot exceed signed maximum or disagree with value conservation", () => {
  assert.throws(() => createBitcoinSignerIntent({ ...base, feeSats: "30000" }));
  assert.throws(() => createBitcoinSignerIntent({ ...base, feeSats: "9999" }));
});

test("wrong network and malformed signer fingerprint fail closed", () => {
  assert.throws(() => createBitcoinSignerIntent({ ...base, network: "mainnet" }));
  assert.throws(() => createBitcoinSignerIntent({ ...base, signerFingerprint: "DEADBEEF" }));
  assert.throws(() => createBitcoinSignerIntent({ ...base, signerFingerprint: "deadbeef00" }));
});

test("binary PSBT must match the pre-authorized digest exactly", () => {
  const alteredPsbt = Buffer.concat([Buffer.from([0x70,0x73,0x62,0x74,0xff]), Buffer.from("fixture-v2")]).toString("base64");
  assert.throws(() => assertDecodedPsbtMatchesSignerIntent(decoded, base, alteredPsbt));
});

test("invalid PSBT base64 or magic is rejected before signer invocation", () => {
  assert.throws(() => bitcoinPsbtDigestHex("not_base64!"));
  assert.throws(() => bitcoinPsbtDigestHex(Buffer.from("not-a-psbt").toString("base64")));
});
