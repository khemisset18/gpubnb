import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";
import { BTC_HTLC_PROTOCOL_ID, buildBitcoinHtlcV1 } from "./bitcoin-htlc-v1.mjs";
import { deriveBitcoinRefundTimeoutV1 } from "./bitcoin-timeout-policy.mjs";
import { selectBitcoinConfirmationsV1 } from "./bitcoin-confirmation-policy.mjs";

export const BTC_SETTLEMENT_TERMS_DOMAIN = "GPUBNB:ASSET-EXCHANGE:SETTLEMENT:BTC:v1";

function hex64(value, field) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "BTC_TERMS_HEX", `invalid ${field}`);
  return value;
}

function compressedKey(value, field) {
  invariant(typeof value === "string" && /^(02|03)[0-9a-f]{64}$/.test(value), "BTC_TERMS_PUBKEY", `invalid ${field}`);
  return value;
}

export function createBitcoinSettlementTerms(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "BTC_TERMS_TYPE", "bitcoin settlement terms required");

  const allowed = new Set([
    "deploymentId","tradeId","offerHash","makerSubject","takerSubject","policyEpoch",
    "network","protocolId","protocolVersion",
    "fundingAmountSats","secretHashHex","redeemPubkeyHex","refundPubkeyHex",
    "refundLockHeight","witnessScriptHashHex","scriptPubKeyHex",
    "requiredConfirmations","sighashType","feePolicyId","feePolicyVersion",
    "timeoutPolicy","timeoutAnchorHeight",
    "confirmationPolicy","confirmationRiskClass"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "BTC_TERMS_UNKNOWN_FIELD", `unknown bitcoin settlement term: ${key}`);

  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof input.tradeId === "string" && input.tradeId.length >= 8 && input.tradeId.length <= 128, "BTC_TERMS_TRADE", "invalid tradeId");
  const offerHash = hex64(input.offerHash, "offer hash");
  invariant(typeof input.makerSubject === "string" && input.makerSubject.length >= 3 && input.makerSubject.length <= 256, "BTC_TERMS_MAKER", "invalid maker subject");
  invariant(typeof input.takerSubject === "string" && input.takerSubject.length >= 3 && input.takerSubject.length <= 256, "BTC_TERMS_TAKER", "invalid taker subject");
  invariant(input.makerSubject !== input.takerSubject, "BTC_TERMS_PARTIES", "maker and taker must be distinct");
  invariant(Number.isSafeInteger(input.policyEpoch) && input.policyEpoch >= 0, "BTC_TERMS_EPOCH", "invalid policy epoch");
  invariant(input.network === "regtest", "BTC_TERMS_NETWORK", "V1 settlement terms are regtest-only");
  invariant(input.protocolId === BTC_HTLC_PROTOCOL_ID, "BTC_TERMS_PROTOCOL", "unexpected bitcoin protocol id");
  invariant(input.protocolVersion === 1, "BTC_TERMS_PROTOCOL_VERSION", "unsupported bitcoin protocol version");
  invariant(typeof input.fundingAmountSats === "string" && /^[1-9][0-9]{0,18}$/.test(input.fundingAmountSats), "BTC_TERMS_AMOUNT", "funding amount must be positive integer satoshis");
  const amount = BigInt(input.fundingAmountSats);
  invariant(amount > 0n && amount <= 2_100_000_000_000_000n, "BTC_TERMS_AMOUNT_RANGE", "bitcoin amount outside valid range");

  const confirmation = selectBitcoinConfirmationsV1({
    policy: input.confirmationPolicy,
    amountSats: input.fundingAmountSats,
    riskClass: input.confirmationRiskClass
  });

  const timeout = deriveBitcoinRefundTimeoutV1({
    anchorHeight: input.timeoutAnchorHeight,
    policy: input.timeoutPolicy
  });

  invariant(
    timeout.policy.fundingConfirmations === confirmation.requiredConfirmations,
    "BTC_TERMS_CONFIRMATION_TIMEOUT_MISMATCH",
    "timeout policy confirmations must match amount/risk confirmation policy"
  );
  invariant(
    input.requiredConfirmations === confirmation.requiredConfirmations,
    "BTC_TERMS_CONFIRMATION_POLICY",
    "required confirmations must match signed timeout policy"
  );
  invariant(
    input.refundLockHeight === timeout.refundLockHeight,
    "BTC_TERMS_TIMEOUT_HEIGHT",
    "refund lock height must be derived from signed timeout policy"
  );

  const secretHashHex = hex64(input.secretHashHex, "secret hash");
  const redeemPubkeyHex = compressedKey(input.redeemPubkeyHex, "redeem pubkey");
  const refundPubkeyHex = compressedKey(input.refundPubkeyHex, "refund pubkey");
  invariant(Number.isSafeInteger(input.requiredConfirmations) && input.requiredConfirmations >= 1 && input.requiredConfirmations <= 144, "BTC_TERMS_CONFIRMATIONS", "invalid confirmation policy");
  invariant(input.sighashType === 0x01, "BTC_TERMS_SIGHASH", "V1 requires SIGHASH_ALL");
  invariant(typeof input.feePolicyId === "string" && input.feePolicyId.length >= 8 && input.feePolicyId.length <= 128, "BTC_TERMS_FEE_POLICY", "invalid fee policy id");
  invariant(Number.isSafeInteger(input.feePolicyVersion) && input.feePolicyVersion >= 1, "BTC_TERMS_FEE_POLICY_VERSION", "invalid fee policy version");

  const built = buildBitcoinHtlcV1({
    secretHashHex,
    redeemPubkeyHex,
    refundPubkeyHex,
    refundLockHeight: timeout.refundLockHeight
  });

  invariant(input.witnessScriptHashHex === built.witnessScriptHashHex, "BTC_TERMS_WITNESS_HASH", "witness script hash mismatch");
  invariant(input.scriptPubKeyHex === built.scriptPubKeyHex, "BTC_TERMS_SPK", "scriptPubKey mismatch");

  return Object.freeze({
    domain: BTC_SETTLEMENT_TERMS_DOMAIN,
    version: 1,
    deploymentId,
    tradeId: input.tradeId,
    offerHash,
    makerSubject: input.makerSubject,
    takerSubject: input.takerSubject,
    policyEpoch: input.policyEpoch,
    network: "regtest",
    protocolId: BTC_HTLC_PROTOCOL_ID,
    protocolVersion: 1,
    fundingAmountSats: amount.toString(10),
    secretHashHex,
    redeemPubkeyHex,
    refundPubkeyHex,
    confirmationPolicy: confirmation.policy,
    confirmationPolicyHash: confirmation.policyHash,
    confirmationRiskClass: confirmation.riskClass,
    confirmationAmountBandIndex: confirmation.amountBandIndex,
    confirmationAmountBandConfirmations: confirmation.amountBandConfirmations,
    confirmationRiskFloor: confirmation.riskFloorConfirmations,
    timeoutPolicy: timeout.policy,
    timeoutPolicyHash: timeout.policyHash,
    timeoutAnchorHeight: timeout.anchorHeight,
    maxFundingBroadcastHeight: timeout.maxFundingBroadcastHeight,
    operationalSafetyBlocks: timeout.operationalSafetyBlocks,
    refundWindowBlocks: timeout.refundWindowBlocks,
    refundLockHeight: timeout.refundLockHeight,
    witnessScriptHashHex: built.witnessScriptHashHex,
    scriptPubKeyHex: built.scriptPubKeyHex,
    requiredConfirmations: input.requiredConfirmations,
    sighashType: 0x01,
    feePolicyId: input.feePolicyId,
    feePolicyVersion: input.feePolicyVersion
  });
}

