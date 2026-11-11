import test from 'node:test';
import assert from 'node:assert/strict';
import {collectMoneroPublic,collectEtcPublic,collectRvnPublic,rvnHalvingSubsidy} from '../edge/public-sources.mjs';
import {validateMoneroSnapshot} from '../lib/monero-feed.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';

const now=Date.parse('2026-11-11T20:00:00Z');
const h=3500000, heightEtc=26000000, heightRvn=4621000;
function moneroFixtures(){
 const headers=Array.from({length:30},(_,i)=>({
  height:h-29+i,timestamp:now/1000-200-(29-i)*120,
  wide_difficulty:'600000000000',reward:'600000000000',
  hash:(h-29+i).toString(16).padStart(64,'0'),orphan_status:false
 }));
 const tip=headers.at(-1);
 const info={jsonrpc:'2.0',result:{status:'OK',untrusted:false,synchronized:true,
  nettype:'mainnet',offline:false,height:h+1}};
 const last={jsonrpc:'2.0',result:{status:'OK',untrusted:false,block_header:tip}};
 const range={jsonrpc:'2.0',result:{status:'OK',untrusted:false,headers}};
 return {info,last,range};
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
const reply=json=>new Response(JSON.stringify(json),{status:200,
 headers:{'Content-Type':'application/json'}});
function mockFetch(options={}){
 const m=moneroFixtures(),e=etcBlocks(),r=rvnBlocks();
 const calls=[];
 const fetchImpl=async (uri,init={})=>{
  calls.push(uri);
  const url=new URL(uri);
  if(url.hostname==='monero.rs'||url.hostname==='xmr.nodely.dev'){
   const json=JSON.parse(init.body),method=json.method;
   if(options.moneroDown&&url.hostname==='xmr.nodely.dev')return new Response('unavailable',{status:503});
   if(method==='get_info')return reply(m.info);
   if(method==='get_last_block_header'){
    if(options.moneroMismatch&&url.hostname==='xmr.nodely.dev')return reply({
      jsonrpc:'2.0',result:{...m.last.result,block_header:
        {...m.last.result.block_header,hash:'f'.repeat(64)}}});
    return reply(m.last);
   }
   if(method==='get_block_headers_range')return reply(m.range);
  }
  if(url.hostname==='etc.blockscout.com'){
   const json=JSON.parse(init.body);
   if(options.etcDown)return new Response('unavailable',{status:503});
   if(Array.isArray(json))return reply(json.map(x=>({id:x.id,jsonrpc:'2.0',
      result:e[Number(BigInt(x.params[0]))-heightEtc+32]})).reverse());
   const results={eth_chainId:'0x3d',eth_syncing:false,
      eth_blockNumber:'0x'+heightEtc.toString(16)};
   return reply({jsonrpc:'2.0',id:1,result:results[json.method]});
  }
  if(url.hostname==='api.ravencoinexplorer.com'){
   if(options.rvnDown)return new Response('unavailable',{status:429});
   if(url.pathname==='/api/v1/status')return reply({ok:true,data:{
    chain:'main',sync_complete:true,chain_status:'normal',incident_active:false,
    node_height:heightRvn,db_height:heightRvn}});
   if(url.pathname==='/api/v1/blocks/latest')return reply({ok:true,data:{items:r}});
  }
  throw new Error('Unexpected external source '+uri);
 };
 return {fetchImpl,calls};
}

test('Monero public nodes must independently agree; 30 blocks and operator labels preserved',async()=>{
 const {fetchImpl,calls}=mockFetch();
 const doc=await collectMoneroPublic(fetchImpl,now);
 assert.equal(doc.source,'public-monero-rpc');
 assert.deepEqual(doc.operators,['monero.rs','nodely.io']);
 assert.equal(doc.sampleBlocks,30);
 assert.ok(validateMoneroSnapshot(doc,now));
 assert.equal(calls.length,5);
});
test('Monero fails closed when a public node is unavailable or disagrees',async()=>{
 await assert.rejects(collectMoneroPublic(mockFetch({moneroDown:true}).fetchImpl,now));
 await assert.rejects(collectMoneroPublic(mockFetch({moneroMismatch:true}).fetchImpl,now));
});
test('ETC public RPC identifies ETC and checks all 33 blocks',async()=>{
 const {fetchImpl,calls}=mockFetch();
 const doc=await collectEtcPublic(fetchImpl,now);
 assert.equal(doc.coin,'ETC');assert.equal(doc.source,'public-chain-rpc');
 assert.equal(doc.operator,'ETC Blockscout');
 assert.ok(validateOwnPoWSnapshot(doc,now));
 assert.equal(calls.length,4);
});
test('ETC public RPC outage blocks publication',async()=>{
 await assert.rejects(collectEtcPublic(mockFetch({etcDown:true}).fetchImpl,now));
});
test('RVN explorer estimates hashrate from measured difficulty and halving subsidy',async()=>{
 const {fetchImpl,calls}=mockFetch();
 const doc=await collectRvnPublic(fetchImpl,now);
 assert.equal(doc.coin,'RVN');assert.equal(doc.source,'public-chain-rpc');
 assert.equal(doc.minerRewardCoins,1250);
 assert.ok(Math.abs(doc.blockSeconds-60)<1e-9);
 assert.ok(Math.abs(doc.networkRate-(7200*2**32/60))<1);
 assert.ok(validateOwnPoWSnapshot(doc,now));
 assert.equal(calls.length,2);
});
test('RVN halving follows actual block height boundaries and honors 429',async()=>{
 assert.equal(rvnHalvingSubsidy(2099999),5000);
 assert.equal(rvnHalvingSubsidy(2100000),2500);
 assert.equal(rvnHalvingSubsidy(4200000),1250);
 await assert.rejects(collectRvnPublic(mockFetch({rvnDown:true}).fetchImpl,now));
});
test('Provider URLs are always fixed https allowlisted hosts',async()=>{
 const {fetchImpl,calls}=mockFetch();
 await Promise.all([collectEtcPublic(fetchImpl,now),collectRvnPublic(fetchImpl,now)]);
 assert.ok(calls.every(url=>url.startsWith('https://')));
 const hosts=new Set(calls.map(url=>new URL(url).hostname));
 assert.deepEqual([...hosts].sort(),['api.ravencoinexplorer.com','etc.blockscout.com']);
});
