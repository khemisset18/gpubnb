import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleRequest,EXPECTED_REFRESH_MS} from '../edge/worker.mjs';
import {MAX_PUBLIC_AGE_MS} from '../lib/monero-feed.mjs';
import {PUBLIC_FRESH_MS} from '../lib/pow-yield.mjs';

const hour=60*60*1000;
const now=Date.parse('2026-11-12T01:00:00Z');
const sample=()=>{
 const when=new Date(now).toISOString();
 return {
  schemaVersion:1,coin:'XMR',algorithm:'RandomX',network:'mainnet',
  source:'public-monero-rpc',collectedAt:when,blockTimestamp:new Date(now-120000).toISOString(),
  blockHeight:3500000,sampleBlocks:30,difficulty:600000000000,
  rewardXmr:0.6,quality:'estimated-from-30-blocks',
  operators:['monero.rs','nodely.io'],activeOperator:'monero.rs',
  usedFallback:false,crossCheckedAt:when
 };
};
const env={SNAPSHOTS:{async get(key){return key==='net:xmr'?sample():null;}}};
async function status(timestamp) {
 const reply=await handleRequest(new Request('https://comparateur.example/api/status'),env,timestamp);
 assert.equal(reply.status,200);
 return reply.json();
}

test('Wrangler schedules one automatic refresh per hour, at minute 17 UTC',async()=>{
 const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.deepEqual(config.triggers.crons,['17 * * * *']);
 assert.deepEqual(config.assets.run_worker_first,
  ['/data/monero-reseau.json','/data/pow-reseaux.json','/api/status']);
});
test('hourly interval with 15-minute scheduling grace, separate from 24h hard expiry',()=>{
 assert.equal(EXPECTED_REFRESH_MS,75*60000);
 assert.equal(MAX_PUBLIC_AGE_MS,24*hour);
 assert.equal(PUBLIC_FRESH_MS,24*hour);
});
test('API reports fresh before grace and saved after grace, without changing timestamp',async()=>{
 const recent=await status(now+74*60000);
 const boundary=await status(now+75*60000);
 const fallback=await status(now+76*60000);
 const x=s=>s.sources.find(item=>item.coin==='XMR');
 assert.equal(recent.refresh,'hourly');
 assert.equal(recent.expectedRefreshMinutes,60);
 assert.equal(recent.graceMinutes,15);
 assert.equal(x(recent).status,'fresh');
 assert.equal(x(boundary).status,'fresh');
 assert.equal(x(fallback).status,'saved');
 assert.equal(x(fallback).collectedAt,new Date(now).toISOString());
});
test('at 24h the last verified data is still bounded; 1 ms later it is unavailable',async()=>{
 const boundary=await status(now+24*hour);
 const expired=await status(now+24*hour+1);
 assert.equal(boundary.sources.find(x=>x.coin==='XMR').status,'saved');
 const x=expired.sources.find(x=>x.coin==='XMR');
 assert.equal(x.status,'unavailable');
 assert.equal(x.collectedAt,null);
});
test('an unavailable coin never inherits another coin’s cached status',async()=>{
 const observed=await status(now+30*60000);
 assert.equal(observed.sources.find(x=>x.coin==='XMR').status,'fresh');
 for(const coin of ['RVN','ETC'])assert.equal(
  observed.sources.find(x=>x.coin===coin).status,'unavailable');
});


test('browser reads hourly data every 15 minutes but checks expiry locally each minute',async()=>{
  const dir=new URL('../',import.meta.url);
  const monero=await readFile(new URL('monero-ui.mjs',dir),'utf8');
  const pow=await readFile(new URL('pow-ui.mjs',dir),'utf8');
  const general=await readFile(new URL('app.js',dir),'utf8');
  assert.match(monero,/setInterval\(updateNetwork,15\*60\*1000\)/);
  assert.match(pow,/setInterval\(refresh,15\*60\*1000\)/);
  assert.match(general,/setInterval\(refreshFeed,15\*60\*1000\)/);
  assert.match(monero,/setInterval\(render,60\*1000\)/);
  assert.match(pow,/setInterval\(render,60\*1000\)/);
  assert.match(general,/setInterval\(\(\)=>\{/);
  for(const file of [monero,pow,general])
    assert.doesNotMatch(file,/setInterval\([^,\n]+,5\*60\*1000\)/);
});
