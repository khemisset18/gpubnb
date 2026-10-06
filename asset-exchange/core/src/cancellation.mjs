import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { validateDeploymentId } from "./deployment.mjs";

export const CANCEL_DOMAIN = "GPUBNB:ASSET-EXCHANGE:CANCEL:v1";

export function createCancellation(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "CANCEL_TYPE", "cancellation must be an object");

  const allowed = new Set([
    "offerId", "deploymentId", "maker", "offerHash", "cancelledAtUnixMs",
    "expiryUnixMs", "nonce", "policyEpoch"
  ]);
  for (const key of Object.keys(input)) {
    invariant(allowed.has(key), "CANCEL_UNKNOWN_FIELD", `unknown cancellation field: ${key}`);
  }

  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof input.offerId === "string" && input.offerId.length >= 8 && input.offerId.length <= 128, "CANCEL_OFFER_ID", "invalid offerId");
  invariant(typeof input.maker === "string" && input.maker.length >= 3 && input.maker.length <= 256, "CANCEL_MAKER", "invalid maker");
  invariant(typeof input.offerHash === "string" && /^[0-9a-f]{64}$/.test(input.offerHash), "CANCEL_OFFER_HASH", "invalid offer hash");
  invariant(Number.isSafeInteger(input.cancelledAtUnixMs) && input.cancelledAtUnixMs > 0, "CANCEL_TIME", "invalid cancellation time");
  invariant(Number.isSafeInteger(input.expiryUnixMs) && input.expiryUnixMs > input.cancelledAtUnixMs, "CANCEL_EXPIRY", "cancellation expiry must be after cancellation time");
  invariant(typeof input.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(input.nonce), "CANCEL_NONCE", "invalid cancellation nonce");
  invariant(Number.isSafeInteger(input.policyEpoch) && input.policyEpoch >= 0, "CANCEL_EPOCH", "invalid policy epoch");

  return Object.freeze({
    domain: CANCEL_DOMAIN,
    protocolVersion: 1,
    offerId: input.offerId,
    deploymentId,
    maker: input.maker,
    offerHash: input.offerHash,
    cancelledAtUnixMs: input.cancelledAtUnixMs,
    expiryUnixMs: input.expiryUnixMs,
    nonce: input.nonce,
    policyEpoch: input.policyEpoch
  });
}

export function cancellationDigestHex(cancellation) {
  return createHash("sha256").update(canonicalBytes(cancellation)).digest("hex");
}
