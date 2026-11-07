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

function permutations(items) {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]));
}

const tipBase = {
  chainId: "bitcoin", networkId: "regtest", sourceId: "node-a",
  tipHash: "11".repeat(32), tipHeight: 100, observedAtUnixMs: 2000000000000
};

test("tip uncertainty cannot hide a later network conflict in any ordering", () => {
  const rows = [tipBase,
    { ...tipBase, sourceId: "node-b", tipHash: "22".repeat(32) },
    { ...tipBase, sourceId: "node-c", networkId: "mainnet" }];
  for (const order of permutations(rows)) assert.equal(tipEvidenceConsistency(order), "CONFLICT");
});

test("tip hash-height contradictions are checked between every source", () => {
  const rows = [tipBase,
    { ...tipBase, sourceId: "node-b", tipHash: "22".repeat(32) },
    { ...tipBase, sourceId: "node-c", tipHash: "22".repeat(32), tipHeight: 101 }];
  for (const order of permutations(rows)) assert.equal(tipEvidenceConsistency(order), "CONFLICT");
});

test("a single conflicted transaction observation is never consistent", () => {
  assert.equal(evidenceConsistency([{ ...base, conflictStatus: "CONFLICTED" }]), "CONFLICT");
});

test("transaction uncertainty cannot hide later conflicts in any ordering", () => {
  for (const mutation of [{ networkId: "mainnet" }, { observedTxid: "different-txid" }, { conflictStatus: "CONFLICTED" }]) {
    const rows = [base,
      { ...base, sourceId: "node-b", blockHash: "different-block" },
      { ...base, sourceId: "node-c", ...mutation }];
    for (const order of permutations(rows)) assert.equal(evidenceConsistency(order), "CONFLICT");
  }
});

test("unconfirmed first observation cannot hide conflicting confirmed inclusions", () => {
  const rows = [{ ...base, confirmations: 0, blockHash: null, blockHeight: null },
    { ...base, sourceId: "node-b" },
    { ...base, sourceId: "node-c", blockHash: "different-block" }];
  for (const order of permutations(rows)) assert.equal(evidenceConsistency(order), "UNCERTAIN");
});
