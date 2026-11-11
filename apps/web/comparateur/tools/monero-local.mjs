/** Read only from your own loopback Monero RPC. Never queries a third-party mining API.
 * Usage: node tools/monero-local.mjs --hashrate 10000 --watts 120 --electricity 0.20 [--xmr-eur 100]
 */
import {parseMoneroHeader,estimateMoneroYield} from '../lib/monero-direct.mjs';
const args=new Map();
for(let i=2;i<process.argv.length;i+=2){
  if(!/^--[a-z-]+$/.test(process.argv[i])||
    !process.argv[i+1]||process.argv[i+1].startsWith('--'))
    throw new Error('Expected --option number pairs');
  args.set(process.argv[i].slice(2),process.argv[i+1]);
}
const allowed=new Set(['hashrate','watts','electricity','pool-fee','quantity','hours','xmr-eur']);
for(const key of args.keys())if(!allowed.has(key))throw new Error('Unknown option '+key);
if(!args.has('hashrate'))throw new Error('--hashrate H/s is required (measured, not guessed)');
const get=(key,fallback)=>args.has(key)?Number(args.get(key)):fallback;
const response=await fetch('http://127.0.0.1:18081/json_rpc',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:'gpubnb-public-stats',method:'get_last_block_header'}),
  signal:AbortSignal.timeout(5000)
});
if(!response.ok)throw new Error('Local monerod returned HTTP '+response.status);
const network=parseMoneroHeader(await response.json());
const output=estimateMoneroYield({
  network,hashrateHps:get('hashrate',NaN),wattsPerDevice:get('watts',0),
  electricityEurKwh:get('electricity',0),poolFeePercent:get('pool-fee',0),
  quantity:get('quantity',1),hoursPerDay:get('hours',24),
  xmrEur:get('xmr-eur',null)
});
console.log(JSON.stringify({coin:'XMR',algorithm:'RandomX',fromOwnNode:network,
  methodology:'Expected blocks = hashrate * seconds / difficulty. Last block reward includes fees.',
  estimates:output},null,2));
