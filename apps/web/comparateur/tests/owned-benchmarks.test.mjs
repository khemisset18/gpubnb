import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOwnedBenchmark,validateOwnedBenchmarkDataset,validatePublishedOwnedBenchmarks,ALGORITHMS} from '../lib/owned-benchmarks.mjs';

const now=Date.parse('2026-11-11T18:00:00.000Z');
const ids=new Set(['nvidia-rtx-3060','amd-7950x']);
const sample=(overrides={})=>({
  deviceId:'nvidia-rtx-3060',coin:'RVN',algorithm:'KawPoW',unit:'H/s',
  hashrate:24_000_000,watts:170,durationSeconds:600,
  deviceCount:1,observedAt:new Date(now-86400000).toISOString(),
  powerScope:'wall-whole-rig',sampleMethod:'operator-measured',consentToPublish:true,
  ...overrides
});
test('accepts valid operator-owned real benchmark without modifying inputs',()=>{
  const x=sample(),actual=validateOwnedBenchmark(x,ids,now);
  assert.ok(actual);assert.equal(actual.hashrate,24_000_000);
  assert.equal(actual.watts,170);assert.equal(x.consentToPublish,true);
  assert.equal(actual.consentToPublish,undefined);
});
test('strips personal details and unexpected credentials from published copy',()=>{
  const result=validateOwnedBenchmark(sample({
    walletAddress:'RVN-private-payout',serialNumber:'12345',ipAddress:'192.0.2.4',
    userEmail:'private@example.com',rpcPassword:'secret',gpuHostToken:'secret'
  }),ids,now);
  assert.ok(result);
  const encoded=JSON.stringify(result);
  for(const secret of ['RVN-private-payout','12345','192.0.2.4','private@example.com','secret'])
    assert.ok(!encoded.includes(secret));
});
test('rejects invented device IDs, mismatched units and unknown algorithms',()=>{
  for(const change of [
    {deviceId:'nvidia-rtx-4099'}, {coin:'BTC'}, {coin:'__proto__'},
    {coin:'constructor'}, {algorithm:'RandomX'}, {unit:'Sol/s'},
    {hashrate:'24e6'},{hashrate:0},{watts:0},{watts:-1},
    {durationSeconds:299},{durationSeconds:86401},{deviceCount:2},
    {powerScope:'chip-only'},{sampleMethod:'community-scraped'},
    {consentToPublish:false},{consentToPublish:undefined}
  ])assert.equal(validateOwnedBenchmark(sample(change),ids,now),null);
});
test('separate algorithms have strict performance units',()=>{
  const a=validateOwnedBenchmark(sample({
    deviceId:'amd-7950x',coin:'XMR',algorithm:'RandomX',hashrate:18000,
    unit:'H/s',watts:175
  }),ids,now);
  assert.ok(a);
  const b=validateOwnedBenchmark(sample({
    coin:'FLUX',algorithm:'FluxHash / Equihash',unit:'Sol/s',hashrate:55
  }),ids,now);
  assert.ok(b);
  assert.equal(ALGORITHMS.FLUX.unit,'Sol/s');
});
test('rejects stale or future samples and any dataset duplication',()=>{
  for(const age of [-8*60000,181*86400000]){
    const timestamp=new Date(now-age).toISOString();
    assert.equal(validateOwnedBenchmark(sample({observedAt:timestamp}),ids,now),null);
  }
  assert.equal(validateOwnedBenchmarkDataset({schemaVersion:1,source:'untrusted',samples:[]},ids,now),null);
  const s=sample(),doc={schemaVersion:1,source:'gpubnb-owned-lab',samples:[s]};
  assert.equal(validateOwnedBenchmarkDataset(doc,ids,now).samples.length,1);
  assert.equal(validateOwnedBenchmarkDataset({...doc,samples:[s,s]},ids,now),null);
  assert.equal(validateOwnedBenchmarkDataset({...doc,samples:[s,sample({coin:'ERG',algorithm:'Autolykos v2'})]},ids,now).samples.length,2);
});
test('cannot publish other miners user data merely by setting consent flag',()=>{
  assert.equal(validateOwnedBenchmark(sample({sampleMethod:'user-upload',consentToPublish:true}),ids,now),null);
});

test('sanitized published file can be validated without leaking consent flag',()=>{
  const privateDoc={schemaVersion:1,source:'gpubnb-owned-lab',samples:[sample()]};
  const sanitized=validateOwnedBenchmarkDataset(privateDoc,ids,now);
  const publicBytes=JSON.parse(JSON.stringify(sanitized));
  const validated=validatePublishedOwnedBenchmarks(publicBytes,ids,now);
  assert.ok(validated);
  assert.equal(validated.samples.length,1);
  assert.equal(validated.samples[0].consentToPublish,undefined);
  assert.equal(validatePublishedOwnedBenchmarks({...publicBytes,
    samples:[{...publicBytes.samples[0],privateToken:'secret'}]},ids,now),null);
  assert.equal(validatePublishedOwnedBenchmarks({...publicBytes,
    samples:[{...publicBytes.samples[0],hashrate:'invalid'}]},ids,now),null);
});
