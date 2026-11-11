/**
 * GPUbnb — original, offline, multi-coin Proof-of-Work profitability calculations.
 * Inputs are measured by the operator or a user. No mining data provider required.
 * A hashrate is only comparable to the network on the SAME algorithm and in SAME units.
 */
/**
 * Primary catalog: GPUbnb Host and web mining profiles, plus BTC/ZEC requested
 * by the owner. Hardware advice is NOT a benchmark or a recommendation to mine.
 * PRL is purpose-built PoUW: generic network-hashrate formula must not be used.
 */
export const COINS=Object.freeze({
 XMR:Object.freeze({symbol:'XMR',name:'Monero',algorithm:'RandomX',hardware:'CPU (ASIC possibles)',unit:'H/s',mode:'pow',requiresAsic:false,comment:'Calcul RandomX plus précis dans le panneau Monero dédié.'}),
 RVN:Object.freeze({symbol:'RVN',name:'Ravencoin',algorithm:'KawPoW',hardware:'GPU',unit:'H/s',mode:'pow',requiresAsic:false,comment:'Hashrate KawPoW uniquement ; rémunération mineur, frais de bloc selon la source.'}),
 ETC:Object.freeze({symbol:'ETC',name:'Ethereum Classic',algorithm:'Etchash',hardware:'GPU / ASIC',unit:'H/s',mode:'pow',requiresAsic:false,comment:'Récompense mineur effective. L’observateur ETC automatique exclut volontairement les frais et oncles.'}),
 ERG:Object.freeze({symbol:'ERG',name:'Ergo',algorithm:'Autolykos v2',hardware:'GPU',unit:'H/s',mode:'pow',requiresAsic:false,comment:'Réémission, storage rent et frais peuvent modifier les récompenses réellement versées.'}),
 FLUX:Object.freeze({symbol:'FLUX',name:'Flux',algorithm:'FluxHash / Equihash',hardware:'GPU',unit:'Sol/s',mode:'pow',requiresAsic:false,comment:'N’utiliser que la part PoW versée aux mineurs, pas celle des FluxNodes.'}),
 PRL:Object.freeze({symbol:'PRL',name:'Pearl',algorithm:'PearlHash / Proof of Useful Work',hardware:'GPU (IA)',unit:null,mode:'measured',requiresAsic:false,comment:'PRL : mesures de gains réels du mineur/pool uniquement. Le PoUW ne se résume pas à un hashrate générique.'}),
 ALPH:Object.freeze({symbol:'ALPH',name:'Alephium',algorithm:'Blake3',hardware:'ASIC dominant',unit:'H/s',mode:'pow',requiresAsic:true,comment:'Alephium exploite plusieurs chaînes : utiliser la valeur réseau globale et la rémunération moyenne rapportée à l’ensemble du réseau, sans multiplier deux fois les blocs.'}),
 KAS:Object.freeze({symbol:'KAS',name:'Kaspa',algorithm:'kHeavyHash',hardware:'ASIC dominant',unit:'H/s',mode:'pow',requiresAsic:true,comment:'Le GPU/CPU peut calculer du kHeavyHash mais n’est plus compétitif face aux ASIC.'}),
 CFX:Object.freeze({symbol:'CFX',name:'Conflux',algorithm:'Octopus',hardware:'GPU',unit:'H/s',mode:'pow',requiresAsic:false,comment:'Conflux : utiliser un temps et une récompense de blocs réellement validés pour le consensus Tree-Graph, pas une valeur supposée.'}),
 NEOX:Object.freeze({symbol:'NEOX',name:'Neoxa',algorithm:'KawPoW',hardware:'GPU',unit:'H/s',mode:'pow',requiresAsic:false,comment:'Neoxa : seul 20 % de la récompense de bloc revient aux mineurs PoW, ne pas utiliser la récompense totale.'}),
 BEAM:Object.freeze({symbol:'BEAM',name:'Beam (Mimblewimble)',algorithm:'BeamHash III',hardware:'GPU',unit:'Sol/s',mode:'pow',requiresAsic:false,comment:'Beam Mimblewimble, à ne pas confondre avec un autre token BEAM homonyme.'}),
 CTXC:Object.freeze({symbol:'CTXC',name:'Cortex',algorithm:'Cuckatoo32',hardware:'GPU mémoire élevée',unit:'Graph/s',mode:'pow',requiresAsic:false,comment:'Les Graph/s ne sont pas des H/s : mesurer l’algorithme Cuckatoo32 séparément.'}),
 BTC:Object.freeze({symbol:'BTC',name:'Bitcoin',algorithm:'SHA-256',hardware:'ASIC',unit:'H/s',mode:'pow',requiresAsic:true,comment:'Bitcoin demande un ASIC spécialisé pour une rentabilité réaliste ; ne pas extrapoler à partir du hashrate GPU.'}),
 ZEC:Object.freeze({symbol:'ZEC',name:'Zcash',algorithm:'Equihash (200,9)',hardware:'ASIC',unit:'Sol/s',mode:'pow',requiresAsic:true,comment:'Zcash utilise Equihash 200,9, pas le même algorithme ni les mêmes mesures que Flux ou Beam.'})
});
export const FRESH_MS=20*60*1000;
// Keep a public observation for at most 24 hours from its LAST SUCCESSFUL collection.
export const PUBLIC_FRESH_MS=24*60*60*1000;
const is=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const isId=coin=>Object.hasOwn(COINS,coin);
const sameKind=(coin,unit)=>COINS[coin]?.mode==='pow'&&unit===COINS[coin].unit;
/** Calculate expected yields using the fraction of network work.
 * Network hashrate and device hashrate must both be H/s, or both Sol/s for FLUX.
 * blockSeconds is observed average block interval, minerRewardCoins is paid to PoW
 * miners ONLY; don't include extra fees in gross when already counted in reward.
 */
