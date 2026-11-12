/* Generates ETC public PoW snapshots from a self-hosted ETC Core-Geth instance.
 * Node.js 22+, RPC MUST be localhost. No third-party API or API key.
 * Run: node apps/web/comparateur/tools/build-etc-snapshot.mjs
 * Only writes files within apps/web/comparateur/data/.
 */
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ETC_WINDOW,buildEtcObservation} from '../lib/etc-observer.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';
const endpoint='http://127.0.0.1:8545';
const output=fileURLToPath(new URL('../data/pow-reseaux.json',import.meta.url));
let index=0;
async function rpc(method,params=[]){
 const response=await fetch(endpoint,{method:'POST',
  headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),
  body:JSON.stringify({jsonrpc:'2.0',id:++index,method,params})});
 if(!response.ok)throw Error('Local ETC RPC HTTP '+response.status);
 const json=await response.json();
 if(json.error||json.result===undefined)throw Error('Invalid local ETC RPC '+method);
 return json.result;
}
const [chainId,syncing,tipHex]=await Promise.all([
 rpc('eth_chainId'),rpc('eth_syncing'),rpc('eth_blockNumber')]);
if(chainId!=='0x3d'||syncing!==false)throw Error('ETC mainnet synchronized node required');
const tip=Number(BigInt(tipHex));
if(!Number.isSafeInteger(tip)||tip<ETC_WINDOW+1)throw Error('ETC tip invalid');
const blocks=[];
for(let height=tip-ETC_WINDOW;height<=tip;height++){
 const block=await rpc('eth_getBlockByNumber',['0x'+height.toString(16),false]);
 if(!block)throw Error('Missing ETC block '+height);
 blocks.push(block);
}
const snapshot=buildEtcObservation({chainId,syncing,blocks});
let current;
try{current=JSON.parse(await readFile(output,'utf8'))}catch{current=null}
const others=current?.schemaVersion===1&&Array.isArray(current.networks)?
 current.networks.filter(x=>x.coin!=='ETC'&&validateOwnPoWSnapshot(x)): [];
const doc={schemaVersion:1,networks:[...others,snapshot]};
const temporary=output+'.tmp-'+process.pid;
try{
 await writeFile(temporary,JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});
 await rename(temporary,output);
}finally{await rm(temporary,{force:true})}
console.log('ETC mainnet observation',snapshot.blockHeight,'— 32 blocs — source: own-node (base reward only)');
