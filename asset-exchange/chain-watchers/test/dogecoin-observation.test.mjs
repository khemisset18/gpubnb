import test from "node:test";
import assert from "node:assert/strict";
import { assessDogeObservations } from "../src/dogecoin-observation.mjs";
const NOW = 1_800_000_000_000;
const base = { chainId:"dogecoin",networkId:"regtest",tipHash:"a".repeat(64),tipHeight:1359,
  observedTxid:"b".repeat(64),blockHash:"c".repeat(64),blockHeight:1356,confirmations:4,
  transactionFound:true,mempoolStatus:"ABSENT",conflictStatus:"NONE",observedAtUnixMs:NOW };
function rows(a = {}, b = {}) { return [{...base,sourceId:"doge-a",...a},{...base,sourceId:"doge-b",...b}]; }
function assess(value,options={}) { return assessDogeObservations(value,{nowUnixMs:NOW,...options}); }
test("matching independently sourced confirmations permit only a diagnostic next step", () => {
  const result=assess(rows());assert.equal(result.canAdvance,true);assert.equal(result.consistency,"CONSISTENT");
  assert.equal(result.settlementAllowed,false);assert.equal(result.qualificationStatus,"BLOCKED");
});
test("partitioned tips stop progression despite confirmations on both nodes", () => {
  const result=assess(rows({}, {tipHash:"d".repeat(64)}));
  assert.equal(result.consistency,"UNCERTAIN");assert.equal(result.canAdvance,false);
});
test("stale or unavailable evidence cannot carry prior settlement eligibility", () => {
  const stale=assess(rows({}, {observedAtUnixMs:NOW-60_001}));
  assert.equal(stale.states["doge-b"],"UNKNOWN");assert.equal(stale.canAdvance,false);
  const absent={transactionFound:false,confirmations:0,blockHash:null,blockHeight:null};
  assert.equal(assess(rows({},absent)).states["doge-b"],"UNKNOWN");
});
test("confirmed competing spend overrides a prior claim confirmation", () => {
  const conflict={transactionFound:false,confirmations:0,blockHash:null,blockHeight:null,conflictStatus:"CONFLICTED"};
  const result=assess(rows(conflict,conflict),{previousBySource:{"doge-a":base,"doge-b":base}});
  assert.equal(result.states["doge-a"],"CONFLICTED");assert.equal(result.consistency,"CONFLICT");assert.equal(result.canAdvance,false);
});
test("confirmation rollback is reorged even when the transaction returns to mempool", () => {
  const rollback={confirmations:0,blockHash:null,blockHeight:null,mempoolStatus:"PRESENT"};
  const result=assess(rows(rollback,rollback),{previousBySource:{"doge-a":base,"doge-b":base}});
  assert.equal(result.states["doge-a"],"REORGED");assert.equal(result.canAdvance,false);
});
test("a single confirmation cannot satisfy the two-confirmation profile", () => {
  const result=assess(rows({confirmations:1,blockHeight:1359},{confirmations:1,blockHeight:1359}));
  assert.equal(result.states["doge-a"],"CONFIRMED");assert.equal(result.canAdvance,false);
});
test("duplicate sources, wrong network, future time and incoherent native context reject", () => {
  for(const value of [rows({}, {sourceId:"doge-a"}),rows({}, {networkId:"main"}),
    rows({}, {observedAtUnixMs:NOW+1}),rows({}, {confirmations:3}),
    rows({}, {mempoolStatus:"PRESENT"}),rows({}, {conflictStatus:"CONFLICTED"}),
    rows({}, {transactionFound:false})]) assert.throws(()=>assess(value));
});

test("a new transaction does not inherit another transaction's reorg history", () => {
  const pending={confirmations:0,blockHash:null,blockHeight:null,mempoolStatus:"PRESENT"};
  const old={...base,observedTxid:"e".repeat(64)};
  const result=assess(rows(pending,pending),{previousBySource:{"doge-a":old,"doge-b":old}});
  assert.equal(result.states["doge-a"],"MEMPOOL");assert.equal(result.canAdvance,false);
});
