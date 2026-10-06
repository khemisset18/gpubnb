import { invariant } from "./errors.mjs";
import { parseAtomicAmount, atomicAmountToString } from "./amount.mjs";

export const DEFAULT_MAX_RATE_BPS = 10_000;

export function createFeePolicy(input, { maxRateBps = DEFAULT_MAX_RATE_BPS } = {}) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "FEE_TYPE", "fee policy must be an object");
  invariant(Number.isInteger(maxRateBps) && maxRateBps >= 0 && maxRateBps <= 10_000, "FEE_MAX_RATE", "invalid safety maximum");

  const allowed = new Set(["policyId", "version", "rateBps", "payerRole", "feeAssetKey", "recipient", "minimumAtomic", "maximumAtomic"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "FEE_UNKNOWN_FIELD", `unknown fee field: ${key}`);

  invariant(typeof input.policyId === "string" && input.policyId.length >= 8 && input.policyId.length <= 128, "FEE_POLICY_ID", "invalid policyId");
  invariant(Number.isInteger(input.version) && input.version >= 1, "FEE_VERSION", "invalid fee policy version");
  invariant(Number.isInteger(input.rateBps) && input.rateBps >= 0 && input.rateBps <= maxRateBps, "FEE_RATE", "fee rate outside configured safety bounds");
  invariant(["MAKER", "TAKER", "SELLER", "BUYER"].includes(input.payerRole), "FEE_PAYER", "invalid payer role");
  invariant(typeof input.feeAssetKey === "string" && input.feeAssetKey.length > 0, "FEE_ASSET", "fee asset key required");
  invariant(typeof input.recipient === "string" && input.recipient.length >= 3 && input.recipient.length <= 512, "FEE_RECIPIENT", "invalid fee recipient");

  const minimumAtomic = input.minimumAtomic == null ? null : parseAtomicAmount(input.minimumAtomic);
  const maximumAtomic = input.maximumAtomic == null ? null : parseAtomicAmount(input.maximumAtomic);
  if (minimumAtomic !== null && maximumAtomic !== null) invariant(minimumAtomic <= maximumAtomic, "FEE_MIN_MAX", "minimum fee exceeds maximum fee");

  return Object.freeze({
    policyId: input.policyId,
    version: input.version,
    rateBps: input.rateBps,
    payerRole: input.payerRole,
    feeAssetKey: input.feeAssetKey,
    recipient: input.recipient,
    minimumAtomic: minimumAtomic === null ? null : atomicAmountToString(minimumAtomic),
    maximumAtomic: maximumAtomic === null ? null : atomicAmountToString(maximumAtomic)
  });
}

export function calculateFee(amountAtomic, policy) {
  const amount = parseAtomicAmount(amountAtomic);
  const p = createFeePolicy(policy);
  let fee = (amount * BigInt(p.rateBps)) / 10_000n;

  if (p.minimumAtomic !== null) {
    const min = parseAtomicAmount(p.minimumAtomic);
    if (fee < min) fee = min;
  }
  if (p.maximumAtomic !== null) {
    const max = parseAtomicAmount(p.maximumAtomic);
    if (fee > max) fee = max;
  }

  invariant(fee <= amount, "FEE_EXCEEDS_AMOUNT", "fee cannot exceed traded amount");
  return atomicAmountToString(fee);
}
