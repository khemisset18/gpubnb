/**
 * Generate public Monero network statistics from GPUbnb's OWN synchronized node.
 * Node.js >=22, no third-party API and no API key.
 * Run: node apps/web/comparateur/tools/build-monero-snapshot.mjs
 *
 * WARNING: This reads an RPC bound to loopback (127.0.0.1), not a public daemon.
 * Never expose monerod JSON-RPC to the public internet.
 */
import { writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeMoneroSnapshot, BLOCK_SAMPLE } from '../lib/monero-feed.mjs';
const endpoint = 'http://127.0.0.1:18081/json_rpc';
const output = fileURLToPath(new URL('../data/monero-reseau.json', import.meta.url));

async function rpc(method, params = undefined) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:'gpubnb-own-node', method, ...(params ? {params} : {}) }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Error('Local daemon HTTP ' + response.status);
  const json = await response.json();
  if (json.error || json.result?.status !== 'OK' || json.result?.untrusted !== false)
    throw Error('Monero RPC returned untrusted or invalid data');
  return json;
}

const [info, tip] = await Promise.all([rpc('get_info'), rpc('get_last_block_header')]);
const height = tip.result.block_header?.height;
if (!Number.isSafeInteger(height) || height < 1978433 + BLOCK_SAMPLE) throw Error('Unsupported tip');
const range = await rpc('get_block_headers_range', {start_height:height - BLOCK_SAMPLE + 1, end_height:height});
const snapshot = makeMoneroSnapshot(info, tip, range);
const temporary = output + '.tmp-' + process.pid;
try {
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', {flag:'wx', mode:0o600});
  await rename(temporary, output);
} finally {
  await rm(temporary, {force:true});
}
console.log('Snapshot XMR mainnet (30 blocs) mis à jour : bloc', snapshot.blockHeight, 'à', snapshot.collectedAt);
console.log('Fichier :', output);