export function estimatePoW({
 coin,deviceRate,networkRate,blockSeconds,minerRewardCoins,
 quantity=1,hours=24,watts=0,electricityEurKwh=0,poolFeePercent=0,coinEur=null,
 unit=COINS[coin]?.unit
}){
 if(!isId(coin)||!sameKind(coin,unit)||!is(deviceRate,0.000001,1e18)||
 !is(networkRate,0.000001,1e25)||!is(blockSeconds,1,7200)||
 !is(minerRewardCoins,0.000000000000000001,1e10)||
 !Number.isInteger(quantity)||!is(quantity,1,100)||
 !is(hours,0,24)||!is(watts,0,20000)||
 !is(electricityEurKwh,0,5)||!is(poolFeePercent,0,100)||
 !(coinEur===null||is(coinEur,0,1e7))) return null;
 const dailyBlocks=86400/blockSeconds;
 const share=deviceRate*quantity/networkRate;
 // Reject configurations likely to be entered with incorrect units.
 if(share>1)return null;
 const coinsDay=share * dailyBlocks * minerRewardCoins * (hours/24);
 if(!Number.isFinite(coinsDay))return null;
 const energyKwhDay=watts/1000*quantity*hours;
 const electricEurDay=energyKwhDay*electricityEurKwh;
 const revenueEurDay=coinEur===null?null:coinsDay*coinEur;
 const poolEurDay=revenueEurDay===null?null:revenueEurDay*poolFeePercent/100;
 const netEurDay=revenueEurDay===null?null:revenueEurDay-poolEurDay-electricEurDay;
 return Object.freeze({
 coin,unit,coinsDay,coinsMonth30:coinsDay*30,coinsYear365:coinsDay*365,
 dailyBlocks,share,energyKwhDay,electricEurDay,revenueEurDay,poolEurDay,
 netEurDay,netEurMonth30:netEurDay===null?null:netEurDay*30,
 netEurYear365:netEurDay===null?null:netEurDay*365,
 priceMode:coinEur===null?'unavailable':'manual'
 });
}
/** Trusted schema for snapshots produced from *our* blockchain node observers.
 * A file with a name 'own-node' is not cryptographically proven: its publisher
 * MUST be trusted and generated by the corresponding local verified observer.
 */
