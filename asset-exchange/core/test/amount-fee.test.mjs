import test from "node:test";
import assert from "node:assert/strict";
import { parseAtomicAmount, checkedAdd, createFeePolicy, calculateFee } from "../src/index.mjs";
test("atomic amounts reject floats, signs and leading zeros", () => {
  for (const value of ["1.0","-1","+1","01","","1e3"]) assert.throws(() => parseAtomicAmount(value));
  assert.equal(parseAtomicAmount("0"),0n);
  assert.equal(parseAtomicAmount("100000000"),100000000n);
});
test("checkedAdd rejects u128 overflow", () => {
  const max=(1n<<128n)-1n;
  assert.equal(checkedAdd(max-1n,1n),max);
  assert.throws(()=>checkedAdd(max,1n));
});
test("fee math is exact integer floor", () => {
  const policy=createFeePolicy({policyId:"default-taker-v1",version:1,rateBps:35,payerRole:"TAKER",feeAssetKey:"bitcoin|regtest|NATIVE|BTC_NATIVE|8",recipient:"treasury:test"});
  assert.equal(calculateFee("100000000",policy),"350000");
  assert.equal(calculateFee("1",policy),"0");
});
test("operator rate is configurable but safety bounded", () => {
  const base={policyId:"operator-fee-v2",version:2,payerRole:"TAKER",feeAssetKey:"bitcoin|regtest|NATIVE|BTC_NATIVE|8",recipient:"treasury:test"};
  assert.equal(createFeePolicy({...base,rateBps:250}).rateBps,250);
  assert.throws(()=>createFeePolicy({...base,rateBps:501},{maxRateBps:500}));
});
