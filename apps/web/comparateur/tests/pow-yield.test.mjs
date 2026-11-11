import test from 'node:test';
import assert from 'node:assert/strict';
import {COINS,estimatePoW,estimateMeasuredPayout,validateOwnPoWSnapshot,FRESH_MS} from '../lib/pow-yield.mjs';
const now=Date.parse('2026-11-11T12:00:00.000Z');
const args={coin:'RVN',unit:'H/s',deviceRate:100,networkRate:1000000,
 blockSeconds:60,minerRewardCoins:1000,quantity:1,hours:24,watts:200,electricityEurKwh:0.2,poolFeePercent:1};
const snap=(coin='ETC')=>({
 schemaVersion:1,coin,network:'mainnet',algorithm:COINS[coin].algorithm,
 unit:COINS[coin].unit,source:'own-node',collectedAt:new Date(now).toISOString(),
 blockTimestamp:new Date(now-120000).toISOString(),blockHeight:26000000,
 networkRate:5000000,blockSeconds:15,minerRewardCoins:1.6384,
 methodology:'sampled 32 consecutive local node blocks'
});
test('all 14 GPUbnb/miner and requested currencies are recorded without fake benchmarks',()=>{
 assert.deepEqual(Object.keys(COINS),[
   'XMR','RVN','ETC','ERG','FLUX','PRL','ALPH','KAS','CFX','NEOX','BEAM','CTXC','BTC','ZEC']);
 assert.equal(COINS.FLUX.unit,'Sol/s');
 assert.equal(COINS.ZEC.unit,'Sol/s');
 assert.equal(COINS.BEAM.unit,'Sol/s');
 assert.equal(COINS.CTXC.unit,'Graph/s');
 assert.equal(COINS.BTC.unit,'H/s');
 assert.equal(COINS.PRL.mode,'measured');
 assert.equal(COINS.BTC.requiresAsic,true);
 assert.equal(COINS.KAS.requiresAsic,true);
 assert.equal(COINS.ALPH.requiresAsic,true);
 assert.equal(COINS.ZEC.requiresAsic,true);
});
test('share of network yields expected 24h, month 30, year 365',()=>{
 const r=estimatePoW(args);
 assert.ok(r);assert.ok(Math.abs(r.coinsDay-144)<1e-10);
 assert.equal(r.coinsMonth30,r.coinsDay*30);
 assert.equal(r.coinsYear365,r.coinsDay*365);
 assert.equal(r.netEurDay,null);
});
test('price is manual; positive/negative net accounting energy and pool',()=>{
 const r=estimatePoW({...args,coinEur:1});
 assert.ok(Math.abs(r.revenueEurDay-144)<1e-10);
 assert.ok(Math.abs(r.electricEurDay-0.96)<1e-10);
 assert.ok(Math.abs(r.poolEurDay-1.44)<1e-10);
 assert.ok(Math.abs(r.netEurDay-141.6)<1e-10);
 const loss=estimatePoW({...args,coinEur:0});
 assert.ok(loss.netEurDay<0);
});
test('hours, quantity, wallet and pool costs remain separate',()=>{
 const half=estimatePoW({...args,quantity:2,hours:12,coinEur:0.1});
 assert.ok(Math.abs(half.coinsDay-144)<1e-10);
 assert.ok(Math.abs(half.energyKwhDay-4.8)<1e-10);
});
test('Flux only permits Sol/s input; pool share must never exceed 100%',()=>{
 assert.equal(estimatePoW({...args,coin:'FLUX',unit:'H/s'}),null);
 assert.ok(estimatePoW({...args,coin:'FLUX',unit:'Sol/s'}));
 assert.equal(estimatePoW({...args,deviceRate:2000000}),null);
});
test('rejects unknown coins, bad rates, invalid pricing and fractional devices',()=>{
 for(const override of [{coin:'DOGE'}, {networkRate:0}, {blockSeconds:0},
  {minerRewardCoins:-1},{quantity:1.5},{quantity:101},{hours:25},
  {coinEur:-3},{poolFeePercent:101},{deviceRate:NaN},{watts:-1}])
  assert.equal(estimatePoW({...args,...override}),null);
});
test('valid local snapshots only; check freshness, unit, reward and origin',()=>{
 const d=snap();
 assert.equal(validateOwnPoWSnapshot(d,now)?.coin,'ETC');
 assert.equal(validateOwnPoWSnapshot({...d,coin:'FLUX'},now),null);
 assert.equal(validateOwnPoWSnapshot({...d,source:'thirdparty'},now),null);
 assert.equal(validateOwnPoWSnapshot({...d,network:'testnet'},now),null);
 assert.equal(validateOwnPoWSnapshot({...d,blockSeconds:'15'},now),null);
 assert.equal(validateOwnPoWSnapshot({...d,collectedAt:new Date(now-FRESH_MS-1000).toISOString()},now),null);
 assert.equal(validateOwnPoWSnapshot({...d,collectedAt:new Date(now+360000).toISOString()},now),null);
 assert.equal(validateOwnPoWSnapshot({...d,methodology:'unknown'},now),null);
});

