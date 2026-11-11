import { invariant } from "../../core/src/errors.mjs";
import { createChainEvidence, evidenceConsistency, tipEvidenceConsistency } from "./evidence.mjs";

const HASH = /^[0-9a-f]{64}$/;

/** Strict private-DOGE observation adapter; it never authorizes settlement. */
export function assessDogeObservations(input, {
  previousBySource = {}, nowUnixMs = Date.now(), maxAgeMs = 60_000, minimumConfirmations = 2
} = {}) {
  invariant(Array.isArray(input) && input.length >= 2 && input.length <= 8, "DOGE_QUORUM", "two to eight independent observations required");
  invariant(Number.isSafeInteger(nowUnixMs) && nowUnixMs > 0 && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0,
    "DOGE_TIME", "bounded observation clock required");
  invariant(Number.isSafeInteger(minimumConfirmations) && minimumConfirmations >= 1, "DOGE_CONFIRMATIONS", "positive confirmation threshold required");
  const parsed = input.map((row) => {
    invariant(row && row.chainId === "dogecoin" && row.networkId === "regtest", "DOGE_NETWORK", "private Dogecoin profile required");
    invariant(HASH.test(row.tipHash) && HASH.test(row.observedTxid), "DOGE_HASH", "canonical Dogecoin identifiers required");
    invariant(typeof row.transactionFound === "boolean", "DOGE_FOUND", "explicit transaction lookup result required");
    const { transactionFound, ...base } = row;
    const evidence = createChainEvidence(base);
    if (evidence.confirmations > 0) {
      invariant(transactionFound && HASH.test(evidence.blockHash) && Number.isSafeInteger(evidence.blockHeight)
        && evidence.tipHeight - evidence.blockHeight + 1 === evidence.confirmations
        && evidence.mempoolStatus === "ABSENT" && evidence.conflictStatus === "NONE",
      "DOGE_CONFIRMATION_CONTEXT", "confirmed transaction needs coherent native block context");
    } else {
      invariant(evidence.blockHash === null && evidence.blockHeight === null,
        "DOGE_UNCONFIRMED_CONTEXT", "unconfirmed observation must not carry a confirmation anchor");
    }
    invariant(evidence.observedAtUnixMs <= nowUnixMs, "DOGE_FUTURE", "future observations rejected");
    const fresh = nowUnixMs - evidence.observedAtUnixMs <= maxAgeMs;
    const previous = previousBySource[evidence.sourceId];
    let state = "UNKNOWN";
    if (fresh) {
      if (evidence.conflictStatus === "CONFLICTED") state = "CONFLICTED";
      else if (evidence.conflictStatus === "UNKNOWN" || evidence.mempoolStatus === "UNKNOWN") state = "UNKNOWN";
      else if (evidence.confirmations > 0) state = "CONFIRMED";
      else if (previous?.observedTxid === evidence.observedTxid && previous?.confirmations > 0) state = "REORGED";
      else if (evidence.mempoolStatus === "PRESENT") state = "MEMPOOL";
      else if (transactionFound) state = "OBSERVED";
    }
    return { evidence, state, fresh };
  });
  const tips = parsed.map(({ evidence }) => ({
    chainId: evidence.chainId, networkId: evidence.networkId, sourceId: evidence.sourceId,
    tipHash: evidence.tipHash, tipHeight: evidence.tipHeight, observedAtUnixMs: evidence.observedAtUnixMs
  }));
  const tipConsistency = tipEvidenceConsistency(tips);
  const transactionConsistency = evidenceConsistency(parsed.map(({ evidence }) => evidence));
  const everyFresh = parsed.every(({ fresh }) => fresh);
  const consistency = transactionConsistency === "CONFLICT" ? "CONFLICT"
    : !everyFresh || tipConsistency !== "CONSISTENT" || transactionConsistency !== "CONSISTENT" ? "UNCERTAIN" : "CONSISTENT";
  return Object.freeze({
    chainId: "dogecoin", networkId: "regtest", tipConsistency, transactionConsistency, consistency, everyFresh,
    states: Object.fromEntries(parsed.map(({ evidence, state }) => [evidence.sourceId, state])),
    canAdvance: consistency === "CONSISTENT" && parsed.every(({ evidence, state }) => state === "CONFIRMED"
      && evidence.confirmations >= minimumConfirmations),
    settlementAllowed: false, qualificationStatus: "BLOCKED"
  });
}
