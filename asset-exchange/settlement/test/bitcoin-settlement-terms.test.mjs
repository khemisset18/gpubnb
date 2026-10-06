import test from "node:test";
import assert from "node:assert/strict";
import { buildBitcoinHtlcV1 } from "../src/bitcoin-htlc-v1.mjs";
import { deriveBitcoinRefundTimeoutV1 } from "../src/bitcoin-timeout-policy.mjs";
import { createBitcoinSettlementTerms, bitcoinSettlementTermsDigestHex } from "../src/bitcoin-settlement-terms.mjs";

const redeem = "03c150061989643d77162902b725409087959f15914649d4f06b6cc3f8c87bb238";
const refund = "020461e6025e68bdc5a1d6730b2fb13c4c62d295f226f0c3dbd0b713530897a6b4";
const secretHash = "33".repeat(32);

const confirmationPolicy = {
  policyId: "btc-regtest-confirm-v1",
  network: "regtest",
  amountBands: [
    { maxAmountSats: "50000", confirmations: 1 },
    { maxAmountSats: "500000", confirmations: 2 },
    { maxAmountSats: null, confirmations: 6 }
  ],
  riskFloors: {
    LOW: 1,
    STANDARD: 2,
    HIGH: 3,
    EXTREME: 6
  }
};

const timeoutPolicy = {
  policyId: "btc-regtest-risk-v1",
  network: "regtest",
  maxFundingBroadcastDelayBlocks: 2,
  fundingConfirmations: 2,
  counterpartyActionBudgetBlocks: 3,
  watcherUncertaintyBudgetBlocks: 1,
  reorgSafetyBlocks: 6,
  feeBumpBudgetBlocks: 2,
  recoveryExecutionBlocks: 2,
  operatorFallbackBlocks: 4,
  additionalSafetyBlocks: 2
};

const timeout = deriveBitcoinRefundTimeoutV1({
  anchorHeight: 400,
  policy: timeoutPolicy
});

const built = buildBitcoinHtlcV1({
  secretHashHex: secretHash,
  redeemPubkeyHex: redeem,
  refundPubkeyHex: refund,
  refundLockHeight: timeout.refundLockHeight
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
  timeoutPolicy,
  timeoutAnchorHeight: 400,
  confirmationPolicy,
  confirmationRiskClass: "STANDARD",
  refundLockHeight: timeout.refundLockHeight,
  witnessScriptHashHex: built.witnessScriptHashHex,
  scriptPubKeyHex: built.scriptPubKeyHex,
  requiredConfirmations: 2,
  sighashType: 0x01,
  feePolicyId: "owner-fee-v1",
  feePolicyVersion: 1
};

function rebuildForTimeout({ policy = timeoutPolicy, anchorHeight = 400 } = {}) {
  const changedTimeout = deriveBitcoinRefundTimeoutV1({
    anchorHeight,
    policy
  });
  const changedScript = buildBitcoinHtlcV1({
    secretHashHex: secretHash,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: changedTimeout.refundLockHeight
  });
  return {
    timeoutPolicy: policy,
    timeoutAnchorHeight: anchorHeight,
    refundLockHeight: changedTimeout.refundLockHeight,
    witnessScriptHashHex: changedScript.witnessScriptHashHex,
    scriptPubKeyHex: changedScript.scriptPubKeyHex,
    requiredConfirmations: changedTimeout.policy.fundingConfirmations
  };
}

test("settlement digest binds every economic, script, and timeout-critical field", () => {
  const original = createBitcoinSettlementTerms(base);
  const digest = bitcoinSettlementTermsDigestHex(original);
  assert.match(digest, /^[0-9a-f]{64}$/);

  const changedSecret = "44".repeat(32);
  const changedSecretScript = buildBitcoinHtlcV1({
    secretHashHex: changedSecret,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: timeout.refundLockHeight
  });

  const shiftedRiskPolicy = {
    ...timeoutPolicy,
    watcherUncertaintyBudgetBlocks: 0,
    additionalSafetyBlocks: 3
  };

  const changedConfirmationsPolicy = {
    ...timeoutPolicy,
    fundingConfirmations: 3
  };

  const confirmationPolicyForThree = {
    ...confirmationPolicy,
    riskFloors: {
      LOW: 1,
      STANDARD: 3,
      HIGH: 3,
      EXTREME: 6
    }
  };

  const variants = [
    { fundingAmountSats: "100001" },
    {
      secretHashHex: changedSecret,
      witnessScriptHashHex: changedSecretScript.witnessScriptHashHex,
      scriptPubKeyHex: changedSecretScript.scriptPubKeyHex
    },
    rebuildForTimeout({ anchorHeight: 401 }),
    {
      ...rebuildForTimeout({ policy: changedConfirmationsPolicy }),
      confirmationPolicy: confirmationPolicyForThree
    },
    {
      timeoutPolicy: shiftedRiskPolicy
    },
    {
      confirmationPolicy: {
        ...confirmationPolicy,
        riskFloors: {
          ...confirmationPolicy.riskFloors,
          EXTREME: 7
        }
      }
    },
    { feePolicyVersion: 2 },
    { deploymentId: "ae-test-02" },
    { tradeId: "trade-00000002" }
  ];

  for (const patch of variants) {
    const changed = createBitcoinSettlementTerms({ ...base, ...patch });
    assert.notEqual(bitcoinSettlementTermsDigestHex(changed), digest);
  }
});

test("terms reject timeout/script substitution even when other fields look valid", () => {
  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    refundLockHeight: base.refundLockHeight + 1
  }));
  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    witnessScriptHashHex: "00".repeat(32)
  }));
  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    scriptPubKeyHex: "0020" + "00".repeat(32)
  }));
});

test("confirmation policy must match both signed terms and timeout budget", () => {
  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    requiredConfirmations: 3
  }));

  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    confirmationRiskClass: "HIGH"
  }));

  assert.throws(() => createBitcoinSettlementTerms({
    ...base,
    timeoutPolicy: { ...timeoutPolicy, fundingConfirmations: 3 }
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
