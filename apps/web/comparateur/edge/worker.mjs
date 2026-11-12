/**
 * GPUbnb automated FREE tier updater.
 * Serve the standalone comparator's static assets and its cached blockchain stats.
 * Runs every hour on Cloudflare Cron; KV stores small public snapshots.
 * Never exposes a private key or talks to the main GPUbnb site.
 *
 * Important: community RPC endpoints have best-effort availability and can rate-limit.
 * A missing/stale response is shown as unavailable, never invented.
 */
import {collectMoneroPublic,collectEtcPublic,collectRvnPublic} from './public-sources.mjs';
import {validateMoneroSnapshot,MAX_PUBLIC_AGE_MS} from '../lib/monero-feed.mjs';
import {validateOwnPoWSnapshot,PUBLIC_FRESH_MS} from '../lib/pow-yield.mjs';

const KEYS=Object.freeze({XMR:'net:xmr',ETC:'net:etc',RVN:'net:rvn'});
// Cloudflare Free caps Cron CPU time at 10 ms. Three hourly triggers partition
// processing into isolated invocations (within its five-triggers-per-account limit).
export const CRON_TO_COIN=Object.freeze({
 '17 * * * *':'XMR',
 '27 * * * *':'ETC',
 '37 * * * *':'RVN'
});
// No stale-data reset after an outage: expiry is measured from the LAST successful collection.
const BACKUP_MAX_MS=Math.min(MAX_PUBLIC_AGE_MS,PUBLIC_FRESH_MS);
const BACKUP_TTL_SECONDS=BACKUP_MAX_MS/1000;
// Hourly cron + 15-minute grace for propagation and upstream latency.
export const EXPECTED_REFRESH_MS=75*60*1000;
const jsonHeaders=Object.freeze({
 'Content-Type':'application/json; charset=utf-8',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer'
});
// Small shared HTTP cache minimizes KV reads under the free plan. Cache age is
// capped by the exact 24h cutoff (and freshness status boundary on /api/status).
export const PUBLIC_CACHE_SECONDS=120;
export function safeCacheSeconds(samples,now,{health=false}={}){
 const fresh=(samples||[]).filter(Boolean);
 if(!fresh.length)return 60; // Retry unavailable responses quickly.
 let until=now+PUBLIC_CACHE_SECONDS*1000;
 for(const sample of fresh){
   const collected=Date.parse(sample.collectedAt);
   if(!Number.isFinite(collected))return 0;
   until=Math.min(until,collected+BACKUP_MAX_MS);
   if(health&&now<collected+EXPECTED_REFRESH_MS)
     until=Math.min(until,collected+EXPECTED_REFRESH_MS);
 }
 return Math.max(0,Math.min(PUBLIC_CACHE_SECONDS,Math.floor((until-now)/1000)));
}
const NO_MONERO={status:'unavailable',reason:'Service indisponible : dernier relevé valide absent ou âgé de plus de 24 h'};
const emptyPow={schemaVersion:1,networks:[]};