test('ASIC rigs with more than 2kW are supported using their OWN measured power',()=>{
 const b=estimatePoW({...args,coin:'BTC',deviceRate:120e12,
   networkRate:1e21,blockSeconds:600,minerRewardCoins:3.125,
   watts:3500,coinEur:100000});
 assert.ok(b);
 assert.ok(Math.abs(b.energyKwhDay-84)<1e-9);
 assert.equal(b.coin,'BTC');
 assert.equal(estimatePoW({...args,coin:'BTC',watts:20001}),null);
});
test('Zcash Equihash must be measured in Sol/s, not BTC H/s',()=>{
 assert.ok(estimatePoW({...args,coin:'ZEC',unit:'Sol/s',deviceRate:420000,
   networkRate:1e9,blockSeconds:75,minerRewardCoins:0.8,watts:2500}));
 assert.equal(estimatePoW({...args,coin:'ZEC',unit:'H/s'}),null);
});
test('Pearl PoUW rejects arbitrary network-H/s mathematical mining estimates',()=>{
 assert.equal(estimatePoW({...args,coin:'PRL',unit:null}),null);
 assert.equal(estimatePoW({...args,coin:'PRL',unit:'H/s'}),null);
 assert.equal(estimateMeasuredPayout({coin:'BTC',observedCoins:2,observedHours:24}),null);
});
test('Pearl payout projections use measured gross amounts, uptime, pool and electricity',()=>{
 const result=estimateMeasuredPayout({
  coin:'PRL',observedCoins:12,observedHours:48,quantity:2,hours:12,
  watts:180,electricityEurKwh:.2,poolFeePercent:1,coinEur:1.5
 });
 assert.ok(result);
 assert.equal(result.mode,'historical-observation');
 assert.ok(Math.abs(result.coinsDay-6)<1e-9);
 assert.ok(Math.abs(result.energyKwhDay-4.32)<1e-9);
 assert.ok(Math.abs(result.revenueEurDay-9)<1e-9);
 assert.ok(Math.abs(result.netEurDay-(9-.09-.864))<1e-9);
 assert.equal(result.netEurMonth30,result.netEurDay*30);
 assert.equal(result.netEurYear365,result.netEurDay*365);
});
test('Pearl measured payout has bounds, no invented price, no double class mixing',()=>{
 const fallback=estimateMeasuredPayout({
   observedCoins:1,observedHours:24,watts:180,electricityEurKwh:.2});
 assert.ok(fallback);
 assert.equal(fallback.netEurDay,null);
 assert.equal(estimateMeasuredPayout({observedCoins:1,observedHours:0}),null);
 assert.equal(estimateMeasuredPayout({observedCoins:1,observedHours:24,quantity:1.5}),null);
 assert.equal(estimateMeasuredPayout({observedCoins:1,observedHours:24,coinEur:-1}),null);
});
test('NEOX uses miner-only rewards; never 100% of the block subsidy',()=>{
 const miner=estimatePoW({...args,coin:'NEOX',minerRewardCoins:500});
 const whole=estimatePoW({...args,coin:'NEOX',minerRewardCoins:2500});
 assert.ok(miner);
 assert.equal(whole.coinsDay,miner.coinsDay*5);
 assert.match(COINS.NEOX.comment,/20 %/);
});
test('rejects attempts to pass Pearl as a verified network snapshot',()=>{
 const raw=snap();
 assert.equal(validateOwnPoWSnapshot({...raw,coin:'PRL',algorithm:COINS.PRL.algorithm,
   unit:null},now),null);
});
