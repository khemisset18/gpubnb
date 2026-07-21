import test from 'node:test'; import assert from 'node:assert/strict'; import {calculateSettlement} from '../src/settlement.js';
test('full pay at 90 percent',()=>{const x=calculateSettlement(100_000_000n,3240,3600);assert.equal(x.providerLamports,95_000_000n);assert.equal(x.platformLamports,5_000_000n);assert.equal(x.refundLamports,0n)});
test('pro rata below threshold',()=>{const x=calculateSettlement(100_000_000n,2700,3600);assert.equal(x.payableLamports,75_000_000n);assert.equal(x.platformLamports,3_750_000n);assert.equal(x.providerLamports,71_250_000n);assert.equal(x.refundLamports,25_000_000n)});
test('invariant over sample durations',()=>{for(let s=0;s<=3600;s++){const x=calculateSettlement(987654321n,s,3600);assert.equal(x.providerLamports+x.platformLamports+x.refundLamports,x.grossLamports)}});

test('zero usage refunds the full amount',()=>{
  const s=calculateSettlement(1_000_000n,0,1000);
  assert.equal(s.payableLamports,0n);
  assert.equal(s.platformLamports,0n);
  assert.equal(s.providerLamports,0n);
  assert.equal(s.refundLamports,1_000_000n);
});

test('89.9 percent remains proportional',()=>{
  const s=calculateSettlement(1_000_000n,899,1000);
  assert.equal(s.payableLamports,899_000n);
  assert.equal(s.platformLamports,44_950n);
  assert.equal(s.providerLamports,854_050n);
  assert.equal(s.refundLamports,101_000n);
});

test('rejects invalid durations',()=>{
  assert.throws(()=>calculateSettlement(100n,-1,100));
  assert.throws(()=>calculateSettlement(100n,101,100));
  assert.throws(()=>calculateSettlement(100n,0,0));
});

test('one lamport never creates money',()=>{
  for(let valid=0; valid<=10; valid++){
    const s=calculateSettlement(1n,valid,10);
    assert.equal(s.providerLamports+s.platformLamports+s.refundLamports,1n);
  }
});
