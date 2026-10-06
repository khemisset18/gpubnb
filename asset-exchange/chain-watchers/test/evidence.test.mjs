import test from "node:test";
import assert from "node:assert/strict";
import { createChainEvidence, evidenceConsistency } from "../src/evidence.mjs";

const base = {
  chainId: "bitcoin",
  networkId: "regtest",
  sourceId: "node-a",
  tipHash: "tiphash0001",
  tipHeight: 100,
  observedTxid: "txid00000001",
  blockHash: "blockhash001",
  blockHeight: 99,
  confirmations: 2,
  mempoolStatus: "ABSENT",
  conflictStatus: "NONE",
  observedAtUnixMs: 2000000000000
};

test("watcher evidence rejects unknown fields", () => {
  assert.throws(() => createChainEvidence({ ...base, trustMe: true }));
});

test("disagreement never collapses to trusted evidence", () => {
  const a = createChainEvidence(base);
  const b = createChainEvidence({ ...base, sourceId: "node-b", blockHash: "blockhash999" });
  assert.equal(evidenceConsistency([a, b]), "UNCERTAIN");
});

test("network mismatch is a conflict", () => {
  const a = createChainEvidence(base);
  const b = createChainEvidence({ ...base, sourceId: "node-b", networkId: "testnet" });
  assert.equal(evidenceConsistency([a, b]), "CONFLICT");
});
