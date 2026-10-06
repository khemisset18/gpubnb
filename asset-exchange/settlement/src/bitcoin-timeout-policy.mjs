import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";

export const BTC_TIMEOUT_POLICY_DOMAIN = "GPUBNB:ASSET-EXCHANGE:BTC-TIMEOUT-POLICY:v1";
export const BTC_TIMEOUT_DERIVATION_DOMAIN = "GPUBNB:ASSET-EXCHANGE:BTC-TIMEOUT-DERIVATION:v1";

const POLICY_FIELDS = Object.freeze([
  "maxFundingBroadcastDelayBlocks",
  "fundingConfirmations",
  "counterpartyActionBudgetBlocks",
  "watcherUncertaintyBudgetBlocks",
  "reorgSafetyBlocks",
  "feeBumpBudgetBlocks",
  "recoveryExecutionBlocks",
  "operatorFallbackBlocks",
  "additionalSafetyBlocks"
]);

function canonicalPolicyId(value) {
  invariant(
    typeof value === "string" &&
      /^[a-z0-9][a-z0-9._:-]{7,127}$/.test(value),
    "BTC_TIMEOUT_POLICY_ID",
    "timeout policy id must be canonical lowercase ASCII"
  );
  return value;
}

function nonNegativeBlocks(value, field) {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    "BTC_TIMEOUT_BLOCK_BUDGET",
    `${field} must be a non-negative safe integer`
  );
  return value;
}

function positiveBlocks(value, field) {
  invariant(
    Number.isSafeInteger(value) && value >= 1,
    "BTC_TIMEOUT_BLOCK_BUDGET",
    `${field} must be a positive safe integer`
  );
  return value;
}

export function createBitcoinTimeoutPolicyV1(input) {
  invariant(
    input && typeof input === "object" && !Array.isArray(input),
    "BTC_TIMEOUT_POLICY_TYPE",
    "bitcoin timeout policy must be an object"
  );

  const allowed = new Set([
    "domain",
    "version",
    "policyId",
    "network",
    ...POLICY_FIELDS,
    "operationalSafetyBlocks"
  ]);
  for (const key of Object.keys(input)) {
    invariant(
      allowed.has(key),
      "BTC_TIMEOUT_POLICY_UNKNOWN_FIELD",
      `unknown bitcoin timeout policy field: ${key}`
    );
  }

  if (input.domain !== undefined) {
    invariant(
      input.domain === BTC_TIMEOUT_POLICY_DOMAIN,
      "BTC_TIMEOUT_POLICY_DOMAIN",
      "invalid bitcoin timeout policy domain"
    );
  }
  if (input.version !== undefined) {
    invariant(
      input.version === 1,
      "BTC_TIMEOUT_POLICY_VERSION",
      "unsupported bitcoin timeout policy version"
    );
  }

  const policyId = canonicalPolicyId(input.policyId);
  invariant(
    input.network === "regtest",
    "BTC_TIMEOUT_POLICY_NETWORK",
    "V1 timeout policy is regtest-only"
  );

  const normalized = {
    maxFundingBroadcastDelayBlocks: nonNegativeBlocks(
      input.maxFundingBroadcastDelayBlocks,
      "maxFundingBroadcastDelayBlocks"
    ),
    fundingConfirmations: positiveBlocks(
      input.fundingConfirmations,
      "fundingConfirmations"
    ),
    counterpartyActionBudgetBlocks: nonNegativeBlocks(
      input.counterpartyActionBudgetBlocks,
      "counterpartyActionBudgetBlocks"
    ),
    watcherUncertaintyBudgetBlocks: nonNegativeBlocks(
      input.watcherUncertaintyBudgetBlocks,
      "watcherUncertaintyBudgetBlocks"
    ),
    reorgSafetyBlocks: nonNegativeBlocks(
      input.reorgSafetyBlocks,
      "reorgSafetyBlocks"
    ),
    feeBumpBudgetBlocks: positiveBlocks(
      input.feeBumpBudgetBlocks,
      "feeBumpBudgetBlocks"
    ),
    recoveryExecutionBlocks: positiveBlocks(
      input.recoveryExecutionBlocks,
      "recoveryExecutionBlocks"
    ),
    operatorFallbackBlocks: nonNegativeBlocks(
      input.operatorFallbackBlocks,
      "operatorFallbackBlocks"
    ),
    additionalSafetyBlocks: nonNegativeBlocks(
      input.additionalSafetyBlocks,
      "additionalSafetyBlocks"
    )
  };

  const operationalSafetyBlocks =
    normalized.fundingConfirmations +
    normalized.counterpartyActionBudgetBlocks +
    normalized.watcherUncertaintyBudgetBlocks +
    normalized.reorgSafetyBlocks +
    normalized.feeBumpBudgetBlocks +
    normalized.recoveryExecutionBlocks +
    normalized.operatorFallbackBlocks +
    normalized.additionalSafetyBlocks;

  invariant(
    Number.isSafeInteger(operationalSafetyBlocks) &&
      operationalSafetyBlocks >= normalized.fundingConfirmations,
    "BTC_TIMEOUT_POLICY_SUM",
    "timeout policy block budget overflow"
  );

  if (input.operationalSafetyBlocks !== undefined) {
    invariant(
      input.operationalSafetyBlocks === operationalSafetyBlocks,
      "BTC_TIMEOUT_POLICY_SUM",
      "operational safety block sum mismatch"
    );
  }

  return Object.freeze({
    domain: BTC_TIMEOUT_POLICY_DOMAIN,
    version: 1,
    policyId,
    network: "regtest",
    ...normalized,
    operationalSafetyBlocks
  });
}

