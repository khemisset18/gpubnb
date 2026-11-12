import test from 'node:test';
import assert from 'node:assert/strict';
import {safeCacheSeconds,PUBLIC_CACHE_SECONDS,handleRequest} from '../edge/worker.mjs';
const HOUR=60*60*1000,MINUTE=60*1000;
const now=Date.parse('2026-11-12T12:00:00Z');
const xmr=()=>({
 schemaVersion:1,coin:'XMR',algorithm:'RandomX',network:'mainnet',
 source:'public-monero-rpc',collectedAt:new Date(now).toISOString(),
 blockTimestamp:new Date(now-120000).toISOString(),blockHeight:3500000,
 sampleBlocks:30,difficulty:600000000000,rewardXmr:.6,
 quality:'estimated-from-30-blocks',operators:['monero.rs','nodely.io'],
 activeOperator:'monero.rs',usedFallback:false,crossCheckedAt:new Date(now).toISOString()
});
const environment=(records={})=>{
 const reads=[];
 return {reads,env:{SNAPSHOTS:{async get(key){reads.push(key);return records[key]||null;}}}};
};
const route=(route,env,time)=>handleRequest(new Request('https://gpubnb.example'+route),env,time);

test('shared cache is bounded to 2 minutes; no cache can outlive 24-hour validity',()=>{
 assert.equal(PUBLIC_CACHE_SECONDS,120);
 assert.equal(safeCacheSeconds([xmr()],now),120);
 assert.equal(safeCacheSeconds([xmr()],now+24*HOUR-50*1000),50);
 assert.equal(safeCacheSeconds([xmr()],now+24*HOUR),0);
 assert.equal(safeCacheSeconds([xmr()],now+24*HOUR+1),0);
 assert.equal(safeCacheSeconds([],now),60);
});
test('status cannot be cached across the hourly freshness boundary',()=>{
 assert.equal(safeCacheSeconds([xmr()],now+74*MINUTE,{health:true}),60);
 assert.equal(safeCacheSeconds([xmr()],now+74*MINUTE+45*1000,{health:true}),15);
 assert.equal(safeCacheSeconds([xmr()],now+75*MINUTE,{health:true}),120);
});
test('network JSON is cacheable only for a safe interval',async()=>{
 const {env}=environment({'net:xmr':xmr()});
 const response=await route('/data/monero-reseau.json',env,now+24*HOUR-70*1000);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'public, max-age=70');
 assert.equal((await response.json()).coin,'XMR');
 const expired=await route('/data/monero-reseau.json',env,now+24*HOUR+1000);
 assert.equal((await expired.json()).status,'unavailable');
 assert.equal(expired.headers.get('cache-control'),'public, max-age=60');
});
test('status reads each currency at most once per Worker invocation',async()=>{
 const {env,reads}=environment({'net:xmr':xmr()});
 const response=await route('/api/status',env,now+20*MINUTE);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'public, max-age=120');
 assert.deepEqual(reads.sort(),['net:etc','net:rvn','net:xmr']);
});
test('browser avoids unique query strings, allowing edge cache reuse',async()=>{
 const fs=await import('node:fs/promises');
 const src=await Promise.all(['monero-ui.mjs','pow-ui.mjs'].map(path=>
  fs.readFile(new URL('../'+path,import.meta.url),'utf8')));
 for(const script of src){
  assert.doesNotMatch(script,/\\.json\\?t=/);
  assert.doesNotMatch(script,/cache:\\s*['"]no-store['"]/);
 }
});
