#!/usr/bin/env node
// Supplemental diagnostics only: Trivy is authoritative and remains blocking.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const advisories=[
{name:'borsh',version:'0.10.4',id:'GHSA-fjx5-qpf4-xjf2',root:'gpu_escrow'},
{name:'glib',version:'0.18.5',id:'GHSA-wrw7-89jp-8q8g',root:'gpubnb-host-desktop'},
{name:'rand',version:'0.7.3',id:'GHSA-cq8v-f236-94qc',root:'gpu_escrow'}
];
export function parseLock(text) {
 if(typeof text!=='string'||!text.includes('[[package]]'))throw Error('invalid Cargo.lock');
 const packages=text.split(/^\[\[package\]\]\s*$/m).slice(1).map(block=>{
  const n=block.match(/^name\s*=\s*"([^"]+)"\s*$/m),v=block.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if(!n||!v)throw Error('missing Cargo.lock package identity');
  const d=block.match(/^dependencies\s*=\s*\[([\s\S]*?)^\]\s*$/m);
  if(d&&d[1].split('\n').some(l=>l.trim()&&!/^"[^"]+",?$/.test(l.trim())))throw Error('unparseable dependency '+n[1]);
  return {name:n[1],version:v[1],key:n[1]+'@'+v[1],deps:d?[...d[1].matchAll(/^\s*"([^"]+)"\s*,?\s*$/gm)].map(x=>x[1]):[]};
 });
 const keys=new Set();
 for(const p of packages){if(keys.has(p.key))throw Error('duplicate package '+p.key);keys.add(p.key)}
 return packages;
}
export function inspect(packages) {
 const names=new Map(),keys=new Map();
 for(const p of packages){keys.set(p.key,p);names.set(p.name,[...(names.get(p.name)||[]),p])}
 function targets(dep){
  const [n,v]=dep.split(' '),list=v?[keys.get(n+'@'+v)].filter(Boolean):names.get(n)||[];
  if(list.length!==1)throw Error('ambiguous or unresolved dependency '+dep);
  return list;
 }
 return advisories.map(a=>{
  const target=keys.get(a.name+'@'+a.version),roots=names.get(a.root)||[],q=roots.map(p=>[p,[p.key]]),seen=new Set();
  if(!roots.length)throw Error('root missing '+a.root);
  let path=null;
  while(q.length){
   const [p,chain]=q.shift();if(seen.has(p.key))continue;seen.add(p.key);
   if(target&&p.key===target.key){path=chain;break}
   for(const dep of p.deps)for(const child of targets(dep))q.push([child,[...chain,child.key]]);
  }
  return {...a,present:!!target,path,status:target?'BLOCKED':'ABSENT_FROM_LOCK_ONLY'};
 });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
  const mode=process.argv[2]||'--report';if(!['--report','--check'].includes(mode))throw Error('unknown mode');
  const rows=inspect(parseLock(readFileSync(process.argv[3]||'Cargo.lock','utf8')));
  console.log(JSON.stringify({scannerIsAuthoritative:true,qualification:'NOT_TESTED',diagnostic:rows},null,2));
  if(mode==='--check'&&rows.some(x=>x.present))process.exitCode=1;
 }catch(e){console.error('fail-closed: '+e.message);process.exitCode=2}
}
