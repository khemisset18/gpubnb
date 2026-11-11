import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMoneroSnapshot, validateMoneroSnapshot, BLOCK_SAMPLE } from '../lib/monero-feed.mjs';
import { estimateMoneroYield } from '../lib/monero-direct.mjs';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const tipHeight = 3500000;
function fixtures() {
  const headers = Array.from({length:BLOCK_SAMPLE},(_,i)=>({
    height:tipHeight - BLOCK_SAMPLE + 1 + i,
    timestamp:Math.floor(now/1000)-(BLOCK_SAMPLE-i)*120,
    orphan_status:false, hash: String(i+1).padStart(64,'a'),
    wide_difficulty:'0x8bb2c97000', reward:'600000000000'
  }));
  return {
    info:{result:{status:'OK',untrusted:false,synchronized:true,nettype:'mainnet',
      offline:false,height:tipHeight+1}},
    last:{result:{status:'OK',untrusted:false,block_header:{...headers.at(-1)}}},
    range:{result:{status:'OK',untrusted:false,headers}}
  };
}
test('30 successive self-hosted blocks generate a fresh XMR snapshot',()=>{
  const {info,last,range}=fixtures();
  const snap=makeMoneroSnapshot(info,last,range,now);
  const parsed=validateMoneroSnapshot(snap,now);
  assert.ok(parsed);
  assert.equal(parsed.sampleBlocks,30);
  assert.equal(parsed.height,tipHeight);
  assert.equal(parsed.rewardXmr,.6);
  assert.ok(parsed.difficulty>0);
});
test('snapshot gives XMR forecasts, and euros only with a manual price',()=>{
  const {info,last,range}=fixtures();
  const network=validateMoneroSnapshot(makeMoneroSnapshot(info,last,range,now),now);
  const without=estimateMoneroYield({network,hashrateHps:10000,wattsPerDevice:100,electricityEurKwh:.2});
  assert.ok(without.expectedXmrDay>0);
  assert.equal(without.netEurDay,null);
  const withPrice=estimateMoneroYield({network,hashrateHps:10000,wattsPerDevice:100,electricityEurKwh:.2,xmrEur:100});
  assert.ok(Number.isFinite(withPrice.netEurDay));
  assert.equal(withPrice.netEurMonth30,withPrice.netEurDay*30);
  assert.equal(withPrice.netEurYear365,withPrice.netEurDay*365);
});
test('unsynchronized, remote-bootstrap or wrong-chain sources are rejected',()=>{
  for(const patch of [{synchronized:false},{untrusted:true},{nettype:'testnet'},{height:1},{offline:true}]){
    const {info,last,range}=fixtures();
    Object.assign(info.result,patch);
    assert.throws(()=>makeMoneroSnapshot(info,last,range,now));
  }
});
test('missing, shuffled, orphaned or invalid block samples are rejected',()=>{
  for(const mutate of [
    f=>f.range.result.headers.pop(),
    f=>{f.range.result.headers[1].height++;},
    f=>{f.range.result.headers[3].orphan_status=true;},
    f=>{f.range.result.headers.at(-1).hash='changed';},
    f=>{f.range.result.headers[0].reward='-10';},
    f=>{f.range.result.untrusted=true;}
  ]){
    const f=fixtures();mutate(f);
    assert.throws(()=>makeMoneroSnapshot(f.info,f.last,f.range,now));
  }
});
test('old, future, malformed, unsupported and empty snapshots never pass',()=>{
  const f=fixtures(), good=makeMoneroSnapshot(f.info,f.last,f.range,now);
  for(const changed of [
    {collectedAt:new Date(now-40*60000).toISOString()},
    {collectedAt:new Date(now+6*60000).toISOString()},
    {source:'external-data-provider'},
    {network:'testnet'},
    {difficulty:'10000'},
    {sampleBlocks:1},
    {rewardXmr:0},
    {blockTimestamp:new Date(now-90*60000).toISOString()}
  ])assert.equal(validateMoneroSnapshot({...good,...changed},now),null);
  assert.equal(validateMoneroSnapshot({status:'unavailable'},now),null);
});
