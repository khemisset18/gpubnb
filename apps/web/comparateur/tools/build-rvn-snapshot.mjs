/* Publish a local Ravencoin mining observation to the standalone comparateur ONLY.
 * Requires a synchronized ravend mainnet JSON-RPC on 127.0.0.1:8766.
 * Set RVN_RPC_USER and RVN_RPC_PASSWORD in your private shell.
 * No third-party API. No credentials included in data or source files.
 */
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildRvnObservation,RVN_WINDOW} from '../lib/rvn-observer.mjs';
import {validateOwnPoWSnapshot} from '../lib/pow-yield.mjs';
const user=process.env.RVN_RPC_USER,password=process.env.RVN_RPC_PASSWORD;
if(!user||!password)throw Error('Local Ravencoin RPC credentials required in environment');
const auth='Basic '+Buffer.from(user+':'+password).toString('base64');
let id=0;
async function rpc(method,params=[]){
 const response=await fetch('http://127.0.0.1:8766/',{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},
  signal:AbortSignal.timeout(8000),body:JSON.stringify({jsonrpc:'1.0',id:++id,method,params})
 });
 if(!response.ok)throw Error('Local Ravencoin RPC HTTP '+response.status);
 const json=await response.json();
 if(json.error||json.result===undefined)throw Error('Invalid local Ravencoin RPC response '+method);
 return json.result;
}
const info=await rpc('getblockchaininfo');
if(info.chain!=='main'||info.initialblockdownload!==false)throw Error('Own synced mainnet required');
const speed=await rpc('getnetworkhashps',[120]);
const blocks=[];
for(let height=info.blocks-RVN_WINDOW;height<=info.blocks;height++){
 const hash=await rpc('getblockhash',[height]);
 blocks.push(await rpc('getblock',[hash,2]));
}
const snapshot=buildRvnObservation({info,networkHashps:speed,blocks});
const output=fileURLToPath(new URL('../data/pow-reseaux.json',import.meta.url));
let previous;
try{previous=JSON.parse(await readFile(output,'utf8'))}catch{previous=null}
const others=previous?.schemaVersion===1&&Array.isArray(previous.networks)?
 previous.networks.filter(x=>x.coin!=='RVN'&&validateOwnPoWSnapshot(x)): [];
const doc={schemaVersion:1,networks:[...others,snapshot]};
const temporary=output+'.tmp-'+process.pid;
try{await writeFile(temporary,JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});
 await rename(temporary,output);
}finally{await rm(temporary,{force:true})}
console.log('RVN mainnet own-node observation:',snapshot.blockHeight,'— 32 blocks; no third-party API');
