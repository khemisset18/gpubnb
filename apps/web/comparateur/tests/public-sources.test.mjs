import test from 'node:test';
import assert from 'node:assert/strict';
import {collectMoneroPublic,collectEtcPublic,collectRvnPublic,rvnHalvingSubsidy,MONERO_SOURCES,ETC_SOURCES} from '../edge/public-sources.mjs';
import {validateMoneroSnapshot} from '../lib/monero-feed.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';

const now=Date.parse('2026-11-11T20:00:00Z'),h=3500000, heightEtc=26000000,heightRvn=4621000;
function moneroFixtures(){
 const headers=Array.from({length:30},(_,i)=>({
  height:h-29+i,timestamp:now/1000-200-(29-i)*120,
  wide_difficulty:'600000000000',reward:'600000000000',
  hash:(h-29+i).toString(16).padStart(64,'0'),orphan_status:false
 }));
 const tip=headers.at(-1);
 return {info:{status:'OK',untrusted:false,synchronized:true,nettype:'mainnet',offline:false,height:h+1},
  last:{result:{status:'OK',untrusted:false,block_header:tip}},
  range:{result:{status:'OK',untrusted:false,headers}}};
}
function etcBlocks(){
 return Array.from({length:33},(_,i)=>{
  const n=heightEtc-32+i;
  return {number:'0x'+n.toString(16),
   timestamp:'0x'+(now/1000-650+i*13).toString(16),
   difficulty:'0x'+(2000000000000000n).toString(16),
   hash:'0x'+n.toString(16).padStart(64,'0'),
   parentHash:'0x'+(n-1).toString(16).padStart(64,'0')};
 });
}
function rvnBlocks(){
 return Array.from({length:33},(_,i)=>{
   const n=heightRvn-i;
   return {height:n,hash:n.toString(16).padStart(64,'0'),
    time:now/1000-200-i*60,difficulty:7200,tx_count:1};
 });
}
const reply=(payload,status=200)=>new Response(JSON.stringify(payload),{status,
 headers:{'Content-Type':'application/json'}});
