import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { validateDeploymentId } from "./deployment.mjs";

export const ACCEPT_DOMAIN = "GPUBNB:ASSET-EXCHANGE:ACCEPT:v1";

export function createAcceptance(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "ACCEPT_TYPE", "acceptance must be an object");

  const allowed = new Set([
    "offerId", "tradeId", "deploymentId", "taker", "offerHash", "acceptedAtUnixMs",
    "expiryUnixMs", "nonce", "policyEpoch"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "ACCEPT_UNKNOWN_FIELD", `unknown acceptance field: ${key}`);

  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof input.offerId === "string" && input.offerId.length >= 8 && input.offerId.length <= 128, "ACCEPT_OFFER_ID", "invalid offerId");
  invariant(typeof input.tradeId === "string" && input.tradeId.length >= 8 && input.tradeId.length <= 128, "ACCEPT_TRADE_ID", "invalid tradeId");
  invariant(typeof input.taker === "string" && input.taker.length >= 3 && input.taker.length <= 256, "ACCEPT_TAKER", "invalid taker");
  invariant(typeof input.offerHash === "string" && /^[0-9a-f]{64}$/.test(input.offerHash), "ACCEPT_OFFER_HASH", "invalid offer hash");
  invariant(Number.isSafeInteger(input.acceptedAtUnixMs) && input.acceptedAtUnixMs > 0, "ACCEPT_TIME", "invalid acceptedAt");
  invariant(Number.isSafeInteger(input.expiryUnixMs) && input.expiryUnixMs > input.acceptedAtUnixMs, "ACCEPT_EXPIRY", "acceptance expiry must be after acceptedAt");
  invariant(typeof input.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(input.nonce), "ACCEPT_NONCE", "invalid nonce");
  invariant(Number.isSafeInteger(input.policyEpoch) && input.policyEpoch >= 0, "ACCEPT_EPOCH", "invalid policy epoch");

  return Object.freeze({
    domain: ACCEPT_DOMAIN,
    protocolVersion: 1,
    offerId: input.offerId,
    tradeId: input.tradeId,
    deploymentId,
    taker: input.taker,
    offerHash: input.offerHash,
    acceptedAtUnixMs: input.acceptedAtUnixMs,
    expiryUnixMs: input.expiryUnixMs,
    nonce: input.nonce,
    policyEpoch: input.policyEpoch
  });
}

export function acceptanceDigestHex(acceptance) {
  return createHash("sha256").update(canonicalBytes(acceptance)).digest("hex");
}