async function loadValidated(env,coin,now=Date.now()){
 const key=KEYS[coin];
 if(!key||!env?.SNAPSHOTS)return null;
 let value;
 try{value=await env.SNAPSHOTS.get(key,{type:'json'});}catch{return null;}
 if(!value)return null;
 return coin==='XMR'?validateMoneroSnapshot(value,now)?value:null:
  validateOwnPoWSnapshot(value,now)?value:null;
}
function sendJson(value,status=200,maxAgeSeconds=0){
 const seconds=Number.isSafeInteger(maxAgeSeconds)&&maxAgeSeconds>0?
    Math.min(PUBLIC_CACHE_SECONDS,maxAgeSeconds):0;
 const headers={...jsonHeaders,'Cache-Control':seconds?
   'public, max-age='+seconds:'no-store, max-age=0'};
 return new Response(JSON.stringify(value),{status,headers});
}
export async function collectAutomated(env,{clock=()=>Date.now(),fetchImpl=fetch,coins=null}={}){
 if(!env?.SNAPSHOTS||typeof env.SNAPSHOTS.put!=='function')throw Error('KV binding not configured');
 const jobs=[
  ['XMR',()=>collectMoneroPublic(fetchImpl,clock())],
  ['ETC',()=>collectEtcPublic(fetchImpl,clock())],
  ['RVN',()=>collectRvnPublic(fetchImpl,clock())]
 ];
 if(coins!==null&&(!Array.isArray(coins)||coins.length!==1||
   !Object.hasOwn(KEYS,coins[0])))throw Error('Invalid scheduled crypto job');
 const selected=coins===null?jobs:jobs.filter(([coin])=>coin===coins[0]);
 // Independent failures never erase another coin's last good sample.
 // On failure, the previous valid sample is NEVER overwritten or retimestamped.
 // KV deletes it after 24 hours and validation also enforces 24h at read time.
 const outcomes=await Promise.all(selected.map(async ([coin,build])=>{
  try{
   const data=await build();
   const now=clock();
   const valid=coin==='XMR'?validateMoneroSnapshot(data,now):
     validateOwnPoWSnapshot(data,now);
   if(!valid)throw Error('Failed independent validation');
   await env.SNAPSHOTS.put(KEYS[coin],JSON.stringify(data),{expirationTtl:BACKUP_TTL_SECONDS});
   return {coin,ok:true};
  }catch(error){
   // Never log response payloads or error body to avoid provider data leakage.
   return {coin,ok:false,reason:'source unavailable or invalid'};
  }
 }));
 console.log('GPUbnb free data refresh:',outcomes.map(x=>x.coin+':'+(x.ok?'ok':'unavailable')).join(' '));
 return outcomes;
}
export async function handleRequest(request,env,now=Date.now()){
 const url=new URL(request.url),method=request.method;
 if(method!=='GET'&&method!=='HEAD')return sendJson({status:'method_not_allowed'},405);
 if(url.pathname==='/data/monero-reseau.json'){
  const sample=await loadValidated(env,'XMR',now);
  return sendJson(sample||NO_MONERO,200,safeCacheSeconds(sample?[sample]:[],now));
 }
 if(url.pathname==='/data/pow-reseaux.json'){
  const found=await Promise.all(['RVN','ETC'].map(coin=>loadValidated(env,coin,now)));
  const valid=found.filter(Boolean);
  return sendJson({...emptyPow,networks:valid},200,safeCacheSeconds(valid,now));
 }
 if(url.pathname==='/api/status'){
  const coins=Object.keys(KEYS);
  const valid=await Promise.all(coins.map(coin=>loadValidated(env,coin,now)));
  const found=coins.map((coin,i)=>{
   const data=valid[i];
   const ageMs=data?Math.max(0,now-Date.parse(data.collectedAt)):null;
   const mode=data?(ageMs>EXPECTED_REFRESH_MS?'saved':'fresh'):'unavailable';
   return {coin,status:mode,collectedAt:data?.collectedAt||null,
    ageHours:ageMs===null?null:Math.round(ageMs/360000)/10,
    source:data?.source||null,
    operator:data?.activeOperator||data?.operator||null,
    fallback:data?.usedFallback===true};
  });
  return sendJson({service:'gpubnb-comparateur',refresh:'hourly',expectedRefreshMinutes:60,graceMinutes:15,
    pricing:'manual-only',backupMaxHours:24,sources:found},200,safeCacheSeconds(valid,now,{health:true}));
 }
 if(!env?.ASSETS?.fetch)return sendJson({status:'not_found'},404);
 return env.ASSETS.fetch(request);
}
export default {
  fetch(request,env){return handleRequest(request,env);},
  scheduled(event,env,ctx){
    const coin=CRON_TO_COIN[event.cron];
    if(!coin){console.log('GPUbnb: unsupported Cron trigger');return;}
    ctx.waitUntil(collectAutomated(env,{coins:[coin]}));
  }
};
