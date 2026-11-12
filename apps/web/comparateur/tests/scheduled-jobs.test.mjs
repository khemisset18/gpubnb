import test from 'node:test';
import assert from 'node:assert/strict';
import {CRON_TO_COIN,collectAutomated} from '../edge/worker.mjs';

test('three non-overlapping Cron triggers each run once per UTC hour',()=>{
 assert.deepEqual(CRON_TO_COIN,{
  '17 * * * *':'XMR',
  '27 * * * *':'ETC',
  '37 * * * *':'RVN'
 });
 assert.equal(new Set(Object.values(CRON_TO_COIN)).size,3);
});
test('only selected coin is collected, others are not touched during its Cron',async()=>{
 const calls=[],writes=[];
 const env={SNAPSHOTS:{async put(...args){writes.push(args)}}};
 const offline=async url=>{calls.push(url);throw Error('offline');};
 const result=await collectAutomated(env,{
  coins:['ETC'],fetchImpl:offline,clock:()=>Date.parse('2026-11-12T12:00:00Z')
 });
 assert.equal(result.length,1);
 assert.equal(result[0].coin,'ETC');
 assert.equal(result[0].ok,false);
 assert.equal(writes.length,0);
 assert.ok(calls.length>0);
 assert.ok(calls.every(url=>url.startsWith('https://etc.')||
   url.startsWith('https://rpc.etcmc.xyz')));
});
test('rejects unknown, empty or multi-coin Cron selection',async()=>{
 const env={SNAPSHOTS:{async put(){}}};
 for(const coins of [[],['BTC'],['XMR','ETC'],{},null]){
  if(coins===null)continue; // null means explicit manual full-suite run for tests.
  await assert.rejects(collectAutomated(env,{coins,fetchImpl:async()=>{throw Error('offline')}}));
 }
});
