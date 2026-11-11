import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMoneroHeader,estimateMoneroYield} from '../lib/monero-direct.mjs';
const now=Date.parse('2026-11-11T12:00:00Z');
const rpc=()=>({result:{status:'OK',untrusted:false,
  block_header:{height:3500000,timestamp:now/1000-120,
    wide_difficulty:'0x'+(600000000000n).toString(16),reward:'600000000000'}}});
test('own node block header is parsed, including 12-decimal reward',()=>{
  const n=parseMoneroHeader(rpc(),now);
  assert.equal(n.difficulty,600000000000);
  assert.equal(n.rewardXmr,.6);
  assert.equal(n.rewardIncludesTxFees,true);
});
test('only theoretical XMR is calculated without EUR price',()=>{
  const n=parseMoneroHeader(rpc(),now);
  const v=estimateMoneroYield({network:n,hashrateHps:10000,wattsPerDevice:120,electricityEurKwh:.2});
  assert.ok(Math.abs(v.expectedXmrDay-.000864)<1e-12);
  assert.equal(v.grossEurDay,null);assert.equal(v.netEurDay,null);
  assert.ok(Math.abs(v.energyEurDay-.576)<1e-12);
});
test('user supplied EUR price yields net day/month/year projections',()=>{
  const n=parseMoneroHeader(rpc(),now);
  const v=estimateMoneroYield({network:n,hashrateHps:10000,wattsPerDevice:120,
    electricityEurKwh:.2,xmrEur:100,poolFeePercent:1});
  assert.ok(Math.abs(v.grossEurDay-.0864)<1e-12);
  assert.ok(Math.abs(v.netEurDay-(-.490464))<1e-12);
  assert.ok(Math.abs(v.netEurMonth30-v.netEurDay*30)<1e-12);
  assert.ok(Math.abs(v.netEurYear365-v.netEurDay*365)<1e-12);
});
test('stale future and untrusted block headers are always rejected',()=>{
  const untrusted=rpc();untrusted.result.untrusted=true;
  assert.throws(()=>parseMoneroHeader(untrusted,now));
  const stale=rpc();stale.result.block_header.timestamp=now/1000-3600;
  assert.throws(()=>parseMoneroHeader(stale,now));
  const future=rpc();future.result.block_header.timestamp=now/1000+3600;
  assert.throws(()=>parseMoneroHeader(future,now));
});
test('reject fractional device counts and negative prices',()=>{
  const network=parseMoneroHeader(rpc(),now);
  assert.throws(()=>estimateMoneroYield({network,hashrateHps:1000,quantity:1.5}));
  assert.throws(()=>estimateMoneroYield({network,hashrateHps:1000,xmrEur:-1}));
});
