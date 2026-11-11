import test from 'node:test';
import assert from 'node:assert/strict';
import {COINS,estimatePoW,validateOwnPoWSnapshot,FRESH_MS} from '../lib/pow-yield.mjs';
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
test('five coins supported with correct hardware and algorithm units',()=>{
 assert.deepEqual(Object.keys(COINS),['XMR','RVN','ETC','ERG','FLUX']);
 assert.equal(COINS.FLUX.unit,'Sol/s');assert.equal(COINS.ETC.unit,'H/s');
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
 assert.ok(Math.abs(half.energyKwhDay-2.4)<1e-10);
});
test('Flux only permits Sol/s input; pool share must never exceed 100%',()=>{
 assert.equal(estimatePoW({...args,coin:'FLUX',unit:'H/s'}),null);
 assert.ok(estimatePoW({...args,coin:'FLUX',unit:'Sol/s'}));
 assert.equal(estimatePoW({...args,deviceRate:2000000}),null);
});
test('rejects unknown coins, bad rates, invalid pricing and fractional devices',()=>{
 for(const override of [{coin:'BTC'}, {networkRate:0}, {blockSeconds:0},
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
