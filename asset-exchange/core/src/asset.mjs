import { invariant } from "./errors.mjs";
const CHAIN_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ASSET_TYPES = new Set(["NATIVE", "TOKEN", "NFT"]);
function exactString(value, field, max = 256) {
  invariant(typeof value === "string", "ASSET_FIELD_TYPE", `${field} must be a string`);
  invariant(value.length > 0 && value.length <= max, "ASSET_FIELD_LENGTH", `${field} length invalid`);
  invariant(value === value.trim(), "ASSET_FIELD_CANONICAL", `${field} must not have surrounding whitespace`);
  return value;
}
export function createAssetIdentity(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "ASSET_TYPE", "asset identity must be an object");
  const allowed = new Set(["chainId", "networkId", "assetType", "assetId", "decimals"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "ASSET_UNKNOWN_FIELD", `unknown asset field: ${key}`);
  const chainId = exactString(input.chainId, "chainId", 64);
  const networkId = exactString(input.networkId, "networkId", 64);
  invariant(CHAIN_RE.test(chainId), "ASSET_CHAIN_ID", "chainId must already be canonical lowercase ASCII");
  invariant(CHAIN_RE.test(networkId), "ASSET_NETWORK_ID", "networkId must already be canonical lowercase ASCII");
  const assetType = exactString(input.assetType, "assetType", 16);
  invariant(ASSET_TYPES.has(assetType), "ASSET_TYPE_UNSUPPORTED", "unsupported assetType");
  const assetId = exactString(input.assetId, "assetId", 256);
  invariant(Number.isInteger(input.decimals), "ASSET_DECIMALS_TYPE", "decimals must be an integer");
  invariant(input.decimals >= 0 && input.decimals <= 255, "ASSET_DECIMALS_RANGE", "decimals out of range");
  return Object.freeze({ chainId, networkId, assetType, assetId, decimals: input.decimals });
}
export function assetKey(asset) {
  const a = createAssetIdentity(asset);
  return `${a.chainId}|${a.networkId}|${a.assetType}|${a.assetId}|${a.decimals}`;
}
