/**
 * GPUbnb automated FREE tier updater.
 * Serve the standalone comparator's static assets and its cached blockchain stats.
 * Runs every 2h on Cloudflare Cron; KV stores small public snapshots.
 * Never exposes a private key or talks to the main GPUbnb site.
 *
 * Important: community RPC endpoints have best-effort availability and can rate-limit.
 * A missing/stale response is shown as unavailable, never invented.
 */
import {collectMoneroPublic,collectEtcPublic,collectRvnPublic} from './public-sources.mjs';
import {validateMoneroSnapshot} from '../lib/monero-feed.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';

const KEYS=Object.freeze({XMR:'net:xmr',ETC:'net:etc',RVN:'net:rvn'});
const jsonHeaders=Object.freeze({
 'Content-Type':'application/json; charset=utf-8',
 'Cache-Control':'no-store, max-age=0',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer'
});
const NO_MONERO={status:'unavailable',reason:'Données blockchain absentes ou trop anciennes'};
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
function sendJson(value,status=200){
 return new Response(JSON.stringify(value),{status,headers:jsonHeaders});
}
export async function collectAutomated(env,{clock=()=>Date.now(),fetchImpl=fetch}={}){
 if(!env?.SNAPSHOTS||typeof env.SNAPSHOTS.put!=='function')throw Error('KV binding not configured');
 const jobs=[
  ['XMR',()=>collectMoneroPublic(fetchImpl,clock())],
  ['ETC',()=>collectEtcPublic(fetchImpl,clock())],
  ['RVN',()=>collectRvnPublic(fetchImpl,clock())]
 ];
 // Independent failures never erase another coin's last good sample.
 // Each sample expires at read-time (5 hours for best-effort public sources).
 const outcomes=await Promise.all(jobs.map(async ([coin,build])=>{
  try{
   const data=await build();
   const now=clock();
   const valid=coin==='XMR'?validateMoneroSnapshot(data,now):
     validateOwnPoWSnapshot(data,now);
   if(!valid)throw Error('Failed independent validation');
   await env.SNAPSHOTS.put(KEYS[coin],JSON.stringify(data));
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
  return sendJson(await loadValidated(env,'XMR',now)||NO_MONERO);
 }
 if(url.pathname==='/data/pow-reseaux.json'){
  const found=await Promise.all(['RVN','ETC'].map(coin=>loadValidated(env,coin,now)));
  return sendJson({...emptyPow,networks:found.filter(Boolean)});
 }
 if(url.pathname==='/api/status'){
  const found=await Promise.all(Object.keys(KEYS).map(async coin=>{
   const data=await loadValidated(env,coin,now);
   return {coin,status:data?'ok':'unavailable',collectedAt:data?.collectedAt||null,
    source:data?.source||null};
  }));
  return sendJson({service:'gpubnb-comparateur',refresh:'every-two-hours',
    pricing:'manual-only',sources:found});
 }
 if(!env?.ASSETS?.fetch)return sendJson({status:'not_found'},404);
 return env.ASSETS.fetch(request);
}
export default {
  fetch(request,env){return handleRequest(request,env);},
  scheduled(_event,env,ctx){ctx.waitUntil(collectAutomated(env));}
};
