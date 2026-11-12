import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildDeployConfig} from '../tools/prepare-cloudflare-config.mjs';

const mockId='a'.repeat(32);
async function template(){
 return readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');
}
test('the repository template never pretends a real Cloudflare KV exists',async()=>{
 const original=JSON.parse(await template());
 assert.equal(original.name,'gpubnb-rentabilite-autonome');
 assert.deepEqual(original.triggers.crons,['17 * * * *']);
 assert.equal(original.kv_namespaces.length,1);
 assert.deepEqual(original.kv_namespaces[0],{binding:'SNAPSHOTS'});
});
test('preparation inserts the user-created KV ID without changing the site',async()=>{
 const original=await template();
 const prepared=buildDeployConfig(original,mockId);
 assert.equal(prepared.kv_namespaces[0].id,mockId);
 assert.equal(prepared.kv_namespaces[0].binding,'SNAPSHOTS');
 assert.equal(prepared.assets.directory,'.');
 assert.equal(prepared.main,'edge/worker.mjs');
 assert.equal(prepared.triggers.crons[0],'17 * * * *');
 assert.deepEqual(JSON.parse(original).kv_namespaces,[{binding:'SNAPSHOTS'}]);
});
test('fake, malformed, or suspicious identifiers are rejected',async()=>{
 const source=await template();
 for(const invalid of ['',null,'not-an-id','0x'+'b'.repeat(32),'g'.repeat(32),
  'a'.repeat(31),'a'.repeat(33),'"'+mockId+'"','../'+mockId]){
  assert.throws(()=>buildDeployConfig(source,invalid));
 }
});
test('wrong template, absent assets, or another cron is rejected',async()=>{
 const original=JSON.parse(await template());
 for(const changed of [
  {...original,name:'gpubnb-main'},
  {...original,main:'../other.js'},
  {...original,triggers:{crons:['* * * * *']}},
  {...original,assets:{directory:'../../'}},
  {...original,kv_namespaces:[{binding:'ADMIN'}]},
  {...original,kv_namespaces:[{binding:'SNAPSHOTS',id:mockId}]}
 ])assert.throws(()=>buildDeployConfig(changed,mockId));
});
test('public asset exclusions include account-generated deployment config',async()=>{
 const ignore=await readFile(new URL('../.assetsignore',import.meta.url),'utf8');
 const gitignore=await readFile(new URL('../.gitignore',import.meta.url),'utf8');
 assert.match(ignore,/wrangler\.deploy\.jsonc/);
 assert.match(gitignore,/wrangler\.deploy\.jsonc/);
 assert.match(ignore,/edge\//);
 assert.match(ignore,/tools\//);
 assert.match(ignore,/tests\//);
});
