import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";

export const BTC_CONFIRMATION_POLICY_DOMAIN =
  "GPUBNB:ASSET-EXCHANGE:BTC-CONFIRMATION-POLICY:v1";

const RISK_CLASSES = Object.freeze(["LOW", "STANDARD", "HIGH", "EXTREME"]);

function sats(value, field) {
  invariant(
    typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value),
    "BTC_CONFIRMATION_SATS",
    `invalid ${field}`
  );
  const n = BigInt(value);
  invariant(
    n >= 0n && n <= 2_100_000_000_000_000n,
    "BTC_CONFIRMATION_SATS_RANGE",
    `${field} out of range`
  );
  return n;
}

function confirmations(value, field) {
  invariant(
    Number.isSafeInteger(value) && value >= 1 && value <= 144,
    "BTC_CONFIRMATION_COUNT",
    `${field} must be an integer from 1 to 144`
  );
  return value;
}

export function createBitcoinConfirmationPolicyV1(input) {
  invariant(
    input && typeof input === "object" && !Array.isArray(input),
    "BTC_CONFIRMATION_POLICY_TYPE",
    "bitcoin confirmation policy must be an object"
  );

  const allowed = new Set([
    "domain",
    "version",
    "policyId",
    "network",
    "amountBands",
    "riskFloors"
  ]);
  for (const key of Object.keys(input)) {
    invariant(
      allowed.has(key),
      "BTC_CONFIRMATION_POLICY_UNKNOWN_FIELD",
      `unknown confirmation policy field: ${key}`
    );
  }

  if (input.domain !== undefined) {
    invariant(
      input.domain === BTC_CONFIRMATION_POLICY_DOMAIN,
      "BTC_CONFIRMATION_POLICY_DOMAIN",
      "invalid confirmation policy domain"
    );
  }
  if (input.version !== undefined) {
    invariant(
      input.version === 1,
      "BTC_CONFIRMATION_POLICY_VERSION",
      "unsupported confirmation policy version"
    );
  }

  invariant(
    typeof input.policyId === "string" &&
      /^[a-z0-9][a-z0-9._:-]{7,127}$/.test(input.policyId),
    "BTC_CONFIRMATION_POLICY_ID",
    "confirmation policy id must be canonical lowercase ASCII"
  );
  invariant(
    input.network === "regtest",
    "BTC_CONFIRMATION_POLICY_NETWORK",
    "V1 confirmation policy is regtest-only"
  );
  invariant(
    Array.isArray(input.amountBands) &&
      input.amountBands.length >= 1 &&
      input.amountBands.length <= 16,
    "BTC_CONFIRMATION_BANDS",
    "confirmation policy requires 1..16 amount bands"
  );

  let previousMax = -1n;
  let previousConfirmations = 0;
  let sawCatchAll = false;
  const amountBands = input.amountBands.map((band, index) => {
    invariant(
      band && typeof band === "object" && !Array.isArray(band),
      "BTC_CONFIRMATION_BAND_TYPE",
      "confirmation amount band must be an object"
    );
    const keys = Object.keys(band);
    invariant(
      keys.every((key) => key === "maxAmountSats" || key === "confirmations"),
      "BTC_CONFIRMATION_BAND_FIELD",
      "unknown confirmation amount band field"
    );

    const count = confirmations(
      band.confirmations,
      `amountBands[${index}].confirmations`
    );
    invariant(
      count >= previousConfirmations,
      "BTC_CONFIRMATION_BAND_MONOTONIC",
      "confirmation counts must not decrease as amount increases"
    );

    if (band.maxAmountSats === null) {
      invariant(
        index === input.amountBands.length - 1,
        "BTC_CONFIRMATION_BAND_CATCHALL",
        "catch-all amount band must be final"
      );
      sawCatchAll = true;
      previousConfirmations = count;
      return Object.freeze({ maxAmountSats: null, confirmations: count });
    }

    invariant(
      !sawCatchAll,
      "BTC_CONFIRMATION_BAND_CATCHALL",
      "no amount band may follow catch-all"
    );
    const max = sats(
      band.maxAmountSats,
      `amountBands[${index}].maxAmountSats`
    );
    invariant(
      max > previousMax,
      "BTC_CONFIRMATION_BAND_ORDER",
      "amount-band maxima must be strictly increasing"
    );

    previousMax = max;
    previousConfirmations = count;
    return Object.freeze({
      maxAmountSats: max.toString(),
      confirmations: count
    });
  });

  invariant(
    sawCatchAll,
    "BTC_CONFIRMATION_BAND_CATCHALL",
    "final catch-all amount band is required"
  );

  invariant(
    input.riskFloors &&
      typeof input.riskFloors === "object" &&
      !Array.isArray(input.riskFloors),
    "BTC_CONFIRMATION_RISK_FLOORS",
    "risk floors object required"
  );
  invariant(
    Object.keys(input.riskFloors).length === RISK_CLASSES.length &&
      RISK_CLASSES.every((name) => Object.hasOwn(input.riskFloors, name)),
    "BTC_CONFIRMATION_RISK_CLASSES",
    "risk floors must define exactly LOW, STANDARD, HIGH, EXTREME"
  );

  let previousRiskFloor = 0;
  const riskFloors = {};
  for (const riskClass of RISK_CLASSES) {
    const count = confirmations(
      input.riskFloors[riskClass],
      `riskFloors.${riskClass}`
    );
    invariant(
      count >= previousRiskFloor,
      "BTC_CONFIRMATION_RISK_MONOTONIC",
      "risk confirmation floors must be monotonic"
    );
    riskFloors[riskClass] = count;
    previousRiskFloor = count;
  }

  return Object.freeze({
    domain: BTC_CONFIRMATION_POLICY_DOMAIN,
    version: 1,
    policyId: input.policyId,
    network: "regtest",
    amountBands: Object.freeze(amountBands),
    riskFloors: Object.freeze(riskFloors)
  });
}

export function bitcoinConfirmationPolicyHashHex(policyInput) {
  const policy = createBitcoinConfirmationPolicyV1(policyInput);
  return createHash("sha256").update(canonicalBytes(policy)).digest("hex");
}

export function selectBitcoinConfirmationsV1({
  policy: policyInput,
  amountSats,
  riskClass
}) {
  const policy = createBitcoinConfirmationPolicyV1(policyInput);
  const amount = sats(amountSats, "amountSats");
  invariant(
    RISK_CLASSES.includes(riskClass),
    "BTC_CONFIRMATION_RISK_CLASS",
    "unsupported confirmation risk class"
  );

  const bandIndex = policy.amountBands.findIndex(
    (band) =>
      band.maxAmountSats === null || amount <= BigInt(band.maxAmountSats)
  );
  invariant(
    bandIndex >= 0,
    "BTC_CONFIRMATION_BAND_SELECTION",
    "no confirmation amount band matched"
  );

  const amountBandConfirmations = policy.amountBands[bandIndex].confirmations;
  const riskFloorConfirmations = policy.riskFloors[riskClass];
  const requiredConfirmations = Math.max(
    amountBandConfirmations,
    riskFloorConfirmations
  );

  return Object.freeze({
    policy,
    policyHash: bitcoinConfirmationPolicyHashHex(policy),
    amountSats: amount.toString(),
    riskClass,
    amountBandIndex: bandIndex,
    amountBandConfirmations,
    riskFloorConfirmations,
    requiredConfirmations
  });
}
