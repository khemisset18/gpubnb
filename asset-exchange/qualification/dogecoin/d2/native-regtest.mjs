#!/usr/bin/env node
/**
 * Real Dogecoin 1.14.9 native D2 first-slice executor.
 * Runs ONLY inside a pre-created loopback-only Linux network namespace with a
 * source/provenance-verified Dogecoin binary. Synthetic blocks, test-only keys.
 * No GPUbnb Core, public networks, user wallets, Mainnet or real funds.
 * This is NOT a full D2 qualifier: 24-case matrix and policy/relay evidence
 * remain independent acceptance requirements.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256, hash256, temporarySigner, p2pkhOutput, p2shRegtestAddress,
  miningRegtestAddress, signedCoinbaseFunding, signedP2shSpend, syntheticHtlcBundle } from './native-tx.mjs';

const EXPECTED_ARCHIVE = '4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8';
const EXPECTED_GENESIS = '3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5';
const D2_SCOPE = 'AUTHORIZE_DOGE_D2_SYNTHETIC_SIGNING_AND_PRIVATE_REGTEST_ONLY';
const MAX_MS = 14 * 60_000;
const MIN_CLTV_HEIGHT = 1351;
const KOINU = 100_000_000n;

export function checkedDecimalToKoinu(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000_000_000) throw new Error('invalid DOGE amount');
  const text = value.toFixed(8);
  if (!/^\d+\.\d{8}$/.test(text)) throw new Error('invalid fixed-point DOGE amount');
  const [whole, fraction] = text.split('.');
  return BigInt(whole) * KOINU + BigInt(fraction);
}
export function assertNativeIsolation(env = process.env) {
  if (process.platform !== 'linux' || env.AE_D2_NATIVE_SCOPE !== D2_SCOPE || env.AE_D0_VERIFIED_ARCHIVE_SHA256 !== EXPECTED_ARCHIVE) {
    throw new Error('native D2 requires exact-scope authorization and verified D0 archive');
  }
  if (!/^net:\[\d+\]$/.test(env.AE_PARENT_NET_NS || '')) throw new Error('parent network namespace identity required');
  if (fs.readlinkSync('/proc/self/ns/net') === env.AE_PARENT_NET_NS) throw new Error('native D2 cannot run in parent network namespace');
  const interfaces = fs.readdirSync('/sys/class/net').sort();
  if (interfaces.length !== 1 || interfaces[0] !== 'lo') throw new Error('private namespace must have loopback interface only');
  const route = fs.readFileSync('/proc/net/route','utf8').trim().split('\n').slice(1).filter(Boolean);
  if (route.length !== 0) throw new Error('native D2 refuses routable namespace');
}
async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((res, rej) => server.once('error', rej).listen(0, '127.0.0.1', res));
  const port = server.address().port;
  await new Promise((res, rej) => server.close(err => err ? rej(err) : res()));
  return port;
}
class RpcError extends Error {
  constructor(method, code, message) { super(`RPC ${method}: ${message}`); this.name='RpcError'; this.method=method; this.code=code; this.reason=String(message).slice(0,256); }
}
function cookieFrom(datadir) {
  const target = path.join(datadir,'regtest','.cookie');
  const value = fs.readFileSync(target,'utf8').trim();
  if (!value.startsWith('__cookie__:') || value.length > 256) throw new Error('invalid local RPC cookie');
  return Buffer.from(value).toString('base64');
}
async function rpc(method, params, { port, datadir, timeoutMs = method === 'generatetoaddress' ? 180_000 : 10_000 }) {
  const body = Buffer.from(JSON.stringify({jsonrpc:'1.0', id:'gpubnb-d2-native', method, params}));
  if (body.length > 8192) throw new Error('oversized local RPC request');
  const auth = cookieFrom(datadir);
  const data = await new Promise((resolve,reject) => {
    const req=http.request({hostname:'127.0.0.1',port,path:'/',method:'POST',timeout:timeoutMs,
      headers:{'Content-Type':'application/json','Content-Length':body.length,Authorization:`Basic ${auth}`}}, res=>{
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>4_000_000){req.destroy(new Error('oversized local RPC response'));return;}chunks.push(chunk);});
        res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
      });
    req.on('timeout',()=>req.destroy(new Error('local RPC deadline exceeded')));
    req.on('error',reject); req.end(body);
  });
  let result;
  try { result=JSON.parse(data); } catch { throw new Error(`invalid JSON from local RPC ${method}`); }
  if (result?.error) throw new RpcError(method,result.error.code,result.error.message);
  if (!result || !Object.hasOwn(result,'result')) throw new Error(`invalid RPC envelope for ${method}`);
  return result.result;
}
async function rpcReady(context,node) {
  for(let i=0;i<60;i++) {
    if(node.exitCode!==null)throw new Error(`dogecoind exited early (${node.exitCode})`);
    try {return await rpc('getblockchaininfo',[],context);} catch { await sleep(250); }
  }
  throw new Error('dogecoind did not initialize before timeout');
}
function requireAssert(condition,reason) { if(!condition)throw new Error(reason); }
function safeRpcFailure(error) {return {code:Number.isInteger(error.code)?error.code:null,message:String(error.reason||error.message).slice(0,200)};}
async function rejectAndRetainUtxo(context,name,tx,prevTxid,vout,report) {
  let rejected = null;
  try {await rpc('sendrawtransaction',[tx.hex],context);} catch(error){
    if(!(error instanceof RpcError))throw error;
    rejected=safeRpcFailure(error);
  }
  requireAssert(rejected!==null,`${name}: unexpectedly accepted by mempool`);
  const pool=await rpc('getrawmempool',[],context);
  requireAssert(!pool.includes(tx.txid),`${name}: rejected spend nevertheless appears in mempool`);
  const utxo=await rpc('gettxout',[prevTxid,vout,true],context);
  requireAssert(utxo!==null,`${name}: failed attempt destroyed available UTXO`);
  report.cases.push({name,expected:'REJECT',observed:'REJECT',error:rejected,txid:tx.txid});
}
async function acceptedAndConfirmed(context,name,tx,prevTxid,vout,miningAddress,report) {
  const actual=await rpc('sendrawtransaction',[tx.hex],context);
  requireAssert(actual===tx.txid,`${name}: native returned unexpected txid`);
  const pool=await rpc('getrawmempool',[],context);
  requireAssert(pool.includes(actual),`${name}: missing from mempool after acceptance`);
  const inPool=await rpc('gettxout',[prevTxid,vout,true],context);
  requireAssert(inPool===null,`${name}: mempool spent prevout should be unavailable`);
  const before=await rpc('getblockcount',[],context);
  const blocks=await rpc('generatetoaddress',[1,miningAddress],context);
  requireAssert(Array.isArray(blocks)&&blocks.length===1,`${name}: mining did not yield one block`);
  const after=await rpc('getblockcount',[],context);
  requireAssert(after===before+1,`${name}: inconsistent block height`);
  const confirmed=await rpc('getrawtransaction',[actual,1],context);
  requireAssert(confirmed.txid===actual && confirmed.confirmations>=1,`${name}: transaction not confirmed`);
  const spent=await rpc('gettxout',[prevTxid,vout,true],context);
  requireAssert(spent===null,`${name}: funding output remains unspent`);
  report.cases.push({name,expected:'ACCEPT_CONFIRMED',observed:'ACCEPT_CONFIRMED',txid:actual,
    fundingOutpoint:`${prevTxid}:${vout}`,blockHash:blocks[0],height:after,bytes:tx.bytes,feeKoinu:'10000000'});
}
async function run(context, report, node) {
  const info=await rpcReady(context,node);
  const netInfo=await rpc('getnetworkinfo',[],context);
  requireAssert(info.chain==='regtest' && netInfo.version===1140900,'DOGE 1.14.9 regtest identity required');
  const genesis=await rpc('getblockhash',[0],context);
  requireAssert(genesis===EXPECTED_GENESIS,'Dogecoin regtest genesis mismatch');
  requireAssert((await rpc('getpeerinfo',[],context)).length===0,'external Dogecoin peers prohibited');
  const miner=temporarySigner(), miningAddress=miningRegtestAddress(miner.compressed);
  const checked=await rpc('validateaddress',[miningAddress],context);
  requireAssert(checked.isvalid===true,'external mining address not recognized by native node');
  const blocks=await rpc('generatetoaddress',[1353,miningAddress],context);
  requireAssert(Array.isArray(blocks)&&blocks.length===1353,'initial isolated mining did not reach target');
  const height=await rpc('getblockcount',[],context);
  requireAssert(height>=MIN_CLTV_HEIGHT && height<=1500,'native CLTV height not active or work exceeded bound');
  const claim=syntheticHtlcBundle(height+4), refund=syntheticHtlcBundle(height+8);
  const cAddr=p2shRegtestAddress(claim.contract.redeem),rAddr=p2shRegtestAddress(refund.contract.redeem);
  for(const [asset,addr] of [[claim,cAddr],[refund,rAddr]]) {
    const decoded=await rpc('decodescript',[asset.contract.redeem.toString('hex')],context);
    requireAssert(decoded.p2sh===addr,'P2SH address mismatch against dogecoind');
  }
  const coinbaseBlock=await rpc('getblock',[blocks[0]],context);
  const cb=await rpc('getrawtransaction',[coinbaseBlock.tx[0],1],context);
  const miningScript=p2pkhOutput(miner.compressed).toString('hex');
  const eligible=cb.vout.find(v=>v.scriptPubKey?.hex===miningScript);
  requireAssert(eligible && Number.isSafeInteger(eligible.n),'mature coinbase funding output not found');
  const coinbaseKoinu=checkedDecimalToKoinu(eligible.value);
  const funding=signedCoinbaseFunding({prevTxid:cb.txid,vout:eligible.n,coinbaseKoinu,signer:miner,
    claimScript:claim.contract.output,refundScript:refund.contract.output});
  await acceptedAndConfirmed(context,'funding',funding,cb.txid,eligible.n,miningAddress,report);
  for(const vout of [0,1]) {
    const utxo=await rpc('gettxout',[funding.txid,vout,true],context);
    requireAssert(utxo && checkedDecimalToKoinu(utxo.value)===500_000_000n,`contract ${vout}: funding UTXO mismatch`);
  }
  report.environment={chain:'regtest',genesis,nodeVersion:netInfo.version,initialCLTVHeight:height,
    parentNetNamespace:process.env.AE_PARENT_NET_NS,selfNetNamespace:fs.readlinkSync('/proc/self/ns/net'),
    peers:0,walletEnabled:false,acceptNonstandard:false,testOnly:true};
  const claimParams={prevTxid:funding.txid,vout:0,inputKoinu:500_000_000n,feeKoinu:10_000_000n,
    destinationScript:p2pkhOutput(claim.claim.compressed),redeem:claim.contract.redeem,branch:'CLAIM',lockHeight:claim.contract.lockHeight};
  await rejectAndRetainUtxo(context,'wrong_claim_secret',signedP2shSpend({...claimParams,signer:claim.claim,preimage:Buffer.alloc(32)}),funding.txid,0,report);
  await rejectAndRetainUtxo(context,'wrong_claim_key',signedP2shSpend({...claimParams,signer:claim.refund,preimage:claim.secret}),funding.txid,0,report);
  await acceptedAndConfirmed(context,'valid_claim',signedP2shSpend({...claimParams,signer:claim.claim,preimage:claim.secret}),funding.txid,0,miningAddress,report);
  const refundTx=signedP2shSpend({prevTxid:funding.txid,vout:1,inputKoinu:500_000_000n,feeKoinu:10_000_000n,
    destinationScript:p2pkhOutput(refund.refund.compressed),redeem:refund.contract.redeem,signer:refund.refund,
    branch:'REFUND',lockHeight:refund.contract.lockHeight});
  await rejectAndRetainUtxo(context,'refund_before_locktime',refundTx,funding.txid,1,report);
  const current=await rpc('getblockcount',[],context);
  const needed=refund.contract.lockHeight-current;
  requireAssert(needed>=1&&needed<=12,'refund waiting height outside bounded plan');
  const waited=await rpc('generatetoaddress',[needed,miningAddress],context);
  requireAssert(waited.length===needed,'refund prerequisite mining incomplete');
  await acceptedAndConfirmed(context,'valid_refund_after_lock',refundTx,funding.txid,1,miningAddress,report);
  requireAssert((await rpc('getpeerinfo',[],context)).length===0,'peer appeared during native run');
  report.firstSlice='PASS'; report.status='BLOCKED';
  report.unproven=['20 remaining native scenario claims','full IsStandardTx/AreInputsStandard with independently checked policy flags',
    'P2P relay distinction','reorg, crash/recovery and independently verified provenance'];
}
async function main() {
  assertNativeIsolation();
  const args=process.argv.slice(2);
  if(args.length!==3 || args[0]!==D2_SCOPE || !path.isAbsolute(args[1]) || !path.isAbsolute(args[2]))
    throw new Error('usage: native-regtest.mjs AUTHORIZE_DOGE_D2_SYNTHETIC_SIGNING_AND_PRIVATE_REGTEST_ONLY <absolute verified dogecoind> <absolute report.json>');
  const binary=args[1], output=args[2];
  if(!fs.statSync(binary).isFile())throw new Error('verified Dogecoin ELF binary required');
  const stat=fs.statSync(binary);if(stat.size<1_000_000||stat.size>150_000_000)throw new Error('unexpected Dogecoin executable size');
  const binaryHash=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const datadir=fs.mkdtempSync(path.join(os.tmpdir(),'gpubnb-d2-verified-private-regtest-'));
  fs.chmodSync(datadir,0o700);
  const port=await unusedLoopbackPort();
  const log=fs.openSync(path.join(datadir,'node.stdout.log'),'w',0o600);
  const options={port,datadir};
  const report={schemaVersion:1,producer:'NATIVE_DOGECOIN_1_14_9_FIRST_SLICE',qualificationStatus:'BLOCKED',
    firstSlice:'NOT_TESTED',binarySha256:binaryHash,verifiedArchiveSha256:EXPECTED_ARCHIVE,cases:[]};
  const node=spawn(binary,['-regtest',`-datadir=${datadir}`,'-server=1','-listen=0','-dnsseed=0',
    '-discover=0','-upnp=0','-disablewallet=1','-txindex=1','-acceptnonstdtxn=0',
    '-debug=mempool',`-rpcport=${port}`,'-rpcbind=127.0.0.1','-rpcallowip=127.0.0.1'],
    {stdio:['ignore',log,log],env:{PATH:process.env.PATH||'/usr/bin:/bin'},cwd:datadir});
  fs.closeSync(log);
  try {
    await Promise.race([run(options,report,node),sleep(MAX_MS).then(()=>{throw new Error('native run wall-time limit exceeded');})]);
  } catch(error) {
    report.firstSlice='FAIL';report.error={name:error.name,message:String(error.message).slice(0,220)};
  } finally {
    try {await rpc('stop',[],options);} catch {node.kill('SIGTERM');}
    await Promise.race([new Promise(resolve=>{if(node.exitCode!==null)return resolve();node.once('exit',resolve);}),sleep(5_000)]);
    if(node.exitCode===null)node.kill('SIGKILL');
    const debugPath=path.join(datadir,'regtest','debug.log');
    if(fs.existsSync(debugPath)){
      const raw=fs.readFileSync(debugPath);
      report.nativeDebugSha256=sha256(raw).toString('hex');
      report.nativeDebugBytes=raw.length;
      // Capture only bounded, public verification lines; no RPC cookie or keys.
      report.debugPolicyLines=raw.toString('utf8').split('\n').filter(line=>/AcceptToMemoryPool|nonstandard|non-standard|script-verify|non-final|bad-txns/.test(line)).slice(-80).map(line=>line.slice(0,240));
    }
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    // Only delete this one newly created private test directory.
    fs.rmSync(datadir,{recursive:true,force:false,maxRetries:3,retryDelay:100});
  }
  if(report.firstSlice!=='PASS')process.exitCode=1;
  console.log(JSON.stringify({firstSlice:report.firstSlice,qualificationStatus:'BLOCKED',caseCount:report.cases.length,report:output}));
}
if(process.argv[1] && import.meta.url===new URL(`file://${path.resolve(process.argv[1])}`).href){
  main().catch(error=>{console.error(`DOGE D2 fail-closed: ${String(error.message).slice(0,180)}`);process.exitCode=2;});
}
