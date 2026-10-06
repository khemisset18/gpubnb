import test from "node:test";
import assert from "node:assert/strict";
import { createChainEvidence, createTipEvidence, evidenceConsistency, tipEvidenceConsistency } from "../src/evidence.mjs";

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

test("tip quorum requires two distinct sources", () => {
  const tip = {
    chainId: "bitcoin",
    networkId: "regtest",
    sourceId: "node-a",
    tipHash: "00".repeat(32),
    tipHeight: 100,
    observedAtUnixMs: 2000000000000
  };
  assert.throws(() => tipEvidenceConsistency([createTipEvidence(tip)]));
  assert.throws(() => tipEvidenceConsistency([createTipEvidence(tip), createTipEvidence({ ...tip })]));
});

test("different honest tips are uncertain, never consistent", () => {
  const a = createTipEvidence({
    chainId: "bitcoin", networkId: "regtest", sourceId: "node-a",
    tipHash: "11".repeat(32), tipHeight: 102, observedAtUnixMs: 2000000000000
  });
  const b = createTipEvidence({
    chainId: "bitcoin", networkId: "regtest", sourceId: "node-b",
    tipHash: "22".repeat(32), tipHeight: 104, observedAtUnixMs: 2000000000001
  });
  assert.equal(tipEvidenceConsistency([a, b]), "UNCERTAIN");
});

test("same hash with impossible different heights is conflict", () => {
  const a = createTipEvidence({
    chainId: "bitcoin", networkId: "regtest", sourceId: "node-a",
    tipHash: "33".repeat(32), tipHeight: 100, observedAtUnixMs: 2000000000000
  });
  const b = createTipEvidence({
    chainId: "bitcoin", networkId: "regtest", sourceId: "node-b",
    tipHash: "33".repeat(32), tipHeight: 101, observedAtUnixMs: 2000000000001
  });
  assert.equal(tipEvidenceConsistency([a, b]), "CONFLICT");
});

test("matching independent tips are consistent", () => {
  const a = createTipEvidence({
    chainId: "bitcoin", networkId: "regtest", sourceId: "node-a",
    tipHash: "44".repeat(32), tipHeight: 105, observedAtUnixMs: 2000000000000
  });
  const b = createTipEvidence({
    chainId: "bitcoin", networkId: "regtest", sourceId: "node-b",
    tipHash: "44".repeat(32), tipHeight: 105, observedAtUnixMs: 2000000000001
  });
  assert.equal(tipEvidenceConsistency([a, b]), "CONSISTENT");
});
