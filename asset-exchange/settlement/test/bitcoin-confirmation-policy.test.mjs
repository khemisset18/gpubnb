import test from "node:test";
import assert from "node:assert/strict";
import {
  bitcoinConfirmationPolicyHashHex,
  createBitcoinConfirmationPolicyV1,
  selectBitcoinConfirmationsV1
} from "../src/bitcoin-confirmation-policy.mjs";

const policy = {
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

test("confirmation selection uses the stricter of amount band and risk floor", () => {
  const standard = selectBitcoinConfirmationsV1({
    policy,
    amountSats: "100000",
    riskClass: "STANDARD"
  });
  assert.equal(standard.amountBandConfirmations, 2);
  assert.equal(standard.riskFloorConfirmations, 2);
  assert.equal(standard.requiredConfirmations, 2);

  const highRiskSmall = selectBitcoinConfirmationsV1({
    policy,
    amountSats: "10000",
    riskClass: "HIGH"
  });
  assert.equal(highRiskSmall.amountBandConfirmations, 1);
  assert.equal(highRiskSmall.riskFloorConfirmations, 3);
  assert.equal(highRiskSmall.requiredConfirmations, 3);

  const largeLowRisk = selectBitcoinConfirmationsV1({
    policy,
    amountSats: "1000000",
    riskClass: "LOW"
  });
  assert.equal(largeLowRisk.amountBandConfirmations, 6);
  assert.equal(largeLowRisk.requiredConfirmations, 6);
});

test("policy requires increasing amount bands and non-decreasing confirmation counts", () => {
  assert.throws(() =>
    createBitcoinConfirmationPolicyV1({
      ...policy,
      amountBands: [
        { maxAmountSats: "500000", confirmations: 2 },
        { maxAmountSats: "50000", confirmations: 3 },
        { maxAmountSats: null, confirmations: 6 }
      ]
    })
  );

  assert.throws(() =>
    createBitcoinConfirmationPolicyV1({
      ...policy,
      amountBands: [
        { maxAmountSats: "50000", confirmations: 3 },
        { maxAmountSats: "500000", confirmations: 2 },
        { maxAmountSats: null, confirmations: 6 }
      ]
    })
  );
});

test("policy requires explicit final catch-all and monotonic risk floors", () => {
  assert.throws(() =>
    createBitcoinConfirmationPolicyV1({
      ...policy,
      amountBands: [
        { maxAmountSats: "50000", confirmations: 1 },
        { maxAmountSats: "500000", confirmations: 2 }
      ]
    })
  );

  assert.throws(() =>
    createBitcoinConfirmationPolicyV1({
      ...policy,
      riskFloors: {
        LOW: 1,
        STANDARD: 3,
        HIGH: 2,
        EXTREME: 6
      }
    })
  );
});

test("policy hash changes when risk allocation changes", () => {
  const changed = {
    ...policy,
    riskFloors: {
      ...policy.riskFloors,
      HIGH: 4
    }
  };
  assert.notEqual(
    bitcoinConfirmationPolicyHashHex(policy),
    bitcoinConfirmationPolicyHashHex(changed)
  );
});

test("V1 refuses non-regtest and unknown risk classes", () => {
  assert.throws(() =>
    createBitcoinConfirmationPolicyV1({ ...policy, network: "mainnet" })
  );
  assert.throws(() =>
    selectBitcoinConfirmationsV1({
      policy,
      amountSats: "100000",
      riskClass: "UNKNOWN"
    })
  );
});
