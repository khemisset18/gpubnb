import test from "node:test";
import assert from "node:assert/strict";
import {
  assertBitcoinFundingBroadcastFreshnessV1,
  bitcoinTimeoutPolicyHashHex,
  createBitcoinTimeoutPolicyV1,
  deriveBitcoinRefundTimeoutV1
} from "../src/bitcoin-timeout-policy.mjs";

const policyInput = {
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

test("timeout derivation preserves full operational safety budget at latest allowed broadcast", () => {
  const derivation = deriveBitcoinRefundTimeoutV1({
    anchorHeight: 400,
    policy: policyInput
  });

  assert.equal(derivation.operationalSafetyBlocks, 22);
  assert.equal(derivation.maxFundingBroadcastHeight, 402);
  assert.equal(derivation.refundWindowBlocks, 24);
  assert.equal(derivation.refundLockHeight, 424);

  const freshness = assertBitcoinFundingBroadcastFreshnessV1({
    currentHeight: 402,
    derivation
  });
  assert.equal(freshness.remainingBlocks, 22);
});

test("funding broadcast fails closed once signed timeout terms become stale", () => {
  const derivation = deriveBitcoinRefundTimeoutV1({
    anchorHeight: 400,
    policy: policyInput
  });

  assert.throws(() =>
    assertBitcoinFundingBroadcastFreshnessV1({
      currentHeight: 403,
      derivation
    })
  );
});

test("timeout policy has no hidden defaults", () => {
  const { feeBumpBudgetBlocks, ...missing } = policyInput;
  assert.throws(() => createBitcoinTimeoutPolicyV1(missing));
});

test("policy hash binds risk allocation even when total block count stays equal", () => {
  const a = createBitcoinTimeoutPolicyV1(policyInput);
  const b = createBitcoinTimeoutPolicyV1({
    ...policyInput,
    watcherUncertaintyBudgetBlocks: 0,
    additionalSafetyBlocks: 3
  });

  assert.equal(a.operationalSafetyBlocks, b.operationalSafetyBlocks);
  assert.notEqual(bitcoinTimeoutPolicyHashHex(a), bitcoinTimeoutPolicyHashHex(b));
});

test("mutated timeout derivation is rejected before funding broadcast", () => {
  const derivation = deriveBitcoinRefundTimeoutV1({
    anchorHeight: 400,
    policy: policyInput
  });

  assert.throws(() =>
    assertBitcoinFundingBroadcastFreshnessV1({
      currentHeight: 401,
      derivation: { ...derivation, refundLockHeight: derivation.refundLockHeight + 1 }
    })
  );
});

test("derivation refuses lock heights outside block-height CLTV range", () => {
  assert.throws(() =>
    deriveBitcoinRefundTimeoutV1({
      anchorHeight: 499_999_999,
      policy: policyInput
    })
  );
});
