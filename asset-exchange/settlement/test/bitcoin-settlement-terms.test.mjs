import test from "node:test";
import assert from "node:assert/strict";
import { buildBitcoinHtlcV1 } from "../src/bitcoin-htlc-v1.mjs";
import { createBitcoinSettlementTerms, bitcoinSettlementTermsDigestHex } from "../src/bitcoin-settlement-terms.mjs";

const redeem = "03c150061989643d77162902b725409087959f15914649d4f06b6cc3f8c87bb238";
const refund = "020461e6025e68bdc5a1d6730b2fb13c4c62d295f226f0c3dbd0b713530897a6b4";
const secretHash = "33".repeat(32);
const built = buildBitcoinHtlcV1({
  secretHashHex: secretHash,
  redeemPubkeyHex: redeem,
  refundPubkeyHex: refund,
  refundLockHeight: 500
});

const base = {
  deploymentId: "ae-test-01",
  tradeId: "trade-00000001",
  network: "regtest",
  protocolId: "GPUBNB-ASSET-EXCHANGE-BTC-P2WSH-HTLC-V1",
  protocolVersion: 1,
  fundingAmountSats: "100000",
  secretHashHex: secretHash,
  redeemPubkeyHex: redeem,
  refundPubkeyHex: refund,
  refundLockHeight: 500,
  witnessScriptHashHex: built.witnessScriptHashHex,
  scriptPubKeyHex: built.scriptPubKeyHex,
  requiredConfirmations: 2,
  sighashType: 0x01,
  feePolicyId: "owner-fee-v1",
  feePolicyVersion: 1
};

test("settlement digest binds every economic and script-critical field", () => {
  const original = createBitcoinSettlementTerms(base);
  const digest = bitcoinSettlementTermsDigestHex(original);
  assert.match(digest, /^[0-9a-f]{64}$/);

  const changedSecret = "44".repeat(32);
  const changedSecretScript = buildBitcoinHtlcV1({
    secretHashHex: changedSecret,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: 500
  });
  const changedHeightScript = buildBitcoinHtlcV1({
    secretHashHex: secretHash,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: 501
  });

  const variants = [
    { fundingAmountSats: "100001" },
    {
      secretHashHex: changedSecret,
      witnessScriptHashHex: changedSecretScript.witnessScriptHashHex,
      scriptPubKeyHex: changedSecretScript.scriptPubKeyHex
    },
    {
      refundLockHeight: 501,
      witnessScriptHashHex: changedHeightScript.witnessScriptHashHex,
      scriptPubKeyHex: changedHeightScript.scriptPubKeyHex
    },
    { requiredConfirmations: 3 },
    { feePolicyVersion: 2 },
    { deploymentId: "ae-test-02" },
    { tradeId: "trade-00000002" }
  ];

  for (const patch of variants) {
    const changed = createBitcoinSettlementTerms({ ...base, ...patch });
    assert.notEqual(bitcoinSettlementTermsDigestHex(changed), digest);
  }
});

test("terms reject script substitution even when other fields look valid", () => {
  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    witnessScriptHashHex: "00".repeat(32)
  }));
  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    scriptPubKeyHex: "0020" + "00".repeat(32)
  }));
});

test("V1 terms refuse non-regtest, alternate sighash and invalid amounts", () => {
  assert.throws(() => createBitcoinSettlementTerms({ ...base, network: "mainnet" }));
  assert.throws(() => createBitcoinSettlementTerms({ ...base, sighashType: 0x02 }));
  assert.throws(() => createBitcoinSettlementTerms({ ...base, fundingAmountSats: "0" }));
  assert.throws(() => createBitcoinSettlementTerms({ ...base, fundingAmountSats: "2100000000000001" }));
});

test("normalized terms round-trip to same digest", () => {
  const normalized = createBitcoinSettlementTerms(base);
  assert.equal(bitcoinSettlementTermsDigestHex(normalized), bitcoinSettlementTermsDigestHex(base));
});
