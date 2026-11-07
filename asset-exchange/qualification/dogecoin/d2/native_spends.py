"""Bounded private DOGE Regtest experiment. No production route is enabled.

Requires verified D0 provenance, a fresh directory and a distinct loopback-only
network namespace BEFORE loading binaries, generating keys or signing.
"""
import argparse
import ctypes
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import time

from script_diagnostics import (ARCHIVE, SHA256, LIBRARY_SHA256, SOURCE_COMMIT,
    extract_verified_members, hash160, base58check, require, read_json,
    validate_handoff, validate_namespace, validate_network)
from offline_candidate import build_candidate
from test_signer import EphemeralSigner, transaction, sighash, hash256, push

AUTHORIZATION = 'AUTHORIZE_D2_PRIVATE_SIGNED_REGTEST'
MAX_BLOCKS = 1360
MAX_RPC = 180
METHODS = {'getblockchaininfo','getblockhash','getnetworkinfo','getpeerinfo',
           'generatetoaddress','getblock','getrawtransaction','gettxout',
           'sendrawtransaction','getmempoolentry','invalidateblock','reconsiderblock','stop'}
FLAGS = 1 | 4 | 512  # C ABI: P2SH, DERSIG, CLTV. Not all standard policy flags.
COIN = 100_000_000


def manifest():
    return {'schemaVersion':1, 'authorization':AUTHORIZATION, 'network':'regtest',
        'sourceCommit':SOURCE_COMMIT, 'archiveSha256':SHA256, 'librarySha256':LIBRARY_SHA256,
        'nodes':1, 'maxRpc':MAX_RPC, 'maxGeneratedBlocks':MAX_BLOCKS,
        'maxWallSeconds':600, 'maxCpuSeconds':420, 'maxAddressSpaceMiB':2048, 'maxDataMiB':512,
        'recovery':'verify exact persisted tip; rebuild local index from existing block files if required; never remine',
        'maxBroadcastFixtures':32, 'maxFixtureBytes':10000, 'rpcAllowlist':sorted(METHODS),
        'signer':'OpenSSL secp256k1 ECDSA; three fresh disposable keys; strict low-S DER; legacy SIGHASH_ALL',
        'walletEnabled':False, 'externalNetwork':False, 'acceptNonstandard':False,
        'promiscuousMempoolFlags':None, 'qualificationStatus':'BLOCKED',
        'blockingCriteria':['full frozen 24-case matrix not covered',
           'dynamic mempool pressure and soft-dust fee instrumentation absent',
           'independent review of native signed evidence still required',
           'multi-node deep reorg and all D3-D9 requirements not covered']}


def require_rejection(exit_code, stderr, reason):
    expected_code = -25 if reason == 'Missing inputs' else -26
    match = re.search(r'^error code: (-?[0-9]+)$', stderr, re.MULTILINE)
    require(exit_code != 0 and match is not None and int(match[1]) == expected_code
            and reason.lower() in stderr.lower(), 'expected rejection absent: '+reason)


def tip_matches(observation, height, block_hash):
    return (type(observation) is dict and observation.get('chain') == 'regtest'
            and type(observation.get('blocks')) is int and observation['blocks'] == height
            and observation.get('bestblockhash') == block_hash)


def persist_signed(path, raw):
    require(type(raw) is bytes and 0 < len(raw) <= 10000, 'bounded recovery bytes required')
    fd=os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw.hex().encode()+b'\n');stream.flush();os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)


def native_verifier(path):
    require(hashlib.sha256(path.read_bytes()).hexdigest()==LIBRARY_SHA256, 'library changed')
    lib=ctypes.CDLL(str(path),mode=ctypes.RTLD_LOCAL)
    lib.bitcoinconsensus_version.restype=ctypes.c_uint
    require(lib.bitcoinconsensus_version()==1,'wrong C ABI')
    fn=lib.bitcoinconsensus_verify_script
    fn.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_void_p,ctypes.c_uint,ctypes.c_uint,ctypes.c_uint,ctypes.POINTER(ctypes.c_int)]
    fn.restype=ctypes.c_int
    def verify(script,raw):
        error=ctypes.c_int(-1)
        result=fn(script,len(script),raw,len(raw),0,FLAGS,ctypes.byref(error))
        return {'result':result,'error':error.value,'flags':FLAGS}
    return verify


