import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEtcObservation,etcSubsidyAtHeight,ETC_WINDOW} from '../lib/etc-observer.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';
const now=Date.parse('2026-11-11T12:00:00Z'),height=25700000;
function fixture(){
 const blocks=Array.from({length:ETC_WINDOW+1},(_,i)=>{
  const n=height-ETC_WINDOW+i;
  return {number:'0x'+n.toString(16),timestamp:'0x'+(now/1000-500+13*i).toString(16),
   difficulty:'0x'+(2000000000000000n).toString(16),
   hash:'0x'+n.toString(16).padStart(64,'0'),
   parentHash:'0x'+(n-1).toString(16).padStart(64,'0')};
 });
 return {chainId:'0x3d',syncing:false,blocks};
}
test('ECIP-1017 ETC block reward decreases at exact 5m boundaries',()=>{
 assert.equal(etcSubsidyAtHeight(25000000),2.0480000000000005);
 assert.ok(Math.abs(etcSubsidyAtHeight(25000001)-1.6384)<1e-12);
 assert.ok(Math.abs(etcSubsidyAtHeight(30000001)-1.31072)<1e-12);
});
test('self-hosted ETC sample produces valid H/s and 32-block snapshot',()=>{
 const s=buildEtcObservation(fixture(),now);
 assert.equal(s.coin,'ETC');assert.equal(s.algorithm,'Etchash');
 assert.equal(s.blockHeight,height);assert.ok(s.networkRate>0);
 assert.equal(s.blockSeconds,13);assert.ok(s.minerRewardCoins>0);
 assert.ok(validateOwnPoWSnapshot(s,now));
});
test('wrong chain, unsynced node, mismatched hashes rejected',()=>{
 for(const patch of [{chainId:'0x1'},{syncing:{}},{chainId:'0x3d',syncing:true}]){
  assert.throws(()=>buildEtcObservation({...fixture(),...patch},now));
 }
 const f=fixture();f.blocks[4].parentHash='0x'+'f'.repeat(64);
 assert.throws(()=>buildEtcObservation(f,now));
});
test('stale tip and incoherent timestamps/difficulty are rejected',()=>{
 const f=fixture();f.blocks.at(-1).timestamp='0x'+Math.floor((now-3600000)/1000).toString(16);
 assert.throws(()=>buildEtcObservation(f,now));
 const f2=fixture();f2.blocks[8].difficulty='0x0';
 assert.throws(()=>buildEtcObservation(f2,now));
 const f3=fixture();f3.blocks[8].timestamp=f3.blocks[7].timestamp;
 assert.throws(()=>buildEtcObservation(f3,now));
});
test('never include guessed transaction fees or uncle payouts',()=>{
 const s=buildEtcObservation(fixture(),now);
 assert.match(s.methodology,/excluding fees, uncles and MEV/);
});

test('only an explicitly restricted ETC RPC can omit eth_syncing',()=>{
 assert.throws(()=>buildEtcObservation({...fixture(),syncing:null},now));
 const withOptIn=buildEtcObservation({...fixture(),syncing:null,allowMissingSyncStatus:true},now);
 assert.equal(withOptIn.coin,'ETC');
 assert.ok(validateOwnPoWSnapshot(withOptIn,now));
 const malicious=fixture();malicious.blocks.at(-1).parentHash='0x'+'a'.repeat(64);
 assert.throws(()=>buildEtcObservation({...malicious,syncing:null,allowMissingSyncStatus:true},now));
});
