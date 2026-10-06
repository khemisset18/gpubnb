import { invariant } from "../../core/src/errors.mjs";

const MEMPOOL = new Set(["UNKNOWN","ABSENT","PRESENT"]);
const CONFLICT = new Set(["UNKNOWN","NONE","CONFLICTED"]);

function canonicalId(value, field) {
  invariant(typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value), "EVIDENCE_ID", `${field} must be canonical lowercase ASCII`);
  return value;
}

export function createChainEvidence(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "EVIDENCE_TYPE", "chain evidence must be an object");

  const allowed = new Set([
    "chainId","networkId","sourceId","tipHash","tipHeight","observedTxid","blockHash","blockHeight",
    "confirmations","mempoolStatus","conflictStatus","observedAtUnixMs"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "EVIDENCE_UNKNOWN_FIELD", `unknown evidence field: ${key}`);

  const chainId = canonicalId(input.chainId, "chainId");
  const networkId = canonicalId(input.networkId, "networkId");
  const sourceId = canonicalId(input.sourceId, "sourceId");

  for (const [field, value] of [["tipHeight", input.tipHeight], ["confirmations", input.confirmations]]) {
    invariant(Number.isSafeInteger(value) && value >= 0, "EVIDENCE_NUMBER", `${field} must be a non-negative integer`);
  }

  invariant(typeof input.tipHash === "string" && input.tipHash.length >= 8 && input.tipHash.length <= 128, "EVIDENCE_TIP_HASH", "invalid tip hash");
  invariant(typeof input.observedTxid === "string" && input.observedTxid.length >= 8 && input.observedTxid.length <= 128, "EVIDENCE_TXID", "invalid txid");
  invariant(input.blockHash == null || (typeof input.blockHash === "string" && input.blockHash.length >= 8 && input.blockHash.length <= 128), "EVIDENCE_BLOCK_HASH", "invalid block hash");
  invariant(input.blockHeight == null || (Number.isSafeInteger(input.blockHeight) && input.blockHeight >= 0), "EVIDENCE_BLOCK_HEIGHT", "invalid block height");
  invariant(MEMPOOL.has(input.mempoolStatus), "EVIDENCE_MEMPOOL", "invalid mempool status");
  invariant(CONFLICT.has(input.conflictStatus), "EVIDENCE_CONFLICT", "invalid conflict status");
  invariant(Number.isSafeInteger(input.observedAtUnixMs) && input.observedAtUnixMs > 0, "EVIDENCE_TIME", "invalid observation timestamp");

  return Object.freeze({
    chainId, networkId, sourceId,
    tipHash: input.tipHash, tipHeight: input.tipHeight,
    observedTxid: input.observedTxid,
    blockHash: input.blockHash ?? null,
    blockHeight: input.blockHeight ?? null,
    confirmations: input.confirmations,
    mempoolStatus: input.mempoolStatus,
    conflictStatus: input.conflictStatus,
    observedAtUnixMs: input.observedAtUnixMs
  });
}

export function evidenceConsistency(evidences) {
  invariant(Array.isArray(evidences) && evidences.length > 0, "EVIDENCE_SET", "at least one evidence record required");
  const parsed = evidences.map(createChainEvidence);
  const first = parsed[0];

  for (const item of parsed.slice(1)) {
    if (item.chainId !== first.chainId || item.networkId !== first.networkId || item.observedTxid !== first.observedTxid) {
      return "CONFLICT";
    }
    if (item.conflictStatus === "CONFLICTED" || first.conflictStatus === "CONFLICTED") return "CONFLICT";
    if (item.blockHash !== first.blockHash && item.confirmations > 0 && first.confirmations > 0) return "UNCERTAIN";
  }

  return "CONSISTENT";
}