def run(args):
    require(args.authorization==AUTHORIZATION,'exact private test scope required')
    parent=args.parent_net_ns
    links=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
    validate_namespace(parent,os.readlink('/proc/self/ns/net'),links)
    evidence,verification,work=map(lambda x:Path(x).resolve(),[args.evidence,args.verification,args.work])
    sbom=read_json(evidence/'dogecoin-1.14.9-internal-reproduction.spdx.json')
    validate_handoff(read_json(verification/'provenance.json'),read_json(verification/'sbom.json'),sbom)
    require(not work.exists(),'fresh private work required')
    work.mkdir(mode=0o700)
    bins,data,out,keys=[work/x for x in ('bin','data','evidence','keys')]
    for directory in (bins,data,out,keys):directory.mkdir(mode=0o700)
    report={'experimentStatus':'FAIL','qualificationStatus':'BLOCKED','manifest':manifest(),
            'mainnetUsed':False,'realFundsUsed':False,'cases':[], 'namespaceBefore':links}
    trace=[]; signers=[]; process=None; log=None; generated=0; submitted=set();known_blocks=set();known_txs=set()
    def save():
        (out/'native-spends-report.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
        (out/'rpc-requests.json').write_text(json.dumps(trace,indent=2,sort_keys=True)+'\n')
    save()
    report['members']=extract_verified_members(evidence/ARCHIVE,sbom,bins)
    resource.setrlimit(resource.RLIMIT_CPU,(420,420));resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE,(512*1024**2,512*1024**2))
    def alarm(*_):raise TimeoutError('private qualification timeout')
    signal.signal(signal.SIGALRM,alarm);signal.signal(signal.SIGTERM,alarm);signal.alarm(600)
    config=data/'dogecoin.conf';config.write_text('regtest=1\ntestnet=0\n');config.chmod(0o600)
    common=[f'-datadir={data}',f'-conf={config}','-regtest=1','-testnet=0','-rpcport=18332']
    daemon=[str(bins/'dogecoind'),*common,'-server=1','-daemon=0','-listen=0','-connect=0','-dnsseed=0','-dns=0',
            '-discover=0','-upnp=0','-listenonion=0','-onion=0','-disablewallet=1','-debug=rpc','-txindex=1',
            '-rpcbind=127.0.0.1','-rpcallowip=127.0.0.1','-printtoconsole=1','-dbcache=64','-par=1',
            '-acceptnonstdtxn=0','-maxmempool=5']
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LANG':'C.UTF-8'}
    report['daemonArguments']=[x.replace(str(data),'PRIVATE_DATADIR') for x in daemon[1:]]
    mining_address=None
    def rpc(method,*params,reject=None):
        nonlocal generated
        require(method in METHODS and len(trace)<MAX_RPC,'RPC budget/allowlist violation')
        if method=='generatetoaddress':
            require(len(params)==4 and params[1]==mining_address and params[2:]==('1000000','0') and params[0] in ('1352','1'),'mining params')
            generated+=int(params[0]);require(generated<=MAX_BLOCKS,'block budget')
        elif method=='sendrawtransaction':require(len(params)==1 and params[0] in submitted,'unregistered fixture')
        elif method=='getblockhash':require(params in [('0',),('1',)],'height allowlist')
        elif method in ('getblock','invalidateblock','reconsiderblock'):require(len(params)==1 and params[0] in known_blocks,'unknown block')
        elif method in ('getrawtransaction','getmempoolentry'):require(params[0] in known_txs and (params[1:]==('1',) if method=='getrawtransaction' else len(params)==1),'unknown tx')
        elif method=='gettxout':require(len(params)==3 and params[0] in known_txs and params[1] in ('0','1','2','3','4') and params[2] in ('true','false'),'UTXO params')
        else:require(not params,'unexpected RPC params')
        row={'method':method,'params':params};trace.append(row);save()
        r=subprocess.run([str(bins/'dogecoin-cli'),*common,'-rpcconnect=127.0.0.1',method,*params],env=env,capture_output=True,text=True,timeout=180 if method=='generatetoaddress' else 15)
        require(len(r.stdout)<=2*1024**2 and len(r.stderr)<=8192,'RPC output bound')
        row.update(exitCode=r.returncode,stdout=r.stdout,stderr=r.stderr);save()
        if reject:
            require_rejection(r.returncode, r.stderr, reject)
            return {'exitCode':r.returncode,'reason':r.stderr}
        r.check_returncode()
        text=r.stdout.strip()
        if text=='':return None
        try:return json.loads(text,parse_float=Decimal)
        except json.JSONDecodeError:return text
    # Report JSON must keep coin amounts exact, never coerce through float.
    original_dumps=json.dumps
    def dumps(value,**kw):return original_dumps(value,default=lambda x:str(x) if isinstance(x,Decimal) else (_ for _ in ()).throw(TypeError()),**kw)
    # Use only the local serializer in save below; no global monkeypatch.
    def save():
        (out/'native-spends-report.json').write_text(dumps(report,indent=2,sort_keys=True)+'\n')
        (out/'rpc-requests.json').write_text(dumps(trace,indent=2,sort_keys=True)+'\n')
    def start(reindex=False):
        nonlocal process,log
        log=(out/'daemon-console.log').open('a')
        report.setdefault('processStarts',[]).append({'reindex':reindex})
        process=subprocess.Popen(daemon+(['-reindex=1'] if reindex else []),env=env,stdout=log,stderr=subprocess.STDOUT)
        deadline=time.monotonic()+45
        while True:
            require(process.poll() is None,'daemon exited')
            try:return rpc('getblockchaininfo')
            except subprocess.CalledProcessError:
                require(time.monotonic()<deadline,'readiness timeout');time.sleep(.25)
    def mine(count=1):
        hashes=rpc('generatetoaddress',str(count),mining_address,'1000000','0')
        require(type(hashes)is list and len(hashes)==count and all(re.fullmatch('[0-9a-f]{64}',x) for x in hashes),'invalid mined hashes')
        known_blocks.update(hashes)
        require(sum(p.stat().st_size for p in data.rglob('*') if p.is_file())<=512*1024**2,'disk budget')
        return hashes
    def submit(raw,reject=None):
        require(type(raw)is bytes and len(raw)<=10000 and len(submitted)<32,'fixture budget')
        submitted.add(raw.hex());tid=hash256(raw)[::-1].hex();known_txs.add(tid)
        result=rpc('sendrawtransaction',raw.hex(),reject=reject)
        if not reject:require(result==tid,'native txid mismatch')
        return result
    def record(name,raw,script,expected,admission=None):
        proof=verify(script,raw)
        row={'id':name,'transactionHex':raw.hex(),'txid':hash256(raw)[::-1].hex(),'scriptPubKeyHex':script.hex(),'nativeScript':proof,'expected':expected}
        report['cases'].append(row);save()
        require(proof=={'result':expected,'error':0,'flags':FLAGS},'native script mismatch: '+name)
        if admission:row['admission']=submit(raw,reject=admission);save()
        return row
    try:
        chain=start()
        identity={'blockchain':chain,'genesis':rpc('getblockhash','0'),'network':rpc('getnetworkinfo'),'peers':rpc('getpeerinfo')}
        validate_network(identity);report['initialIdentity']=identity
        verify=native_verifier(bins/'libdogecoinconsensus.so.0.0.0')
        for role in ('miner','claim','refund'):signers.append(EphemeralSigner(keys,role))
        miner,claim,refund=signers
        require(len({s.public for s in signers})==3,'distinct keys required')
        report['publicKeys']={k:s.public.hex() for k,s in zip(('miner','claim','refund'),signers)}
        report['opensslVersion']=subprocess.check_output(['/usr/bin/openssl','version'],text=True).strip()
        mining_address=base58check(b'\x6f'+hash160(miner.public))
        destination=b'\x76\xa9\x14'+hash160(miner.public)+b'\x88\xac'
        mine(1352)
        active=rpc('getblockchaininfo')
        require(active['blocks']==1352 and any(x.get('id')=='bip65' and x.get('reject',{}).get('status') is True for x in active['softforks']),'CLTV activation missing')
        report['activation']=active
        first=rpc('getblockhash','1');known_blocks.add(first)
        coinbase=rpc('getblock',first)['tx'][0];known_txs.add(coinbase)
        coin=rpc('getrawtransaction',coinbase,'1')
        matches=[v for v in coin['vout'] if v['scriptPubKey']['hex']==destination.hex()]
        require(len(matches)==1,'one expected coinbase output required')
        v=matches[0];value=int(Decimal(str(v['value']))*COIN)
        require(value>401*COIN and v['n']==0,'coinbase amount/index outside experiment')
        secret=hashlib.sha256(b'GPUbnb public disposable D2 preimage 2026-11-07').digest()
        htlc=build_candidate(hashlib.sha256(secret).digest(),claim.public,refund.public,1355)
        report['htlc']={'redeemHex':htlc.redeem.hex(),'outputHex':htlc.output.hex(),'lock':1355,'preimageHex':secret.hex()}
        outputs=[(100*COIN,htlc.output)]*4+[(value-400*COIN-COIN,destination)]
        sig=miner.sign(sighash(coinbase,0,destination,outputs))
        funding=transaction(coinbase,0,push(sig)+push(miner.public),outputs)
        record('funding_signature',funding,destination,1)
        funding_id=submit(funding);mine()
        report['fundingUtxo']=rpc('gettxout',funding_id,'0','true')
        require(report['fundingUtxo']['confirmations']==1,'funding confirmation missing')
        def spend(index=0,branch='claim',key=None,preimage=secret,lock=None,sequence=0xfffffffe,amount=99*COIN):
            lock=(0 if branch=='claim' else 1355) if lock is None else lock
            key=key or (claim if branch=='claim' else refund)
            outs=[(amount,destination)]
            sig=key.sign(sighash(funding_id,index,htlc.redeem,outs,lock,sequence))
            ss=push(sig)+(push(preimage)+b'\x51' if branch=='claim' else b'\0')+push(htlc.redeem)
            return transaction(funding_id,index,ss,outs,lock,sequence)
        valid=spend();refund_raw=spend(1,'refund')
        record('wrong_claim_key',spend(2,key=refund),htlc.output,0,'script-verify')
        record('wrong_refund_key',spend(2,'refund',key=claim),htlc.output,0)
        record('wrong_secret',spend(2,preimage=b'x'*32),htlc.output,0,'script-verify')
        record('short_secret',spend(2,preimage=b'x'*31),htlc.output,0,'script-verify')
        for name,offset in [('changed_signed_lock',-1),('wrong_outpoint',6)]:
            mutated=bytearray(valid);mutated[offset]^=1
            record(name,bytes(mutated),htlc.output,0)
        record('lock_domain_mismatch',spend(2,'refund',lock=500000000),htlc.output,0)
        record('final_sequence',spend(2,'refund',sequence=0xffffffff),htlc.output,0,'script-verify')
        record('early_refund',refund_raw,htlc.output,1,'non-final')
        record('hard_dust',spend(3,amount=1),htlc.output,1,'dust')
        # Replace the redeem push with nonminimal PUSHDATA2: C ABI permits it;
        # standard policy must reject it before a valid claim is accepted.
        sig=claim.sign(sighash(funding_id,2,htlc.redeem,[(99*COIN,destination)]))
        nonminimal=push(sig)+push(secret)+b'\x51\x4d'+len(htlc.redeem).to_bytes(2,'little')+htlc.redeem
        record('nonminimal_push',transaction(funding_id,2,nonminimal,[(99*COIN,destination)]),htlc.output,1,'script-verify')
        row=record('valid_claim',valid,htlc.output,1);claim_id=submit(valid)
        row['mempool']=rpc('getmempoolentry',claim_id);save()
        mine() # tip 1354: next candidate equals CLTV operand, still nonfinal.
        record('equal_candidate_height_nonfinal',refund_raw,htlc.output,1,'non-final')
        require(rpc('gettxout',funding_id,'0','true') is None,'claim input remains unspent')
        row['confirmed']=rpc('getrawtransaction',claim_id,'1');save()
        conflict=spend(0,amount=98*COIN)
        record('double_spend',conflict,htlc.output,1,'bad-txns-inputs-spent')
        expected_tip=mine()[0] # tip 1355: refund is now final for candidate 1356.
        # Signed public recovery bytes survive a real daemon SIGKILL. Private
        # signing material is destroyed before recovery/broadcast.
        recovery=out/'refund-signed.hex';persist_signed(recovery,refund_raw)
        for signer in signers:signer.destroy()
        process.kill();process.wait(timeout=15);log.close()
        report['crashExitCode']=process.returncode
        require(process.returncode==-signal.SIGKILL,'real kill not observed')
        restarted=start();report['firstRestart']=restarted;save()
        if not tip_matches(restarted,1355,expected_tip):
            # The failed earlier experiment proved that the block index can lag
            # the persisted blk file. Rebuild only this disposable local index.
            process.kill();process.wait(timeout=15);log.close()
            report['blocksBeforeReindex']=[{'name':p.name,'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted((data/'regtest'/'blocks').glob('blk*.dat'))]
            require(report['blocksBeforeReindex'],'no existing blocks to recover')
            restarted=start(reindex=True)
            deadline=time.monotonic()+45
            while not tip_matches(restarted,1355,expected_tip):
                require(time.monotonic()<deadline,'reindex did not restore exact prior tip')
                time.sleep(.5);restarted=rpc('getblockchaininfo')
            report['reindexedRestart']=restarted
        require(tip_matches(restarted,1355,expected_tip),'recovery tip mismatch')
        recovered_utxo=rpc('gettxout',funding_id,'1','true')
        require(recovered_utxo is not None and recovered_utxo['scriptPubKey']['hex']==htlc.output.hex()
                and Decimal(str(recovered_utxo['value']))==Decimal(100) and recovered_utxo['confirmations']==3,
                'refund UTXO mismatch after recovery')
        report['recoveredRefundUtxo']=recovered_utxo
        row=record('valid_refund_after_crash',bytes.fromhex(recovery.read_text().strip()),htlc.output,1)
        refund_id=submit(bytes.fromhex(recovery.read_text().strip()))
        row['mempool']=rpc('getmempoolentry',refund_id)
        refund_block=mine()[0]
        row['confirmed']=rpc('getrawtransaction',refund_id,'1')
        require(row['confirmed']['confirmations']==1,'refund not confirmed')
        require(rpc('gettxout',funding_id,'1','true') is None,'refund UTXO still unspent')
        rpc('invalidateblock',refund_block)
        report['refundReorg']={'transaction':rpc('getrawtransaction',refund_id,'1'),
                              'chainUtxo':rpc('gettxout',funding_id,'1','false'),
                              'mempool':rpc('getmempoolentry',refund_id)}
        require(report['refundReorg']['chainUtxo'] is not None,'reorg failed to restore chain UTXO')
        rpc('reconsiderblock',refund_block)
        report['refundRestored']=rpc('getrawtransaction',refund_id,'1')
        require(report['refundRestored']['confirmations']==1,'reconsider failed')
        network=rpc('getnetworkinfo');peers=rpc('getpeerinfo')
        require(network['connections']==0 and peers==[],'unexpected peers')
        report['finalNetwork']=network;report['finalPeers']=peers
        rpc('stop');process.wait(timeout=15);log.close()
        require(process.returncode==0,'unclean final exit')
        report['shutdownExitCode']=process.returncode
        report['namespaceAfter']=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
        validate_namespace(parent,os.readlink('/proc/self/ns/net'),report['namespaceAfter'])
        require(not list(data.rglob('wallet*')) and not list(keys.iterdir()),'wallet/key residue')
        methods=re.findall(r'ThreadRPCServer method=([a-zA-Z0-9_]+)',(out/'daemon-console.log').read_text())
        require(set(methods)<=METHODS and methods.count('sendrawtransaction')==sum(x['method']=='sendrawtransaction' for x in trace),'server method mismatch')
        report.update(experimentStatus='PASS',generatedBlocks=generated,serverMethods=methods,keysRemoved=True,
                      nativeStandardnessEvidence='source-pinned acceptnonstdtxn=0, no flag override; dust/nonminimal controls rejected; valid HTLC spends admitted')
    except BaseException as error:
        report['error']=type(error).__name__+': '+str(error)
        raise
    finally:
        signal.alarm(0)
        if process and process.poll() is None:
            process.kill();process.wait(timeout=15)
        if log and not log.closed:log.close()
        for signer in signers:signer.destroy()
        save()
        (out/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(out.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',action='store_true')
    for name in ('evidence','verification','work','authorization','parent-net-ns'):parser.add_argument('--'+name)
    args=parser.parse_args()
    if args.manifest:print(json.dumps(manifest(),indent=2,sort_keys=True))
    else:
        require(all(getattr(args,k.replace('-','_')) for k in ('evidence','verification','work','authorization','parent-net-ns')),'all execution arguments required')
        run(args)
