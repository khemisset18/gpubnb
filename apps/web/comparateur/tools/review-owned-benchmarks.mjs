/**
 * Operator-only offline publisher for GPUbnb's OWN lab measurements.
 * Never contacts the internet or GPUbnb Host. Never starts mining.
 * Usage: node apps/web/comparateur/tools/review-owned-benchmarks.mjs path/to/private-lab-measurements.json
 *
 * Input contains explicitly approved operator measurements; don't supply anonymous uploads.
 * Output contains only public whitelisted data and no IDs, wallets, IPs or secrets.
 */
import {readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {validateOwnedBenchmarkDataset} from '../lib/owned-benchmarks.mjs';

const supplied=process.argv[2];
if(process.argv.length!==3||!supplied||/^(?:https?:|file:)/i.test(supplied)){
  throw Error('Expected exactly one local lab JSON filename (no URLs)');
}
const input=resolve(supplied);
const output=fileURLToPath(new URL('../data/owned-benchmarks.json',import.meta.url));
if(input===output)throw Error('Input must not be the public output');
const inputStats=await stat(input);
if(!inputStats.isFile()||inputStats.size>128*1024){
  throw Error('Local input must be a regular JSON file under 128 KiB');
}
const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
const deviceIds=new Set([...source.matchAll(/\['(?:gpu|cpu)','([a-z0-9-]+)'/g)].map(m=>m[1]));
if(deviceIds.size<20)throw Error('Unable to validate hardware IDs from comparator catalog');
const parsed=JSON.parse(await readFile(input,'utf8'));
const clean=validateOwnedBenchmarkDataset(parsed,deviceIds);
if(!clean||clean.samples.length===0)throw Error('No valid, reviewed, consented lab measurements; refusing publication');
const temporary=output+'.tmp-'+process.pid;
try{
 await writeFile(temporary,JSON.stringify(clean,null,2)+'\n',{flag:'wx',mode:0o600});
 await rename(temporary,output);
}finally{await rm(temporary,{force:true})}
console.log('Published '+clean.samples.length+' GPUbnb-owned measurements, without private fields.');
console.log('No miner started, no API called and no other GPUbnb module changed.');
