import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMoneroSnapshot, MAX_PUBLIC_AGE_MS } from '../lib/monero-feed.mjs';
import { validateOwnPoWSnapshot, PUBLIC_FRESH_MS } from '../lib/pow-yield.mjs';
import { collectAutomated, handleRequest } from '../edge/worker.mjs';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-11-12T12:00:00.000Z');
function xmrSample() {
  const when = new Date(now).toISOString();
  return {
    schemaVersion: 1, coin:'XMR',algorithm:'RandomX',network:'mainnet',
    source:'public-monero-rpc',collectedAt:when,
    blockTimestamp:new Date(now-120000).toISOString(),blockHeight:3500000,
    sampleBlocks:30,difficulty:600000000000,rewardXmr:0.6,
    quality:'estimated-from-30-blocks',operators:['monero.rs','nodely.io'],
    activeOperator:'monero.rs',usedFallback:false,crossCheckedAt:when
  };
}
function powSample(coin) {
  return {
    schemaVersion:1,coin,network:'mainnet',
    algorithm:coin==='RVN'?'KawPoW':'Etchash',unit:'H/s',
    source:'public-chain-rpc',operator:coin==='RVN'?'RavencoinExplorer':'ETC Blockscout',
    usedFallback:false,
    collectedAt:new Date(now).toISOString(),
    blockTimestamp:new Date(now-120000).toISOString(),
    blockHeight:coin==='RVN'?4000000:26000000,
    networkRate:10000000000,blockSeconds:60,minerRewardCoins:1,
    methodology:'32-block network difficulty, rewards independently checked'
  };
}
function kvWithPrevious() {
  const data=new Map([
    ['net:xmr',xmrSample()],
    ['net:rvn',powSample('RVN')],
    ['net:etc',powSample('ETC')]
  ]);
  const writes=[];
  return {data,writes,env:{SNAPSHOTS:{
    async get(key){return data.get(key)||null;},
    async put(key,value,options){writes.push({key,value,options});data.set(key,JSON.parse(value));}
  }}};
}
async function route(path,env,at) {
  const response=await handleRequest({
    url:'https://comparateur.example'+path,method:'GET'
  },env,at);
  assert.equal(response.status,200);
  return response.json();
}

test('24h retention is counted from the last actual success, not from failed retries',()=>{
  assert.equal(MAX_PUBLIC_AGE_MS,24*HOUR);
  assert.equal(PUBLIC_FRESH_MS,24*HOUR);
  for(const sample of [xmrSample(),powSample('RVN'),powSample('ETC')]){
    const check=sample.coin==='XMR'?validateMoneroSnapshot:validateOwnPoWSnapshot;
    assert.ok(check(sample,now+23*HOUR+59*60000));
    assert.ok(check(sample,now+24*HOUR));
    assert.equal(check(sample,now+24*HOUR+1),null);
  }
});
test('outage retains each coin in KV and does not reset collectedAt',async()=>{
  const {data,writes,env}=kvWithPrevious();
  const fail=async()=>{throw Error('public endpoint offline');};
  const result=await collectAutomated(env,{fetchImpl:fail,clock:()=>now+4*HOUR});
  assert.equal(result.length,3);
  assert.ok(result.every(x=>x.ok===false));
  assert.equal(writes.length,0);
  assert.equal(data.get('net:xmr').collectedAt,new Date(now).toISOString());
  assert.equal(data.get('net:etc').collectedAt,new Date(now).toISOString());
});
test('API keeps backed-up figures and marks them as saved during first 24h',async()=>{
  const {env}=kvWithPrevious();
  const monero=await route('/data/monero-reseau.json',env,now+18*HOUR);
  const pow=await route('/data/pow-reseaux.json',env,now+18*HOUR);
  const status=await route('/api/status',env,now+18*HOUR);
  assert.equal(monero.source,'public-monero-rpc');
  assert.equal(pow.networks.length,2);
  assert.ok(status.sources.every(x=>x.status==='saved'));
  assert.equal(status.backupMaxHours,24);
});
test('after 24 hours, APIs hide expired estimates and report unavailable',async()=>{
  const {env}=kvWithPrevious();
  const expiredAt=now+24*HOUR+1;
  const monero=await route('/data/monero-reseau.json',env,expiredAt);
  const pow=await route('/data/pow-reseaux.json',env,expiredAt);
  const status=await route('/api/status',env,expiredAt);
  assert.equal(monero.status,'unavailable');
  assert.match(monero.reason,/24 h/);
  assert.deepEqual(pow.networks,[]);
  assert.ok(status.sources.every(x=>x.status==='unavailable'));
});
test('status distinguishes a recent sample from a saved sample',async()=>{
  const {env}=kvWithPrevious();
  const first=await route('/api/status',env,now+HOUR);
  const older=await route('/api/status',env,now+3*HOUR);
  assert.ok(first.sources.every(x=>x.status==='fresh'));
  assert.ok(older.sources.every(x=>x.status==='saved'));
});
test('a cached own-node snapshot still obeys its stricter 20-minute limit',()=>{
  const m={...xmrSample(),source:'own-monero-node'};
  delete m.operators;delete m.crossCheckedAt;
  assert.ok(validateMoneroSnapshot(m,now+19*60000));
  assert.equal(validateMoneroSnapshot(m,now+21*60000),null);
  const p={...powSample('RVN'),source:'own-node'};
  delete p.operator;
  assert.ok(validateOwnPoWSnapshot(p,now+19*60000));
  assert.equal(validateOwnPoWSnapshot(p,now+21*60000),null);
});
