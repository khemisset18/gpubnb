import { createHash, randomUUID } from "node:crypto";
import { createAssetIdentity, assetKey } from "./asset.mjs";
import { parseAtomicAmount, atomicAmountToString } from "./amount.mjs";
import { createFeePolicy } from "./fee-policy.mjs";
import { canonicalBytes } from "./canonical.mjs";
import { invariant } from "./errors.mjs";
import { validateDeploymentId } from "./deployment.mjs";
export const OFFER_DOMAIN = "GPUBNB:ASSET-EXCHANGE:OFFER:v1";
export function createUnsignedOffer(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "OFFER_TYPE", "offer must be an object");
  const allowed = new Set(["offerId","deploymentId","maker","giveAsset","giveAmountAtomic","wantAsset","wantAmountAtomic","expiryUnixMs","nonce","policyEpoch","feePolicy"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "OFFER_UNKNOWN_FIELD", `unknown offer field: ${key}`);
  const offerId = input.offerId ?? randomUUID();
  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof offerId === "string" && offerId.length >= 8 && offerId.length <= 128, "OFFER_ID", "invalid offerId");
  invariant(typeof input.maker === "string" && input.maker.length >= 3 && input.maker.length <= 256, "OFFER_MAKER", "invalid maker");
  invariant(Number.isSafeInteger(input.expiryUnixMs) && input.expiryUnixMs > 0, "OFFER_EXPIRY", "invalid expiry");
  invariant(typeof input.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(input.nonce), "OFFER_NONCE", "invalid nonce");
  invariant(Number.isSafeInteger(input.policyEpoch) && input.policyEpoch >= 0, "OFFER_EPOCH", "invalid policy epoch");
  const giveAsset = createAssetIdentity(input.giveAsset);
  const wantAsset = createAssetIdentity(input.wantAsset);
  const giveAmountAtomic = atomicAmountToString(parseAtomicAmount(input.giveAmountAtomic));
  const wantAmountAtomic = atomicAmountToString(parseAtomicAmount(input.wantAmountAtomic));
  invariant(giveAmountAtomic !== "0" && wantAmountAtomic !== "0", "OFFER_ZERO_AMOUNT", "trade amounts must be greater than zero");
  const feePolicy = createFeePolicy(input.feePolicy);
  return Object.freeze({
    domain: OFFER_DOMAIN, protocolVersion: 1, offerId, deploymentId, maker: input.maker,
    giveAsset, giveAssetKey: assetKey(giveAsset), giveAmountAtomic,
    wantAsset, wantAssetKey: assetKey(wantAsset), wantAmountAtomic,
    expiryUnixMs: input.expiryUnixMs, nonce: input.nonce, policyEpoch: input.policyEpoch, feePolicy
  });
}
export function offerDigestHex(offer) {
  return createHash("sha256").update(canonicalBytes(offer)).digest("hex");
}