export function validateOwnPoWSnapshot(doc,now=Date.now()){
 if(!doc||doc.schemaVersion!==1||!isId(doc.coin)||COINS[doc.coin].mode!=='pow'||doc.network!=='mainnet'||
 (doc.source!=='own-node'&&doc.source!=='public-chain-rpc')||
 (doc.source==='public-chain-rpc'&&!((doc.coin==='ETC'&&
   ['ETC Blockscout','ETC ETCMC','ETC ETC Desktop'].includes(doc.operator))||
   (doc.coin==='RVN'&&doc.operator==='RavencoinExplorer')))||
 (doc.source==='public-chain-rpc'&&doc.coin==='ETC'&&(
   typeof doc.usedFallback!=='boolean'||
   doc.usedFallback!==(doc.operator!=='ETC Blockscout')))||
 doc.algorithm!==COINS[doc.coin].algorithm||
 doc.unit!==COINS[doc.coin].unit||
 !is(doc.networkRate,0.000001,1e25)||!is(doc.blockSeconds,1,7200)||
 !is(doc.minerRewardCoins,0.000000000000000001,1e10)||
 !Number.isSafeInteger(doc.blockHeight)||doc.blockHeight<1||
 typeof doc.methodology!=='string'||doc.methodology.length<10||
 doc.methodology.length>240) return null;
 const collected=Date.parse(doc.collectedAt||'');
 const chain=Date.parse(doc.blockTimestamp||'');
 if(!Number.isFinite(now)||!Number.isFinite(collected)||!Number.isFinite(chain)||
 collected>now+5*60000||collected<now-(doc.source==='public-chain-rpc'?PUBLIC_FRESH_MS:FRESH_MS)||
 chain>collected+5*60000||chain<collected-30*60000)return null;
 return Object.freeze({
 coin:doc.coin,networkRate:doc.networkRate,blockSeconds:doc.blockSeconds,
 minerRewardCoins:doc.minerRewardCoins,unit:doc.unit,blockHeight:doc.blockHeight,
 collectedAt:doc.collectedAt,source:doc.source,operator:doc.operator||null,
 usedFallback:doc.source==='public-chain-rpc'&&doc.coin==='ETC'?doc.usedFallback:false,
 methodology:doc.methodology
 });
}


/**
 * Pearl does not have directly comparable H/s mining: project a user-observed
 * *gross* PRL payout per ONE device and actual mining hours. It is a historical
 * rate projection, NOT a protocol proof or a guaranteed forward-looking return.
 */
export function estimateMeasuredPayout({
 coin='PRL',observedCoins,observedHours,quantity=1,hours=24,watts=0,
 electricityEurKwh=0,poolFeePercent=0,coinEur=null
}){
 if(coin!=='PRL'||!is(observedCoins,0,1e10)||
   !is(observedHours,1,8760)||
   !Number.isInteger(quantity)||!is(quantity,1,100)||
   !is(hours,0,24)||!is(watts,0,20000)||
   !is(electricityEurKwh,0,5)||!is(poolFeePercent,0,100)||
   !(coinEur===null||is(coinEur,0,1e7)))return null;
 const coinsDay=observedCoins/observedHours*quantity*hours;
 const energyKwhDay=watts*quantity*hours/1000;
 const electricEurDay=energyKwhDay*electricityEurKwh;
 const revenueEurDay=coinEur===null?null:coinsDay*coinEur;
 const poolEurDay=revenueEurDay===null?null:revenueEurDay*poolFeePercent/100;
 const netEurDay=revenueEurDay===null?null:revenueEurDay-poolEurDay-electricEurDay;
 return Object.freeze({
  coin:'PRL',mode:'historical-observation',coinsDay,coinsMonth30:coinsDay*30,
  coinsYear365:coinsDay*365,energyKwhDay,electricEurDay,revenueEurDay,poolEurDay,
  netEurDay,netEurMonth30:netEurDay===null?null:netEurDay*30,
  netEurYear365:netEurDay===null?null:netEurDay*365,
  priceMode:coinEur===null?'unavailable':'manual'
 });
}