export function bitcoinSettlementTermsDigestHex(termsInput) {
  const terms = termsInput?.domain === BTC_SETTLEMENT_TERMS_DOMAIN
    ? createBitcoinSettlementTerms({
        deploymentId: termsInput.deploymentId,
        tradeId: termsInput.tradeId,
        offerHash: termsInput.offerHash,
        makerSubject: termsInput.makerSubject,
        takerSubject: termsInput.takerSubject,
        policyEpoch: termsInput.policyEpoch,
        network: termsInput.network,
        protocolId: termsInput.protocolId,
        protocolVersion: termsInput.protocolVersion,
        fundingAmountSats: termsInput.fundingAmountSats,
        secretHashHex: termsInput.secretHashHex,
        redeemPubkeyHex: termsInput.redeemPubkeyHex,
        refundPubkeyHex: termsInput.refundPubkeyHex,
        timeoutPolicy: termsInput.timeoutPolicy,
        timeoutAnchorHeight: termsInput.timeoutAnchorHeight,
        confirmationPolicy: termsInput.confirmationPolicy,
        confirmationRiskClass: termsInput.confirmationRiskClass,
        refundLockHeight: termsInput.refundLockHeight,
        witnessScriptHashHex: termsInput.witnessScriptHashHex,
        scriptPubKeyHex: termsInput.scriptPubKeyHex,
        requiredConfirmations: termsInput.requiredConfirmations,
        sighashType: termsInput.sighashType,
        feePolicyId: termsInput.feePolicyId,
        feePolicyVersion: termsInput.feePolicyVersion
      })
    : createBitcoinSettlementTerms(termsInput);

  return createHash("sha256").update(canonicalBytes(terms)).digest("hex");
}
