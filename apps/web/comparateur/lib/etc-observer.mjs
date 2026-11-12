/* ETC mainnet (61) observer. For a self-hosted local Core-Geth node only. */
import {validateOwnPoWSnapshot} from './pow-yield.mjs';
export const ETC_WINDOW=32;
const numberFromHex=value=>{
 if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))throw Error('Invalid ETC quantity');
 const v=BigInt(value);
 if(v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Unsupported ETC quantity');
 return Number(v);
};
export function etcSubsidyAtHeight(height){
 if(!Number.isSafeInteger(height)||height<1)return null;
 return 5*Math.pow(.8,Math.floor((height-1)/5000000));
}
/** Blocks are ordered oldest to latest, with ETC_WINDOW+1 records.
 * Protocol base subsidy only; fees, uncles and MEV excluded.
 */
export function buildEtcObservation({chainId,syncing,blocks,allowMissingSyncStatus=false},now=Date.now()){
 // Some restricted *public* RPCs do not expose eth_syncing (method -32601).
 // Accept that specific case only when the caller explicitly opts in.
 // Validate chain ID, 33 linked blocks and a fresh tip regardless.
 const syncingValid=syncing===false||(syncing===null&&allowMissingSyncStatus===true);
 if(chainId!=='0x3d'||!syncingValid||!Array.isArray(blocks)||
 blocks.length!==ETC_WINDOW+1)throw Error('Verified ETC mainnet blocks required');
 const parsed=blocks.map(b=>{
   if(!b||typeof b.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(b.hash)||
   typeof b.parentHash!=='string'||!/^0x[0-9a-f]{64}$/i.test(b.parentHash))throw Error('Invalid ETC block hash');
   return {height:numberFromHex(b.number),timestamp:numberFromHex(b.timestamp),
     difficulty:numberFromHex(b.difficulty),hash:b.hash.toLowerCase(),parent:b.parentHash.toLowerCase()};
 });
 for(let i=1;i<parsed.length;i++){
   if(parsed[i].height!==parsed[i-1].height+1||
      parsed[i].parent!==parsed[i-1].hash ||
      parsed[i].timestamp<=parsed[i-1].timestamp||
      parsed[i].difficulty<=0)throw Error('Missing, incoherent or invalid ETC block sample');
 }
 const tip=parsed.at(-1),first=parsed[0],seconds=tip.timestamp-first.timestamp;
 const age=now-tip.timestamp*1000;
 if(!Number.isFinite(now)||age< -5*60000||age>20*60000||
 seconds<ETC_WINDOW||seconds>ETC_WINDOW*7200)throw Error('ETC tip stale or invalid elapsed time');
 const networkRate=parsed.slice(1).reduce((s,b)=>s+b.difficulty,0)/seconds;
 const blockSeconds=seconds/ETC_WINDOW;
 const minerRewardCoins=etcSubsidyAtHeight(tip.height);
 if(!Number.isFinite(networkRate)||networkRate<=0||minerRewardCoins===null)throw Error('Unusable ETC values');
 const raw={schemaVersion:1,coin:'ETC',algorithm:'Etchash',unit:'H/s',
   network:'mainnet',source:'own-node',collectedAt:new Date(now).toISOString(),
   blockTimestamp:new Date(tip.timestamp*1000).toISOString(),blockHeight:tip.height,
   networkRate,blockSeconds,minerRewardCoins,
   methodology:'ETC 32-block total difficulty / elapsed time; ECIP-1017 base subsidy, excluding fees, uncles and MEV'};
 if(!validateOwnPoWSnapshot(raw,now))throw Error('Invalid ETC snapshot');
 return raw;
}
