import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRvnObservation,RVN_WINDOW} from '../lib/rvn-observer.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';
const now=Date.parse('2026-11-11T12:00:00.000Z'),tip=4000000;
function fixture(){
 const blocks=Array.from({length:RVN_WINDOW+1},(_,i)=>{
  const height=tip-RVN_WINDOW+i;
  return {height,time:Math.floor(now/1000)-200-(RVN_WINDOW-i)*60,
   hash:height.toString(16).padStart(64,'0'),
   previousblockhash:(height-1).toString(16).padStart(64,'0'),
   confirmations:RVN_WINDOW+1-i,
   tx:[{vin:[{coinbase:'010000'}],vout:[{value:1250}]}]};
 });
 return {info:{chain:'main',initialblockdownload:false,blocks:tip,headers:tip,bestblockhash:blocks.at(-1).hash},
  networkHashps:500000000,blocks};
}
test('32 RVN blocks generate validated 120-block network hashrate snapshot',()=>{
 const s=buildRvnObservation(fixture(),now);
 assert.equal(s.coin,'RVN');assert.equal(s.algorithm,'KawPoW');
 assert.equal(s.blockSeconds,60);
 assert.equal(s.minerRewardCoins,1250);
 assert.equal(s.networkRate,500000000);
 assert.ok(validateOwnPoWSnapshot(s,now));
});
test('coinbase fees are included in miner payouts, not arbitrary fixed subsidy',()=>{
 const f=fixture();
 f.blocks[1].tx[0].vout.push({value:0.1});
 const s=buildRvnObservation(f,now);
 assert.ok(s.minerRewardCoins>1250);
 assert.match(s.methodology,/incl fees/);
});
test('testnet, unsynced, missing headers and reorg must fail',()=>{
 for(const patch of [{chain:'test'},{initialblockdownload:true},{headers:tip+40},{bestblockhash:'0'.repeat(64)}]){
  const f=fixture();Object.assign(f.info,patch);
  assert.throws(()=>buildRvnObservation(f,now));
 }
 const f=fixture();f.blocks[10].previousblockhash='f'.repeat(64);
 assert.throws(()=>buildRvnObservation(f,now));
});
test('reject missing coinbase, malformed reward, stale tip or invalid hashrate',()=>{
 const mutations=[
  f=>{f.blocks[5].tx=[]},
  f=>{f.blocks[5].tx[0].vout[0].value=-1},
  f=>{f.networkHashps=0},
  f=>{f.blocks.at(-1).time=Math.floor((now-3600000)/1000)}
 ];
 for(const change of mutations){const f=fixture();change(f);assert.throws(()=>buildRvnObservation(f,now));}
});
