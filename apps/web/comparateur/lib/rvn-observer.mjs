/* Ravencoin mainnet observation from OUR ravend node only.
   Expects 33 consecutive verbose blocks and node's native getnetworkhashps.
   Coinbase outputs are RVN received by miners, including observed fees. */
import {validateOwnPoWSnapshot} from './pow-yield.mjs';
export const RVN_WINDOW=32;
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
export function buildRvnObservation({info,networkHashps,blocks},now=Date.now()){
 if(!info||info.chain!=='main'||info.initialblockdownload!==false||
 !Number.isSafeInteger(info.blocks)||!Number.isSafeInteger(info.headers)||
 info.blocks<1000000||info.headers>info.blocks+3||
 !positive(networkHashps)||networkHashps>1e25||
 !Array.isArray(blocks)||blocks.length!==RVN_WINDOW+1)throw Error('Synchronized own Ravencoin mainnet node required');
 let sumReward=0;
 for(let i=0;i<blocks.length;i++){
  const b=blocks[i];
  if(!b||!Number.isSafeInteger(b.height)||!Number.isSafeInteger(b.time)||
    !/^[0-9a-f]{64}$/i.test(b.hash)||b.confirmations<0||
    (i>0&&(b.height!==blocks[i-1].height+1||
                b.previousblockhash!==blocks[i-1].hash ||
                b.time<=blocks[i-1].time)))throw Error('Invalid Ravencoin chain sample');
  if(i===0)continue;
  const coinbase=b.tx?.[0];
  if(!coinbase||!Array.isArray(coinbase.vin)||!coinbase.vin[0]?.coinbase||
   !Array.isArray(coinbase.vout)||coinbase.vout.length===0)throw Error('Missing native coinbase');
  let reward=0;
  for(const vout of coinbase.vout){
   if(typeof vout.value!=='number'||!Number.isFinite(vout.value)||vout.value<0)
     throw Error('Invalid coinbase amount');
   reward+=vout.value;
  }
  if(!positive(reward)||reward>100000)throw Error('Out of range coinbase reward');
  sumReward+=reward;
 }
 const tip=blocks.at(-1);
 if(tip.height!==info.blocks||info.bestblockhash!==tip.hash||
   now-tip.time*1000>20*60000||now-tip.time*1000< -5*60000)
   throw Error('Ravencoin node tip is missing or stale');
 const elapsed=tip.time-blocks[0].time;
 if(elapsed<RVN_WINDOW||elapsed>RVN_WINDOW*7200)throw Error('Implausible block interval');
 const snapshot={schemaVersion:1,coin:'RVN',algorithm:'KawPoW',unit:'H/s',
  network:'mainnet',source:'own-node',collectedAt:new Date(now).toISOString(),
  blockTimestamp:new Date(tip.time*1000).toISOString(),blockHeight:tip.height,
  networkRate:networkHashps,blockSeconds:elapsed/RVN_WINDOW,
  minerRewardCoins:sumReward/RVN_WINDOW,
  methodology:'RVN 32-block coinbase outputs incl fees; node native getnetworkhashps (120 blocks)'};
 if(!validateOwnPoWSnapshot(snapshot,now))throw Error('Invalid Ravencoin snapshot');
 return snapshot;
}