export function bitcoinTimeoutPolicyHashHex(policyInput) {
  const policy = createBitcoinTimeoutPolicyV1(policyInput);
  return createHash("sha256").update(canonicalBytes(policy)).digest("hex");
}

export function deriveBitcoinRefundTimeoutV1({ anchorHeight, policy }) {
  invariant(
    Number.isSafeInteger(anchorHeight) &&
      anchorHeight >= 0 &&
      anchorHeight < 500_000_000,
    "BTC_TIMEOUT_ANCHOR_HEIGHT",
    "timeout anchor height must be a Bitcoin block height"
  );

  const normalizedPolicy = createBitcoinTimeoutPolicyV1(policy);
  const policyHash = bitcoinTimeoutPolicyHashHex(normalizedPolicy);

  const maxFundingBroadcastHeight =
    anchorHeight + normalizedPolicy.maxFundingBroadcastDelayBlocks;
  const refundWindowBlocks =
    normalizedPolicy.maxFundingBroadcastDelayBlocks +
    normalizedPolicy.operationalSafetyBlocks;
  const refundLockHeight = anchorHeight + refundWindowBlocks;

  invariant(
    Number.isSafeInteger(maxFundingBroadcastHeight) &&
      Number.isSafeInteger(refundWindowBlocks) &&
      Number.isSafeInteger(refundLockHeight),
    "BTC_TIMEOUT_DERIVATION_OVERFLOW",
    "bitcoin timeout derivation overflow"
  );
  invariant(
    refundLockHeight >= 1 && refundLockHeight < 500_000_000,
    "BTC_TIMEOUT_REFUND_HEIGHT",
    "derived refund height is outside block-height CLTV range"
  );

  return Object.freeze({
    domain: BTC_TIMEOUT_DERIVATION_DOMAIN,
    version: 1,
    policy: normalizedPolicy,
    policyHash,
    anchorHeight,
    maxFundingBroadcastHeight,
    operationalSafetyBlocks: normalizedPolicy.operationalSafetyBlocks,
    refundWindowBlocks,
    refundLockHeight
  });
}

export function assertBitcoinFundingBroadcastFreshnessV1({
  currentHeight,
  derivation
}) {
  invariant(
    Number.isSafeInteger(currentHeight) &&
      currentHeight >= 0 &&
      currentHeight < 500_000_000,
    "BTC_TIMEOUT_CURRENT_HEIGHT",
    "current height must be a Bitcoin block height"
  );
  invariant(
    derivation && typeof derivation === "object" && !Array.isArray(derivation),
    "BTC_TIMEOUT_DERIVATION_TYPE",
    "timeout derivation required"
  );

  const recomputed = deriveBitcoinRefundTimeoutV1({
    anchorHeight: derivation.anchorHeight,
    policy: derivation.policy
  });

  for (const field of [
    "policyHash",
    "maxFundingBroadcastHeight",
    "operationalSafetyBlocks",
    "refundWindowBlocks",
    "refundLockHeight"
  ]) {
    invariant(
      derivation[field] === recomputed[field],
      "BTC_TIMEOUT_DERIVATION_MUTATED",
      `timeout derivation field mutated: ${field}`
    );
  }

  invariant(
    currentHeight <= recomputed.maxFundingBroadcastHeight,
    "BTC_TIMEOUT_TERMS_STALE",
    "funding terms are stale and must be re-derived/re-signed"
  );

  const remainingBlocks = recomputed.refundLockHeight - currentHeight;
  invariant(
    remainingBlocks >= recomputed.operationalSafetyBlocks,
    "BTC_TIMEOUT_SAFETY_ERODED",
    "remaining refund window is below signed operational safety budget"
  );

  return Object.freeze({
    currentHeight,
    remainingBlocks,
    maxFundingBroadcastHeight: recomputed.maxFundingBroadcastHeight,
    refundLockHeight: recomputed.refundLockHeight
  });
}
