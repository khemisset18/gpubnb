/**
 * GPUbnb — scheduled network observations, NO commercial mining APIs or self-hosted nodes.
 * Public community endpoints are BEST-EFFORT, not an SLA or a guarantee of reuse rights.
 * Never send wallets, credentials, host IDs or personal data. Fixed allowlisted URLs only.
 */
import { makeMoneroSnapshot } from '../lib/monero-feed.mjs';
import { buildEtcObservation, ETC_WINDOW } from '../lib/etc-observer.mjs';
import { validateOwnPoWSnapshot } from '../lib/pow-yield.mjs';

const MONERO_A = 'https://monero.rs:18081/json_rpc';
const MONERO_B = 'https://xmr.nodely.dev:18081/json_rpc';
const ETC_URL = 'https://etc.blockscout.com/api/eth-rpc';
const RVN_ORIGIN = 'https://api.ravencoinexplorer.com';
const ALLOWED = new Set([new URL(MONERO_A).origin,new URL(MONERO_B).origin,
  new URL(ETC_URL).origin,new URL(RVN_ORIGIN).origin]);
const MAX_JSON_BYTES=768*1024;

async function json(fetchImpl,url,body=null){
 const target=new URL(url);
 if(target.protocol!=='https:'||!ALLOWED.has(target.origin))throw Error('Blocked unexpected RPC host');
 const res=await fetchImpl(target.href,{
   method:body===null?'GET':'POST',
   ...(body===null?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
   redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)
 });
 if(!res.ok)throw Error('Remote endpoint status '+res.status);
 const size=Number(res.headers.get('content-length')||0);
 if(size>MAX_JSON_BYTES)throw Error('Remote response exceeds limit');
 const text=await res.text();
 if(text.length>MAX_JSON_BYTES)throw Error('Remote response exceeds limit');
 return JSON.parse(text);
}
async function moneroRpc(fetchImpl,url,method,params){
 const result=await json(fetchImpl,url,{jsonrpc:'2.0',id:'gpubnb-no-wallet',method,
   ...(params?{params}:{})});
 if(result?.error||result?.result?.status!=='OK'||result?.result?.untrusted!==false)
   throw Error('Invalid/untrusted Monero public RPC');
 return result;
}
function safeBlockInfo(info,last,now){
 const i=info?.result,h=last?.result?.block_header;
 if(i?.synchronized!==true||i?.nettype!=='mainnet'||i?.offline===true||
  !Number.isSafeInteger(i.height)||i.height!==h?.height+1||
  !Number.isSafeInteger(h?.timestamp)||now-h.timestamp*1000>30*60000||
  now-h.timestamp*1000< -5*60000||
  typeof h.hash!=='string'||!/^([a-f0-9]{64})$/i.test(h.hash))
   throw Error('Public Monero RPC out of sync');
}
export async function collectMoneroPublic(fetchImpl=fetch,now=Date.now()){
 const [infoA,lastA,infoB,lastB]=await Promise.all([
   moneroRpc(fetchImpl,MONERO_A,'get_info'),
   moneroRpc(fetchImpl,MONERO_A,'get_last_block_header'),
   moneroRpc(fetchImpl,MONERO_B,'get_info'),
   moneroRpc(fetchImpl,MONERO_B,'get_last_block_header')
 ]);
 safeBlockInfo(infoA,lastA,now);safeBlockInfo(infoB,lastB,now);
 const a=lastA.result.block_header,b=lastB.result.block_header;
 if(Math.abs(a.height-b.height)>3 ||
   (a.height===b.height&&a.hash!==b.hash))throw Error('Independent Monero nodes disagree');
 const range=await moneroRpc(fetchImpl,MONERO_A,'get_block_headers_range',
   {start_height:a.height-29,end_height:a.height});
 const snapshot=makeMoneroSnapshot(infoA,lastA,range,now);
 return {...snapshot,source:'public-monero-rpc',
    operators:['monero.rs','nodely.io'],crossCheckedAt:new Date(now).toISOString()};
}
async function etcRpc(fetchImpl,method,params=[]){
 const obj=await json(fetchImpl,ETC_URL,{jsonrpc:'2.0',id:1,method,params});
 if(obj?.error||obj?.result===undefined)throw Error('ETC RPC unavailable: '+method);
 return obj.result;
}
export async function collectEtcPublic(fetchImpl=fetch,now=Date.now()){
 const [chainId,syncing,number]=await Promise.all([
  etcRpc(fetchImpl,'eth_chainId'),etcRpc(fetchImpl,'eth_syncing'),
  etcRpc(fetchImpl,'eth_blockNumber')]);
 if(chainId!=='0x3d'||syncing!==false)throw Error('ETC public RPC chain mismatch');
 const height=Number(BigInt(number));
 if(!Number.isSafeInteger(height)||height<ETC_WINDOW+1)throw Error('ETC height unsupported');
 const batch=Array.from({length:ETC_WINDOW+1},(_,i)=>({
   jsonrpc:'2.0',id:i+1,method:'eth_getBlockByNumber',
   params:['0x'+(height-ETC_WINDOW+i).toString(16),false]
 }));
 const responses=await json(fetchImpl,ETC_URL,batch);
 if(!Array.isArray(responses)||responses.length!==batch.length)throw Error('ETC batch unsupported');
 const indexed=new Map();
 for(const r of responses){
  if(!Number.isInteger(r?.id)||indexed.has(r.id)||r.error||!r.result)
   throw Error('Invalid ETC RPC batch');
  indexed.set(r.id,r.result);
 }
 const blocks=batch.map(r=>indexed.get(r.id));
 if(blocks.some(b=>!b))throw Error('Missing ETC block');
 const raw=buildEtcObservation({chainId,syncing,blocks},now);
 return {...raw,source:'public-chain-rpc',operator:'ETC Blockscout',
   methodology:'ETC public Blockscout RPC; 32 consecutive blocks, base PoW subsidy only'};
}
export function rvnHalvingSubsidy(height){
 if(!Number.isSafeInteger(height)||height<1)throw Error('Invalid RVN height');
 return 5000/2**Math.floor(height/2100000);
}
export async function collectRvnPublic(fetchImpl=fetch,now=Date.now()){
 const [status,latest]=await Promise.all([
  json(fetchImpl,RVN_ORIGIN+'/api/v1/status'),
  json(fetchImpl,RVN_ORIGIN+'/api/v1/blocks/latest?limit=33')
 ]);
 const st=status?.data,rows=latest?.data?.items;
 if(status?.ok!==true||st?.chain!=='main'||st?.sync_complete!==true||
    st?.incident_active===true||st?.chain_status!=='normal'||
    !Number.isSafeInteger(st?.node_height)||!Number.isSafeInteger(st?.db_height)||
    st.node_height-st.db_height>3||
    latest?.ok!==true||!Array.isArray(rows)||rows.length!==33)
    throw Error('Unhealthy public Ravencoin explorer');
 const blocks=[...rows].sort((a,b)=>a.height-b.height);
 let sumDifficulty=0;
 for(let i=0;i<blocks.length;i++){
   const row=blocks[i];
   const timestamp=Number.isSafeInteger(row?.time)?row.time:Date.parse(row?.time_iso||'')/1000;
   if(!Number.isSafeInteger(row?.height)||!Number.isSafeInteger(timestamp)||
      typeof row?.hash!=='string'||!/^([a-f0-9]{64})$/i.test(row.hash)||
      typeof row.difficulty!=='number'||!Number.isFinite(row.difficulty)||
      row.difficulty<=0||
      (i&&row.height!==blocks[i-1].height+1))throw Error('Invalid RVN block sample');
   row.__timestamp=timestamp;
   if(i>0)sumDifficulty+=row.difficulty;
 }
 const first=blocks[0],tip=blocks.at(-1),elapsed=tip.__timestamp-first.__timestamp;
 if(tip.height!==st.db_height||now-tip.__timestamp*1000>30*60000||
    now-tip.__timestamp*1000< -5*60000||
    elapsed<32||elapsed>32*7200)throw Error('Stale RVN public block sample');
 const blockSeconds=elapsed/32,meanDifficulty=sumDifficulty/32;
 const networkRate=meanDifficulty*2**32/blockSeconds;
 const raw={schemaVersion:1,coin:'RVN',algorithm:'KawPoW',
   unit:'H/s',network:'mainnet',source:'public-chain-rpc',
   operator:'RavencoinExplorer',collectedAt:new Date(now).toISOString(),
   blockTimestamp:new Date(tip.__timestamp*1000).toISOString(),
   blockHeight:tip.height,networkRate,blockSeconds,
   minerRewardCoins:rvnHalvingSubsidy(tip.height),
   methodology:'RVN 32-block public explorer difficulty, PoW target scaling, base halving subsidy (excluding fees)'};
 if(!validateOwnPoWSnapshot(raw,now))throw Error('RVN observation failed validation');
 return raw;
}