function mockFetch(options={}){
 const m=moneroFixtures(),e=etcBlocks(),r=rvnBlocks();
 const calls=[];
 const fetchImpl=async (uri,init={})=>{
  const url=new URL(uri);calls.push({host:url.hostname,path:url.pathname,method:init.method});
  if(['monero.rs','xmr.nodely.dev','xmr.hostingwire.net'].includes(url.hostname)){
   if(options.moneroDown?.includes(url.hostname))return reply({unavailable:true},503);
   if(url.pathname==='/get_info')return reply({...m.info,...(options.moneroWrongNetwork?.includes(url.hostname)?{nettype:'testnet'}:{})});
   const payload=JSON.parse(init.body||'null');
   if(payload.method==='get_last_block_header'){
    const value=options.moneroMismatch?.includes(url.hostname)?
      {...m.last.result,block_header:{...m.last.result.block_header,hash:'f'.repeat(64)}}:
      m.last.result;
    return reply({result:value});
   }
   if(payload.method==='get_block_header_by_height'){
    const height=payload.params.height;
    return reply({result:{status:'OK',untrusted:false,block_header:m.range.result.headers.find(x=>x.height===height)}});
   }
   if(payload.method==='get_block_headers_range')return reply(m.range);
  }
  if(['etc.blockscout.com','rpc.etcmc.xyz','etc.etcdesktop.com'].includes(url.hostname)){
   if(options.etcDown?.includes(url.hostname))return reply({error:'outage'},503);
   const payload=JSON.parse(init.body);
   if(Array.isArray(payload))return reply(payload.map(x=>({id:x.id,jsonrpc:'2.0',
      result:e[Number(BigInt(x.params[0]))-heightEtc+32]})).reverse());
   const values={eth_chainId:options.etcWrongChain?.includes(url.hostname)?'0x1':'0x3d',
     eth_syncing:false,eth_blockNumber:'0x'+heightEtc.toString(16)};
   return reply({jsonrpc:'2.0',id:1,result:values[payload.method]});
  }
  if(url.hostname==='api.ravencoinexplorer.com'){
   if(options.rvnDown)return reply({unavailable:true},429);
   if(url.pathname==='/api/v1/status')return reply({ok:true,data:{
    chain:'main',sync_complete:true,chain_status:'normal',incident_active:false,
    node_height:heightRvn,db_height:heightRvn}});
   if(url.pathname==='/api/v1/blocks/latest')return reply({ok:true,data:{items:r}});
  }
  throw Error('Unknown mocked endpoint: '+uri);
 };
 return {fetchImpl,calls};
}
test('Monero main + backup agree independently; primary chosen first',async()=>{
 const {fetchImpl,calls}=mockFetch();
 const result=await collectMoneroPublic(fetchImpl,now);
 assert.equal(result.source,'public-monero-rpc');
 assert.deepEqual(result.operators,['monero.rs','nodely.io']);
 assert.equal(result.activeOperator,'monero.rs');
 assert.equal(result.usedFallback,false);
 assert.equal(result.sampleBlocks,30);
 assert.ok(validateMoneroSnapshot(result,now));
 assert.ok(!calls.some(x=>x.host==='xmr.hostingwire.net'));
 assert.equal(calls.filter(x=>x.path==='/get_info').length,2);
});
test('Monero primary failure -> two independent backups; switches back on recovery',async()=>{
 const down=mockFetch({moneroDown:['monero.rs']});
 const backup=await collectMoneroPublic(down.fetchImpl,now);
 assert.deepEqual(backup.operators,['nodely.io','hostingwire.net']);
 assert.equal(backup.activeOperator,'nodely.io');
 assert.equal(backup.usedFallback,true);
 assert.ok(validateMoneroSnapshot(backup,now));
 const recovered=await collectMoneroPublic(mockFetch().fetchImpl,now);
 assert.equal(recovered.activeOperator,'monero.rs');
 assert.equal(recovered.usedFallback,false);
});
test('Monero invalid primary -> backups; two-node quorum mandatory',async()=>{
 const disagree=mockFetch({moneroMismatch:['monero.rs']});
 const fallback=await collectMoneroPublic(disagree.fetchImpl,now);
 assert.equal(fallback.usedFallback,true);
 assert.deepEqual(fallback.operators,['nodely.io','hostingwire.net']);
 await assert.rejects(collectMoneroPublic(mockFetch({moneroDown:['monero.rs','xmr.hostingwire.net']}).fetchImpl,now));
 const mismatch=mockFetch({moneroMismatch:['xmr.nodely.dev','xmr.hostingwire.net']});
 // Two bad nodes that agree may still be untrustworthy; independent public RPC is not cryptographic proof.
 // A group of nodes whose reported tip disagrees with their own 30-block
 // history is rejected instead of being treated as a verified backup.
 await assert.rejects(collectMoneroPublic(mismatch.fetchImpl,now));
});
test('ETC main RPC works without querying backups; source is validated',async()=>{
 const {fetchImpl,calls}=mockFetch();
 const sample=await collectEtcPublic(fetchImpl,now);
 assert.equal(sample.coin,'ETC');
 assert.equal(sample.operator,'ETC Blockscout');
 assert.equal(sample.usedFallback,false);
 assert.ok(validateOwnPoWSnapshot(sample,now));
 assert.ok(calls.every(c=>c.host==='etc.blockscout.com'));
});
test('ETC first provider down -> second provider active; primary automatically returns',async()=>{
 const failing=mockFetch({etcDown:['etc.blockscout.com']});
 const backed=await collectEtcPublic(failing.fetchImpl,now);
 assert.equal(backed.operator,'ETC ETCMC');
 assert.equal(backed.usedFallback,true);
 assert.ok(validateOwnPoWSnapshot(backed,now));
 const healed=await collectEtcPublic(mockFetch().fetchImpl,now);
 assert.equal(healed.operator,'ETC Blockscout');
 assert.equal(healed.usedFallback,false);
});
test('ETC invalid chain on backup -> third; all unavailable -> reject',async()=>{
 const failing=mockFetch({etcDown:['etc.blockscout.com'],etcWrongChain:['rpc.etcmc.xyz']});
 const next=await collectEtcPublic(failing.fetchImpl,now);
 assert.equal(next.operator,'ETC ETC Desktop');
 assert.equal(next.usedFallback,true);
 assert.ok(validateOwnPoWSnapshot(next,now));
 await assert.rejects(collectEtcPublic(mockFetch({
  etcDown:['etc.blockscout.com','rpc.etcmc.xyz','etc.etcdesktop.com']
 }).fetchImpl,now));
});
test('RVN explorer validates the real network and halving subsidy; no unverified secondary',async()=>{
 const {fetchImpl}=mockFetch();
 const result=await collectRvnPublic(fetchImpl,now);
 assert.equal(result.coin,'RVN');assert.equal(result.source,'public-chain-rpc');
 assert.equal(result.minerRewardCoins,1250);
 assert.ok(validateOwnPoWSnapshot(result,now));
 assert.equal(rvnHalvingSubsidy(2099999),5000);
 assert.equal(rvnHalvingSubsidy(2100000),2500);
 await assert.rejects(collectRvnPublic(mockFetch({rvnDown:true}).fetchImpl,now));
});
test('Source registers are HTTPS allowlists and Monero quorum operators are distinct',()=>{
 assert.equal(MONERO_SOURCES.length,3);
 assert.equal(ETC_SOURCES.length,3);
 for(const entry of [...MONERO_SOURCES,...ETC_SOURCES]){
   assert.equal(new URL(entry.url).protocol,'https:');
 }
 assert.equal(new Set(MONERO_SOURCES.map(x=>new URL(x.url).hostname)).size,3);
 assert.equal(new Set(ETC_SOURCES.map(x=>new URL(x.url).hostname)).size,3);
});
