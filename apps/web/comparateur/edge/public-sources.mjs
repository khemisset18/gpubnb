/**
 * GPUbnb — scheduled network observations, NO commercial mining APIs or self-hosted nodes.
 * Public community endpoints are BEST-EFFORT, not an SLA or a guarantee of reuse rights.
 * Never send wallets, credentials, host IDs or personal data. Fixed allowlisted URLs only.
 */
import { makeMoneroSnapshot } from '../lib/monero-feed.mjs';
import { buildEtcObservation, ETC_WINDOW } from '../lib/etc-observer.mjs';
import { validateOwnPoWSnapshot } from '../lib/pow-yield.mjs';

// Strict, version-controlled source priorities. Primary is retried FIRST on every run,
 // so recovery is automatic; third-party availability and reuse rights are not guaranteed.
export const MONERO_SOURCES = Object.freeze([
 {name:'monero.rs',url:'https://monero.rs:18081/json_rpc'},
 {name:'nodely.io',url:'https://xmr.nodely.dev:18089/json_rpc'},
 {name:'hostingwire.net',url:'https://xmr.hostingwire.net/json_rpc'}
]);
export const ETC_SOURCES = Object.freeze([
 {name:'ETC Blockscout',url:'https://etc.blockscout.com/api/eth-rpc'},
 {name:'ETC ETCMC',url:'https://rpc.etcmc.xyz'},
 {name:'ETC ETC Desktop',url:'https://etc.etcdesktop.com'}
]);
const RVN_ORIGIN = 'https://api.ravencoinexplorer.com';
const ALLOWED = new Set([...MONERO_SOURCES,...ETC_SOURCES,{url:RVN_ORIGIN}]
  .map(node=>new URL(node.url).origin));
export const MAX_JSON_BYTES=768*1024;

/**
 * Limit actual decompressed bytes, not just the Content-Length header.
 * Public providers can omit Content-Length or stream a much larger response.
 * This function works in both Cloudflare Workers and Node.js 22.
 */
export async function readBoundedJson(response,maxBytes=MAX_JSON_BYTES){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_JSON_BYTES)
   throw Error('Invalid response limit');
 const header=response.headers?.get?.('content-length');
 if(header!==null&&header!==undefined&&header!==''&&
    Number.isFinite(Number(header))&&Number(header)>maxBytes)
   throw Error('Remote response exceeds limit');
 if(response.body&&typeof response.body.getReader==='function'){
   const reader=response.body.getReader(),decoder=new TextDecoder();
   let bytes=0,body='';
   try{
     for(;;){
       const {done,value}=await reader.read();
       if(done)break;
       if(!(value instanceof Uint8Array))throw Error('Unexpected body type');
       bytes+=value.byteLength;
       if(bytes>maxBytes){
         await reader.cancel();
         throw Error('Remote response exceeds limit');
       }
       body+=decoder.decode(value,{stream:true});
     }
     body+=decoder.decode();
   }finally{reader.releaseLock();}
   return JSON.parse(body);
 }
 // Minimal fetch mocks without a ReadableStream are supported by unit tests;
 // production Fetch Response always has a streaming body.
 const text=await response.text();
 if(new TextEncoder().encode(text).length>maxBytes)
   throw Error('Remote response exceeds limit');
 return JSON.parse(text);
}

