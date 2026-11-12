/** Original GPUbnb Monero model. Uses a node YOU operate, not a mining-data API. */
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const bounded=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
function asUnsignedBigint(value,name){
  if((typeof value!=='string'&&typeof value!=='number')||
      (typeof value==='number'&&!Number.isSafeInteger(value)))throw new TypeError('Invalid '+name);
  const raw=String(value);
  if(!/^(0x[\da-fA-F]+|\d+)$/.test(raw))throw new TypeError('Invalid '+name);
  const n=BigInt(raw);
  if(n<=0n)throw new RangeError(name+' must be positive');
  return n;
}
export function parseMoneroHeader(rpc,nowMs=Date.now()){
  if(!rpc||rpc.result?.status!=='OK'||rpc.result.untrusted===true||
    !rpc.result.block_header)throw new Error('Invalid or untrusted Monero RPC response');
  const h=rpc.result.block_header;
  const difficulty=Number(asUnsignedBigint(h.wide_difficulty??h.difficulty,'difficulty'));
  const rewardAtomic=Number(asUnsignedBigint(h.reward,'reward'));
  const ageMs=nowMs-Number(h.timestamp)*1000;
  if(!positive(difficulty)||!Number.isSafeInteger(rewardAtomic)||
    !Number.isSafeInteger(h.height)||h.height<1||
    !Number.isFinite(ageMs)||ageMs < -300000||ageMs>30*60*1000)
    throw new Error('Unusable or stale Monero block header');
  return Object.freeze({difficulty,rewardXmr:rewardAtomic/1e12,
    height:h.height,timestamp:new Date(Number(h.timestamp)*1000).toISOString(),
    source:'own-monero-node',rewardIncludesTxFees:true});
}
export function estimateMoneroYield({network,hashrateHps,quantity=1,hoursPerDay=24,
  wattsPerDevice=0,electricityEurKwh=0,poolFeePercent=0,xmrEur=null}){
  if(!network||!positive(network.difficulty)||!positive(network.rewardXmr)||
    !positive(hashrateHps)||!Number.isInteger(quantity)||!bounded(quantity,1,100)||
    !bounded(hoursPerDay,0,24)||!bounded(wattsPerDevice,0,2000)||
    !bounded(electricityEurKwh,0,5)||!bounded(poolFeePercent,0,100)||
    !(xmrEur===null||bounded(xmrEur,0,10000000)))
    throw new RangeError('Invalid mining parameters');
  const expectedXmrDay=hashrateHps*quantity*hoursPerDay*3600/network.difficulty*network.rewardXmr;
  const energyKwhDay=wattsPerDevice*quantity*hoursPerDay/1000;
  const energyEurDay=energyKwhDay*electricityEurKwh;
  const grossEurDay=xmrEur===null?null:expectedXmrDay*xmrEur;
  const poolEurDay=grossEurDay===null?null:grossEurDay*poolFeePercent/100;
  const netEurDay=grossEurDay===null?null:grossEurDay-poolEurDay-energyEurDay;
  return {expectedXmrDay,expectedXmrMonth30:expectedXmrDay*30,
    expectedXmrYear365:expectedXmrDay*365,energyKwhDay,energyEurDay,
    grossEurDay,poolEurDay,netEurDay,netEurMonth30:netEurDay===null?null:netEurDay*30,
    netEurYear365:netEurDay===null?null:netEurDay*365,
    dataQuality:'theoretical-single-block-snapshot',
    priceSource:xmrEur===null?'unavailable':'entered-manually'};
}
