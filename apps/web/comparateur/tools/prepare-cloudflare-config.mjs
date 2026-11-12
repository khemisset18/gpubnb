/**
 * Prepare Cloudflare's deployment config WITHOUT deploying, logging in, or
 * mutating the GPUbnb site. This lives only in apps/web/comparateur.
 *
 * Cloudflare KV binding IDs are account-generated. Do not invent an ID.
 *
 * Usage after creating a KV namespace in YOUR Cloudflare account:
 *   node tools/prepare-cloudflare-config.mjs <real-32-hex-KV-namespace-id>
 *
 * Then, only after owner approval:
 *   npx wrangler deploy --config wrangler.deploy.jsonc
 */
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const templateUrl=new URL('../wrangler.jsonc',import.meta.url);
const outputUrl=new URL('../wrangler.deploy.jsonc',import.meta.url);

export function buildDeployConfig(template,namespaceId){
  if(typeof namespaceId!=='string'||!/^[0-9a-f]{32}$/.test(namespaceId)){
    throw Error('Expected a real 32-character hex Cloudflare KV namespace ID');
  }
  const config=typeof template==='string'?JSON.parse(template):template;
  if(!config||typeof config!=='object'||config.main!=='edge/worker.mjs'||
      config.name!=='gpubnb-rentabilite-autonome'||
      config.assets?.directory!=='.'||config.assets?.binding!=='ASSETS'||
      JSON.stringify(config.triggers?.crons)!=='["17 * * * *"]'||
      !Array.isArray(config.kv_namespaces)||
      config.kv_namespaces.length!==1||
      config.kv_namespaces[0]?.binding!=='SNAPSHOTS'){
    throw Error('Unexpected comparator-only Cloudflare template');
  }
  if(config.kv_namespaces[0].id){
    throw Error('Template must not embed a live KV namespace ID');
  }
  return {...config,kv_namespaces:[{binding:'SNAPSHOTS',id:namespaceId}]};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw Error('Usage: node tools/prepare-cloudflare-config.mjs <KV-namespace-ID>');
  const source=await readFile(templateUrl,'utf8');
  const deployConfig=buildDeployConfig(source,process.argv[2]);
  // Refuse overwriting a previously prepared account config.
  await writeFile(outputUrl,JSON.stringify(deployConfig,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Prepared a local, git-ignored Cloudflare deploy config. No deployment performed.');
}