async function json(fetchImpl,url,body=null){
 const target=new URL(url);
 if(target.protocol!=='https:'||!ALLOWED.has(target.origin))throw Error('Blocked unexpected RPC host');
 const res=await fetchImpl(target.href,{
   method:body===null?'GET':'POST',
   ...(body===null?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
   redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)
 });
 if(!res.ok)throw Error('Remote endpoint status '+res.status);
 return readBoundedJson(res);
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

/** Monero failover is TWO-OF-THREE, never a single unverified public node.
 * Candidates are tried in priority order. Pair consistency is verified at
 * the same chain height (fetching the common block when tips differ).
 */
async function moneroNode(fetchImpl,node,now){
  const infoRaw=await json(fetchImpl,node.url.replace(/\/json_rpc$/,'/get_info'));
  if(infoRaw?.status!=='OK'||infoRaw.untrusted!==false)throw Error('Untrusted Monero info');
  const info={result:infoRaw};
  const last=await moneroRpc(fetchImpl,node.url,'get_last_block_header');
  safeBlockInfo(info,last,now);
  return {node,info,last};
}
async function matchingMoneroPair(fetchImpl,a,b){
  const ah=a.last.result.block_header,bh=b.last.result.block_header;
  if(Math.abs(ah.height-bh.height)>3)return false;
  const commonHeight=Math.min(ah.height,bh.height);
  const readAt=async item=>{
    if(item.last.result.block_header.height===commonHeight)return item.last.result.block_header.hash;
    const reply=await moneroRpc(fetchImpl,item.node.url,'get_block_header_by_height',{height:commonHeight});
    return reply.result?.block_header?.hash;
  };
  const [hashA,hashB]=await Promise.all([readAt(a),readAt(b)]);
  return typeof hashA==='string'&&/^[a-f0-9]{64}$/i.test(hashA)&&hashA===hashB;
}
export async function collectMoneroPublic(fetchImpl=fetch,now=Date.now()){
 const healthy=[];
 let selected=null;
 for(let i=0;i<MONERO_SOURCES.length;i++){
  try{
   const next=await moneroNode(fetchImpl,MONERO_SOURCES[i],now);
   for(const other of healthy){
    try{
     if(await matchingMoneroPair(fetchImpl,other,next)){
      selected=[other,next];break;
     }
    }catch{} // A mismatching/unresponsive remote node is not trusted.
   }
   if(selected)break;
   healthy.push(next);
  }catch{} // Try the next *independent* allowlisted operator.
 }
 if(!selected)throw Error('No two independent Monero RPCs agree');
 // Use the highest-priority member of the agreeing pair for block sampling;
 // if that restricted endpoint denies the range method, try its agreeing peer.
 for(const current of selected){
  try{
   const tip=current.last.result.block_header;
   const range=await moneroRpc(fetchImpl,current.node.url,'get_block_headers_range',
     {start_height:tip.height-29,end_height:tip.height});
   const snapshot=makeMoneroSnapshot(current.info,current.last,range,now);
   return {...snapshot,source:'public-monero-rpc',
     operators:selected.map(v=>v.node.name),activeOperator:current.node.name,
     usedFallback:current.node.name!==MONERO_SOURCES[0].name,
     crossCheckedAt:new Date(now).toISOString()};
  }catch{}
 }
 throw Error('No independently checked Monero RPC can serve the 30-block sample');
}
async function etcRpc(fetchImpl,url,method,params=[]){
 const obj=await json(fetchImpl,url,{jsonrpc:'2.0',id:1,method,params});
 if(obj?.error||obj?.result===undefined)throw Error('ETC RPC unavailable: '+method);
 return obj.result;
}
async function collectEtcFromSource(fetchImpl,now,source,sourceIndex){
 const url=source.url;
 const [chainId,syncing,number]=await Promise.all([
  etcRpc(fetchImpl,url,'eth_chainId'),etcRpc(fetchImpl,url,'eth_syncing'),
  etcRpc(fetchImpl,url,'eth_blockNumber')]);
 if(chainId!=='0x3d'||syncing!==false)throw Error('ETC public RPC chain mismatch');
 const height=Number(BigInt(number));
 if(!Number.isSafeInteger(height)||height<ETC_WINDOW+1)throw Error('ETC height unsupported');
 const batch=Array.from({length:ETC_WINDOW+1},(_,i)=>({
   jsonrpc:'2.0',id:i+1,method:'eth_getBlockByNumber',
   params:['0x'+(height-ETC_WINDOW+i).toString(16),false]
 }));
 const responses=await json(fetchImpl,url,batch);
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
 return {...raw,source:'public-chain-rpc',operator:source.name,
   usedFallback:sourceIndex>0,
   methodology:'ETC public RPC 32 consecutive blocks, ECIP-1017 PoW base reward only'};
}
export async function collectEtcPublic(fetchImpl=fetch,now=Date.now()){
 // Try the main RPC on EACH scheduled cycle; a recovered primary automatically
 // replaces a backup only after the same mainnet/block validation succeeds.
 for(let i=0;i<ETC_SOURCES.length;i++){
  try{
   const sample=await collectEtcFromSource(fetchImpl,now,ETC_SOURCES[i],i);
   if(validateOwnPoWSnapshot(sample,now))return sample;
  }catch{} // Any 403, 429, timeout, wrong chain or inconsistent blocks -> backup.
 }
 throw Error('All ETC public RPC sources unavailable or invalid');
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
