/**
 * GPUbnb's OWN voluntary benchmark data format.
 * Original implementation, no dependency on commercial mining-data APIs.
 * This validates input for local operator review; not proof of a truthful measurement.
 */
export const ALGORITHMS=Object.freeze({
  XMR:Object.freeze({name:'RandomX',unit:'H/s'}),
  RVN:Object.freeze({name:'KawPoW',unit:'H/s'}),
  ETC:Object.freeze({name:'Etchash',unit:'H/s'}),
  ERG:Object.freeze({name:'Autolykos v2',unit:'H/s'}),
  FLUX:Object.freeze({name:'FluxHash / Equihash',unit:'Sol/s'})
});
const isNum=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const validId=id=>typeof id==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)&&id.length<=100;
/**
 * Returns only allowed public measurement fields and strips unknown properties.
 * Default policy: lab-measured only. User-provided submissions MUST NOT be published
 * merely because a boolean consent flag says true; verify consent out of band.
 */
export function validateOwnedBenchmark(raw,knownDeviceIds,now=Date.now()){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||
     !knownDeviceIds||typeof knownDeviceIds.has!=='function')return null;
  if(!validId(raw.deviceId)||!knownDeviceIds.has(raw.deviceId))return null;
  if(typeof raw.coin!=='string'||!Object.hasOwn(ALGORITHMS,raw.coin))return null;
  const algo=ALGORITHMS[raw.coin];
  if(!algo||raw.algorithm!==algo.name||raw.unit!==algo.unit||
    !isNum(raw.hashrate,0.000001,1e15)||!isNum(raw.watts,1,2000)||
    !Number.isInteger(raw.durationSeconds)||!isNum(raw.durationSeconds,300,86400)||
    raw.deviceCount!==1||raw.powerScope!=='wall-whole-rig'||
    raw.sampleMethod!=='operator-measured'||raw.consentToPublish!==true)return null;
  const at=Date.parse(raw.observedAt||'');
  if(!Number.isFinite(at)||!Number.isFinite(now)||at>now+5*60000||
    at<now-180*86400000)return null;
  // Whitelisting avoids leaking serials, IPs, account IDs, wallet addresses,
  // environment variables or miner configuration in the public snapshot.
  const clean={deviceId:raw.deviceId,coin:raw.coin,algorithm:algo.name,unit:algo.unit,
    hashrate:raw.hashrate,watts:raw.watts,durationSeconds:raw.durationSeconds,
    deviceCount:1,observedAt:new Date(at).toISOString(),
    powerScope:'wall-whole-rig',sampleMethod:'operator-measured'};
  return Object.freeze(clean);
}

export function validateOwnedBenchmarkDataset(doc, knownDeviceIds,now=Date.now()){
  if(!doc||doc.schemaVersion!==1||doc.source!=='gpubnb-owned-lab'||
    !Array.isArray(doc.samples)||doc.samples.length>1000)return null;
  const seen=new Set(),samples=[];
  for(const entry of doc.samples){
    const clean=validateOwnedBenchmark(entry,knownDeviceIds,now);
    if(!clean)return null;
    const key=[clean.deviceId,clean.coin,clean.observedAt].join('/');
    if(seen.has(key))return null;
    seen.add(key);samples.push(clean);
  }
  return Object.freeze({schemaVersion:1,source:'gpubnb-owned-lab',samples:Object.freeze(samples)});
}


/** Validate the already-sanitized public output of the local operator publisher.
 * This does not verify that the original measurements were truthful.
 * Require an allow-list of current GPUbnb hardware IDs from the application.
 */
export function validatePublishedOwnedBenchmarks(doc,knownDeviceIds,now=Date.now()){
  if(!doc||doc.schemaVersion!==1||doc.source!=='gpubnb-owned-lab'||
    !Array.isArray(doc.samples)||doc.samples.length>1000)return null;
  const fields=new Set(['deviceId','coin','algorithm','unit','hashrate','watts',
    'durationSeconds','deviceCount','observedAt','powerScope','sampleMethod']);
  const samples=[],seen=new Set();
  for(const raw of doc.samples){
    if(!raw||typeof raw!=='object'||Object.keys(raw).some(k=>!fields.has(k)))return null;
    // Internal validation requires the operator's original consent-to-publish flag,
    // which is never copied into the public file.
    const sample=validateOwnedBenchmark({...raw,consentToPublish:true},knownDeviceIds,now);
    if(!sample)return null;
    const id=sample.deviceId+'/'+sample.coin+'/'+sample.observedAt;
    if(seen.has(id))return null;
    seen.add(id);
    samples.push(sample);
  }
  return Object.freeze({schemaVersion:1,source:'gpubnb-owned-lab',samples:Object.freeze(samples)});
}
