"""Bounded two-node private DOGE lab. Importing this module executes no node.

Reuses D0 verification, the D1 namespace guard and the existing test signer/codec.
This experiment cannot promote D6 or enable financial settlement.
"""
import argparse
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'd2'))
from script_diagnostics import (ARCHIVE, SHA256, LIBRARY_SHA256, SOURCE_COMMIT,
    extract_verified_members, hash160, base58check, require, read_json,
    validate_handoff, validate_namespace, validate_network)
from native_spends import native_verifier, prepare_recovery, read_signed, require_rejection
from offline_candidate import build_candidate
from test_signer import EphemeralSigner, transaction, sighash, hash256, push
from auxpow_fixtures import vectors as auxpow_vectors, MAX_PROOFS

AUTHORIZATION = 'AUTHORIZE_D6_PRIVATE_MULTINODE_REGTEST'
COIN = 100_000_000
RECOVERY_VALUE = COIN
RECOVERY_FEES = (100_000, 1_000_000)
NODES = ('a', 'b')
P2P_PORTS = {'a':18444, 'b':18445}
RPC_PORTS = {'a':18332, 'b':18333}
MAX_BLOCKS, MAX_RPC, MAX_FIXTURES = 1370, 480, 8
FEE_MAX_FIXTURES, FEE_MAX_BYTES = 96, 60000
VM_SUITES=('recovery-handoff','recovery-independent','recovery-resume')
LAB_SUITES=('multinode','fee-pinning',*VM_SUITES)
METHODS = frozenset({'getblockchaininfo','getblockhash','getnetworkinfo','getpeerinfo',
    'generatetoaddress','getblock','getrawtransaction','gettxout','sendrawtransaction',
    'getmempoolentry','getrawmempool','getblockheader','getmempoolinfo','addnode','setnetworkactive','invalidateblock','reconsiderblock','stop',
    'createauxblock','submitauxblock'})


def manifest(lab_suite='multinode'):
    require(lab_suite in LAB_SUITES,'fixed laboratory suite required')
    result={'schemaVersion':1,'authorization':AUTHORIZATION,'network':'regtest','labSuite':lab_suite,
        'sourceCommit':SOURCE_COMMIT,'archiveSha256':SHA256,'librarySha256':LIBRARY_SHA256,
        'nodes':2,'peerEndpoints':[f'127.0.0.1:{P2P_PORTS[x]}' for x in NODES],
        'rpcEndpoints':[f'127.0.0.1:{RPC_PORTS[x]}' for x in NODES],
        'rpcAllowlist':sorted(METHODS),'maxRpc':MAX_RPC,'maxGeneratedBlocks':MAX_BLOCKS,
        'maxBroadcastFixtures':MAX_FIXTURES,'maxFixtureBytes':10000,'maxWallSeconds':900,
        'maxCpuSecondsPerProcess':600,'maxAddressSpaceMiBPerProcess':2048,'maxDataMiB':1024,
        'maxForkDepth':5,'maxObservedRollbackDepth':3,'keys':'four ephemeral OpenSSL keys; removed before partition',
        'initialAuxpow':False,'postActivationForkAuxpow':True,
        'maxAuxpowFixtures':MAX_PROOFS,'maxAuxpowParentAttemptsPerFixture':256,
        'walletEnabled':False,'externalNetwork':False,'acceptNonstandard':False,
        'promiscuousMempoolFlags':None,'settlementAllowed':False,'qualificationStatus':'BLOCKED',
        'notCovered':['independent external review','complete AuxPoW adversarial matrix beyond eight fixed fixtures',
            'production watcher deployment','all D0-D9 requirements']}
    if lab_suite in ('fee-pinning',*VM_SUITES):
        result.update(maxBroadcastFixtures=FEE_MAX_FIXTURES,maxFixtureBytes=FEE_MAX_BYTES,
            rpcAllowlist=sorted(METHODS|{'setmocktime'}),maxRpc=800,maxPressureTransactions=80,
            maxPressureOutputsPerTransaction=1601,maxMockTimeAdvanceSeconds=21600,
            replacementPolicy={'a':'upstream default enabled, explicit opt-in required','b':'explicitly disabled'},
            repeatsPreviouslyQualifiedSuite=False)
        if lab_suite in VM_SUITES:
            result.update(rpcAllowlist=sorted(METHODS),maxRpc=1800 if lab_suite=='recovery-handoff' else 800,
                maxGeneratedBlocks=1370 if lab_suite=='recovery-handoff' else 16,
                importedPublicBlocksMaximum=1362,physicalMachineIndependence='NOT_TESTED',
                signingAllowed=lab_suite=='recovery-handoff',maxObservedRollbackDepth=4,
                maxMockTimeAdvanceSeconds=0,keys='producer: ephemeral keys removed before funding; consumer: no signing keys')
    return result


def validate_rpc(node, method, params, *, addresses, blocks, txids, submitted, aux_submitted=frozenset(),
                 lab_suite='multinode',mocktimes=frozenset()):
    require(lab_suite in LAB_SUITES,'fixed laboratory suite required')
    methods=METHODS|({'setmocktime'} if lab_suite=='fee-pinning' else set())
    require(node in NODES and method in methods, 'fixed node/method required')
    require(type(params) in (tuple,list) and all(type(p) is str for p in params), 'string RPC parameters required')
    params=tuple(params)
    if method=='generatetoaddress':
        require(len(params)==4 and params[0] in ('1352','1','2','4')
                and params[1]==addresses[node] and params[2]=='1000000'
                and params[3]==('0' if params[0]=='1352' else '1'), 'bounded mining parameters required')
        require(lab_suite not in ('recovery-independent','recovery-resume') or params[0]!='1352',
                'consumer may replay public blocks but cannot remine initial chain')
    elif method=='addnode':
        other='b' if node=='a' else 'a'
        require(params==(f'127.0.0.1:{P2P_PORTS[other]}','onetry'), 'only fixed private peer allowed')
    elif method=='setnetworkactive':require(params in [('true',),('false',)], 'explicit network state required')
    elif method=='setmocktime':require(len(params)==1 and params[0] in mocktimes,'registered private mock clock required')
    elif method=='getblockhash':require(len(params)==1 and re.fullmatch(r'0|[1-9][0-9]{0,3}',params[0]) is not None
                and int(params[0])<=MAX_BLOCKS,'bounded active-chain height required')
    elif method=='getblock':require((len(params)==1 or (lab_suite in VM_SUITES and len(params)==2 and params[1]=='false'))
                and params[0] in blocks,'registered block and permitted encoding required')
    elif method in ('invalidateblock','reconsiderblock'):require(len(params)==1 and params[0] in blocks, 'registered block required')
    elif method=='getblockheader':require(len(params) in (1,2) and params[0] in blocks
                and params[1:] in ((),('true',)),'registered verbose block header required')
    elif method=='getrawtransaction':require(len(params)==2 and params[0] in txids and params[1]=='1','registered verbose transaction required')
    elif method=='getmempoolentry':require(len(params)==1 and params[0] in txids,'registered mempool transaction required')
    elif method=='gettxout':require(len(params)==3 and params[0] in txids and params[1] in ('0','1','2','3')
                and params[2] in ('true','false'),'registered funding output required')
    elif method=='sendrawtransaction':require(len(params)==1 and params[0] in submitted,'registered signed fixture required')
    elif method=='createauxblock':require(node=='a' and params==(addresses[node],),'fixed private template destination required')
    elif method=='submitauxblock':require(node=='a' and len(params)==2 and params[0] in blocks
                and type(aux_submitted) in (set,frozenset) and len(aux_submitted)<=MAX_PROOFS
                and params in aux_submitted and 0<len(params[1])<=8192
                and len(params[1])%2==0 and re.fullmatch('[0-9a-f]+',params[1]),
                'registered private AuxPoW fixture required')
    else:require(not params,'unexpected RPC parameters')


def test_key_specs(directory):
    directory=Path(directory)
    return [(directory,'miner'),(directory/'node-b','miner'),(directory,'claim'),(directory,'refund')]


def check_peers(peers):
    require(type(peers) is list and len(peers)<=1,'at most one laboratory peer required')
    for peer in peers:
        # An inbound peer has a random source port; every address must still be loopback.
        require(type(peer) is dict and re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}',peer.get('addr','')),
                'non-loopback peer rejected')
        require(1<=int(peer['addr'].rsplit(':',1)[1])<=65535,'valid private TCP port required')
    return peers


def rpc_reached_server(exit_code,stderr):
    return exit_code==0 or re.search(r'^error code: -?[0-9]+$',stderr,re.MULTILINE) is not None


def normalize_observation(source, chain, observed, mempool, competing=None):
    """Keep missing data unknown; a spent output alone is not proof of conflict."""
    require(source in NODES and chain.get('chain')=='regtest','fixed private source required')
    require(type(chain.get('blocks')) is int and chain['blocks']>=0
            and re.fullmatch('[0-9a-f]{64}',chain.get('bestblockhash','')),'coherent native tip required')
    require(observed is None or type(observed) is dict,'explicit transaction lookup required')
    require(type(mempool) is bool,'explicit mempool lookup required')
    if observed:require(re.fullmatch('[0-9a-f]{64}',observed.get('txid','')),'native transaction identity required')
    confirmations=observed.get('confirmations',0) if observed else 0
    require(type(confirmations) is int and 0<=confirmations<=chain['blocks']+1,'coherent native confirmations required')
    block_hash=observed.get('blockhash') if confirmations else None
    if confirmations:
        require(re.fullmatch('[0-9a-f]{64}',block_hash or ''),'confirmed block identity required')
    return {'chainId':'dogecoin','networkId':'regtest','sourceId':'doge-'+source,
        'tipHash':chain['bestblockhash'],'tipHeight':chain['blocks'],
        'observedTxid':observed['txid'] if observed else None,'blockHash':block_hash,
        'blockHeight':chain['blocks']-confirmations+1 if confirmations else None,
        'transactionFound':observed is not None,'confirmations':confirmations,'mempoolStatus':'PRESENT' if mempool else 'ABSENT',
        'conflictStatus':'CONFLICTED' if competing else 'NONE',
        'observedAtUnixMs':int(time.time()*1000)}


def persist_bundle(path, bundle):
    raw=(json.dumps(bundle,indent=2,sort_keys=True)+'\n').encode()
    require(len(raw)<=65536,'bounded public bundle required')
    fd=os.open(path,os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb',closefd=False) as stream:
            stream.write(raw);stream.flush();os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(Path(path).parent,os.O_RDONLY | os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)
    require(Path(path).read_bytes()==raw,'pre-lock public bundle readback mismatch')
    return hashlib.sha256(raw).hexdigest()


def run(args, recovery_runner=None, bundle_validator=None):
    require(args.authorization==AUTHORIZATION,'exact multi-node scope required')
    lab_suite=getattr(args,'lab_suite','multinode')
    limits=manifest(lab_suite)
    rpc_limit=limits['maxRpc']
    parent=args.parent_net_ns
    links=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
    validate_namespace(parent,os.readlink('/proc/self/ns/net'),links)
    evidence,verification,work=map(lambda x:Path(x).resolve(),[args.evidence,args.verification,args.work])
    sbom=read_json(evidence/'dogecoin-1.14.9-internal-reproduction.spdx.json')
    validate_handoff(read_json(verification/'provenance.json'),read_json(verification/'sbom.json'),sbom)
    require(not work.exists(),'fresh private lab directory required')
    work.mkdir(mode=0o700)
    bins,out,keys=[work/x for x in ('bin','evidence','keys')]
    for path in (bins,out,keys):path.mkdir(mode=0o700)
    report={'experimentStatus':'FAIL','qualificationStatus':'BLOCKED','settlementAllowed':False,
        'manifest':limits,'mainnetUsed':False,'realFundsUsed':False,'namespaceBefore':links,'stages':[]}
    trace=[];signers=[];key_specs=[];processes={};logs={};common={};addresses={};blocks=set();txids=set();submitted=set();aux_submitted=set();external_calls=[];generated=0;mocktimes=set()
    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
    def dump(value):return json.dumps(value,indent=2,sort_keys=True,default=lambda x:str(x) if isinstance(x,Decimal) else (_ for _ in ()).throw(TypeError()))+'\n'
    def save():
        (out/'multinode-report.json').write_text(dump(report));(out/'rpc-requests.json').write_text(dump(trace))
    save();report['members']=extract_verified_members(evidence/ARCHIVE,sbom,bins)
    handoff_root=getattr(args,'handoff_directory',None);handoff_manifest=None
    if lab_suite in VM_SUITES:
        require(re.fullmatch('[0-9a-f]{40}',getattr(args,'execution_commit','') or '') is not None,
                'exact VM experiment execution commit required')
    if lab_suite in ('recovery-independent','recovery-resume'):
        from vm_recovery import load_parcel
        require(handoff_root is not None,'independently retained handoff required')
        handoff_manifest=load_parcel(handoff_root,getattr(args,'handoff_sha256',None))
        require(handoff_manifest['executionCommit']==args.execution_commit,'VM handoff source differs from dispatched execution')
        require(set(handoff_manifest['addresses'])==set(NODES)
                and all(re.fullmatch('[mn][1-9A-HJ-NP-Za-km-z]{25,34}',v) for v in handoff_manifest['addresses'].values()),
                'fixed public Regtest mining destinations required')
        addresses.update(handoff_manifest['addresses'])
    resource.setrlimit(resource.RLIMIT_CPU,(600,600));resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE,(512*1024**2,512*1024**2))
    def alarm(*_):raise TimeoutError('private multi-node wall-time budget')
    signal.signal(signal.SIGALRM,alarm);signal.signal(signal.SIGTERM,alarm);signal.alarm(900)
    def rpc(node,method,*params,reject=None,missing_ok=False):
        nonlocal generated
        validate_rpc(node,method,params,addresses=addresses,blocks=blocks,txids=txids,submitted=submitted,
            aux_submitted=aux_submitted,lab_suite=lab_suite,mocktimes=mocktimes)
        require(len(trace)+len(external_calls)<rpc_limit,'RPC budget exceeded')
        if method=='generatetoaddress':generated+=int(params[0]);require(generated<=limits['maxGeneratedBlocks'],'block budget exceeded')
        if method=='submitauxblock':require(generated<MAX_BLOCKS,'AuxPoW block budget exceeded')
        row={'source':node,'method':method,'params':list(params)};trace.append(row);save()
        result=subprocess.run([str(bins/'dogecoin-cli'),*common[node],'-rpcconnect=127.0.0.1',method,*params],
            env=env,capture_output=True,text=True,timeout=180 if method=='generatetoaddress' else 15)
        require(len(result.stdout)<=2*1024**2 and len(result.stderr)<=8192,'RPC output bound')
        row.update(exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr,
                   reachedServer=rpc_reached_server(result.returncode,result.stderr));save()
        if reject:require_rejection(result.returncode,result.stderr,reject);return {'exitCode':result.returncode,'reason':result.stderr}
        if missing_ok and result.returncode:
            require(re.search(r'^error code: -5$',result.stderr,re.MULTILINE) is not None,'only native unknown-tx error may be absent')
            return None
        result.check_returncode();value=result.stdout.strip()
        if not value:return None
        try:return json.loads(value,parse_float=Decimal)
        except json.JSONDecodeError:return value
    def start(node,import_file=None):
        data=work/('data-'+node)
        if node not in common:
            data.mkdir(mode=0o700);config=data/'dogecoin.conf';config.write_text('regtest=1\ntestnet=0\n');config.chmod(0o600)
            common[node]=[f'-datadir={data}',f'-conf={config}','-regtest=1','-testnet=0',f'-rpcport={RPC_PORTS[node]}']
        log=(out/('daemon-'+node+'.log')).open('a');logs[node]=log
        daemon=[str(bins/'dogecoind'),*common[node],'-server=1','-daemon=0','-listen=1','-connect=0',
            f'-port={P2P_PORTS[node]}','-bind=127.0.0.1','-onlynet=ipv4','-dnsseed=0','-dns=0','-discover=0','-upnp=0',
            '-listenonion=0','-onion=0','-disablewallet=1','-debug=rpc','-txindex=1','-rpcbind=127.0.0.1',
            '-rpcallowip=127.0.0.1','-printtoconsole=1','-dbcache=32','-par=1','-acceptnonstdtxn=0','-maxmempool=5',
            '-harddustlimit='+('0.002' if node=='b' else '0.001'),
            '-minrelaytxfee='+('0.01' if node=='b' else '0.001')]
        if lab_suite in ('fee-pinning',*VM_SUITES):
            daemon+=['-mempoolreplacement='+('0' if node=='b' else '1'),'-debug=mempoolrej']
        if import_file is not None:
            require(lab_suite in ('recovery-independent','recovery-resume') and handoff_root is not None
                    and Path(import_file).resolve()==Path(handoff_root).resolve()/'public-chain.dat',
                    'only verified public block handoff may be imported')
            daemon+=['-loadblock='+str(import_file)]
        report.setdefault('processStarts',[]).append({'source':node,'arguments':[x.replace(str(data),'PRIVATE_DATADIR') for x in daemon[1:]]})
        processes[node]=subprocess.Popen(daemon,env=env,stdout=log,stderr=subprocess.STDOUT)
        deadline=time.monotonic()+45
        while True:
            require(processes[node].poll() is None,'node exited before readiness')
            try:return rpc(node,'getblockchaininfo')
            except subprocess.CalledProcessError:
                require(time.monotonic()<deadline,'node readiness timeout');time.sleep(.5)
    def wait_for(label,predicate,timeout=60):
        deadline=time.monotonic()+timeout
        while True:
            value=predicate()
            if value:return value
            require(time.monotonic()<deadline,label+' timeout');time.sleep(1)
    def peer_view(node):return check_peers(rpc(node,'getpeerinfo'))
    def synchronized():
        a,b=(rpc(n,'getblockchaininfo') for n in NODES)
        return a if a['blocks']==b['blocks'] and a['bestblockhash']==b['bestblockhash'] else None
    def mine(node,count=1):
        # AuxPoW is forbidden before height20. Initial bulk mining deliberately
        # stays non-AuxPoW; every later fork/recovery block uses real AuxPoW.
        result=rpc(node,'generatetoaddress',str(count),addresses[node],'1000000','0' if count==1352 else '1')
        require(type(result) is list and len(result)==count and all(re.fullmatch('[0-9a-f]{64}',x) for x in result),'mining response mismatch')
        blocks.update(result)
        size=sum(p.stat().st_size for n in NODES for p in (work/('data-'+n)).rglob('*') if p.is_file())
        require(size<=1024*1024**2,'laboratory data budget exceeded')
        return result
    def submit(node,raw,reject=None):
        require(type(raw) is bytes and 0<len(raw)<=limits['maxFixtureBytes'],'bounded fixture bytes required')
        require(raw.hex() in submitted or len(submitted)<limits['maxBroadcastFixtures'],'fixture count budget')
        submitted.add(raw.hex());tid=hash256(raw)[::-1].hex();txids.add(tid)
        result=rpc(node,'sendrawtransaction',raw.hex(),reject=reject)
        if not reject:require(result==tid,'native transaction identity mismatch')
        return result
    def tx(node,tid):return rpc(node,'getrawtransaction',tid,'1',missing_ok=True)
    def snapshot(label,tid,competing=None):
        rows=[]
        for n in NODES:
            chain=rpc(n,'getblockchaininfo');observed=tx(n,tid);pool=rpc(n,'getrawmempool')
            conflict=None
            if competing:
                contender=tx(n,competing)
                if contender and contender.get('confirmations',0)>0:
                    # Verify the confirmed competing input, not merely a spent-output flag.
                    require(contender['vin'][0]['txid']==funding_id and contender['vin'][0]['vout']==0,'conflicting prevout mismatch')
                    conflict=competing
            row=normalize_observation(n,chain,observed,tid in pool,conflict)
            row['observedTxid']=tid;rows.append(row)
        stage={'label':label,'observations':rows};report['stages'].append(stage);save();return rows
    def destroy_keys():
        for signer in signers:signer.destroy()
        for directory,label in key_specs:(directory/(label+'.pem')).unlink(missing_ok=True)
        if (keys/'node-b').exists():(keys/'node-b').rmdir()
    def assert_auxpow(node,tip):
        block=rpc(node,'getblock',tip)
        require(type(block.get('version')) is int and block['version'] & 256 and block['version'] >> 16 == 98 and type(block.get('auxpow')) is dict,
                'native post-activation AuxPoW block evidence missing')
        return {'source':node,'height':block['height'],'hash':block['hash'],'version':block['version'],
            'auxpowChainId':block['version'] >> 16,'auxpowFields':sorted(block['auxpow'])}
    def restart(node,lose_mempool=False):
        require(lab_suite=='fee-pinning' and node=='a'
                and len(report.get('feeRestarts',[]))<2,'bounded fee-lab restart required')
        rpc(node,'stop');processes[node].wait(timeout=15);logs[node].close()
        require(processes[node].returncode==0,'unclean fee-lab stop')
        entry={'source':node,'privateMempoolDumpWithheld':lose_mempool}
        if lose_mempool:
            pool=work/('data-'+node)/'regtest'/'mempool.dat'
            require(pool.is_file() and not pool.is_symlink(),'private test mempool dump missing')
            backup=pool.with_name('mempool.saved-fee-incident')
            require(not backup.exists(),'fresh mempool incident backup required')
            pool.rename(backup)
            entry['retainedTestDumpSha256']=hashlib.sha256(backup.read_bytes()).hexdigest()
        report.setdefault('feeRestarts',[]).append(entry);save();return start(node)
    def import_chain(path,tip,height):
        require(lab_suite in ('recovery-independent','recovery-resume') and handoff_manifest is not None
                and tip==handoff_manifest['blocks'][-1] and height==len(handoff_manifest['blocks']),
                'verified independent public chain required')
        for node in NODES:
            rpc(node,'stop');processes[node].wait(timeout=15);logs[node].close()
            require(processes[node].returncode==0,'unclean genesis node stop')
            start(node,path)
            wait_for('public block import '+node,lambda:rpc(node,'getblockchaininfo').get('bestblockhash')==tip)
        require(synchronized()['blocks']==height,'public replay height mismatch')
        report['publicReplay']={'blocks':height,'tip':tip,'nodeDatabasesTransferred':False,
            'streamSha256':hashlib.sha256(path.read_bytes()).hexdigest()};save()
    def independent_fee_recovery(context):
        require(lab_suite in ('fee-pinning','recovery-independent','recovery-resume') and recovery_runner is not None,'standalone fee recovery required')
        label='feeRecoveryCalls' if lab_suite=='fee-pinning' else 'independentRecoveryCalls'
        require(len(report.get(label,[]))<(12 if lab_suite=='fee-pinning' else 24),'bounded fee recovery invocations required')
        disconnected=context.get('disconnectBlockchain',False)
        require(type(disconnected) is bool and (not disconnected or lab_suite=='recovery-independent'),
                'disconnect injection only in independent VM incident scope')
        node=context.pop('source','a')
        require(node in NODES,'fixed recovery source required')
        remaining=rpc_limit-len(trace)-len(external_calls)
        require(remaining>0,'no RPC budget remains for independent recovery')
        result=recovery_runner({**context,'cliPath':str(bins/'dogecoin-cli'),
            'nodeBDataDirectory':str(work/('data-'+node)),'nodeBRpcPort':RPC_PORTS[node],
            'backendDirectoryToHide':str(HERE.parents[3]),'nodeADataDirectoryToHide':str(work/'data-a'),
            'originalKeysDirectoryToHide':str(keys),'parentNetNs':parent,
            'parentMountNs':os.readlink('/proc/self/ns/mnt'),'evidenceDirectory':str(out),
            'maxRpcCalls':min(64,remaining)})
        calls=result['rpcCalls'];require(len(calls)<=min(64,remaining),'external fee recovery budget mismatch')
        for call in calls:
            require(set(call)=={'method','params'},'exact recovery RPC row required')
            validate_rpc(node,call['method'],call['params'],addresses=addresses,blocks=blocks,txids=txids,submitted=submitted)
        external_calls.extend({'source':node,'reachedServer':not disconnected,**c} for c in calls)
        result.update(source=node,labLabel=context.get('labLabel',''))
        report.setdefault(label,[]).append(result);save();return result
    def finish():
        for n in NODES:
            check_peers(rpc(n,'getpeerinfo'));rpc(n,'stop');processes[n].wait(timeout=15);logs[n].close()
            require(processes[n].returncode==0,'unclean final node stop')
            require(not list((work/('data-'+n)).rglob('wallet*')),'wallet residue')
            methods=re.findall(r'ThreadRPCServer method=([a-zA-Z0-9_]+)',(out/('daemon-'+n+'.log')).read_text())
            from collections import Counter
            expected=Counter(t['method'] for t in trace if t['source']==n and t.get('reachedServer'))
            expected.update(c['method'] for c in external_calls if c['source']==n and c.get('reachedServer',True))
            require(set(methods)<=set(limits['rpcAllowlist']) and Counter(methods)==expected,'server method audit mismatch')
        report['namespaceAfter']=json.loads(subprocess.check_output(['ip','-json','link','show'],text=True))
        validate_namespace(parent,os.readlink('/proc/self/ns/net'),report['namespaceAfter'])
        report.update(experimentStatus='PASS',generatedBlocks=generated,rpcCalls=len(trace)+len(external_calls),keysRemoved=True)
    try:
        for n in NODES:
            chain=start(n)
            identity={'blockchain':chain,'genesis':rpc(n,'getblockhash','0'),'network':rpc(n,'getnetworkinfo'),'peers':peer_view(n)}
            validate_network(identity);report.setdefault('initialIdentities',{})[n]=identity
        verify=native_verifier(bins/'libdogecoinconsensus.so.0.0.0')
        if lab_suite in ('recovery-independent','recovery-resume'):
            from vm_recovery import consume
            consume(dict(rpc=rpc,submit=submit,mine=mine,tx=tx,wait=wait_for,sync=synchronized,
                peers=peer_view,recover=independent_fee_recovery,import_chain=import_chain,
                keys=keys,out=out,report=report,save=save,submitted=submitted,txids=txids,blocks=blocks,
                addresses=addresses,executionCommit=args.execution_commit),handoff_root,handoff_manifest,
                resume=lab_suite=='recovery-resume')
            finish();return
        key_specs=test_key_specs(keys);(keys/'node-b').mkdir(mode=0o700)
        for directory,role in key_specs:signers.append(EphemeralSigner(directory,role))
        miner_a,miner_b,claim,refund=signers
        require(len({x.public for x in signers})==4,'four distinct test keys required')
        for n,key in zip(NODES,(miner_a,miner_b)):addresses[n]=base58check(b'\x6f'+hash160(key.public))
        if lab_suite in ('fee-pinning','recovery-handoff'):
            from fee_pinning import run_fee_suite
            handoff=None
            if lab_suite=='recovery-handoff':
                from vm_recovery import write_parcel
                def handoff(canonical,receipts,fixtures,prepared):
                    return write_parcel(dict(out=out,rpc=rpc,report=report,save=save,addresses=addresses,
                        executionCommit=args.execution_commit),canonical,receipts,fixtures,prepared)
            run_fee_suite(dict(rpc=rpc,submit=submit,mine=mine,tx=tx,wait=wait_for,sync=synchronized,
                peers=peer_view,restart=restart,recover=independent_fee_recovery,destroy_keys=destroy_keys,
                signers=signers,addresses=addresses,blocks=blocks,txids=txids,submitted=submitted,
                mocktimes=mocktimes,keys=keys,out=out,report=report,save=save,verify=verify,
                bundle_validator=bundle_validator,persist_bundle=persist_bundle,normalize=normalize_observation,handoff=handoff))
            finish();return
        destination=b'\x76\xa9\x14'+hash160(refund.public)+b'\x88\xac'
        claim_destination=b'\x76\xa9\x14'+hash160(claim.public)+b'\x88\xac'
        miner_script=b'\x76\xa9\x14'+hash160(miner_a.public)+b'\x88\xac'
        rpc('a','addnode','127.0.0.1:18445','onetry')
        wait_for('private peer connection',lambda:peer_view('a') and peer_view('b'))
        mine('a',1352);active=wait_for('initial block relay',synchronized)
        require(active['blocks']==1352 and any(x.get('id')=='bip65' and x.get('reject',{}).get('status') is True for x in active['softforks']),'BIP65 activation missing')
        first=rpc('a','getblockhash','1');blocks.add(first)
        coinbase=rpc('a','getblock',first)['tx'][0];txids.add(coinbase)
        coin=rpc('a','getrawtransaction',coinbase,'1');v=coin['vout'][0]
        require(v['scriptPubKey']['hex']==miner_script.hex(),'unexpected mature coinbase destination')
        value=int(Decimal(str(v['value']))*COIN);require(value>301*COIN,'mature funding amount too small')
        secret=hashlib.sha256(b'GPUbnb public private-lab multi-node fixture 2026-11-11').digest()
        htlc=build_candidate(hashlib.sha256(secret).digest(),claim.public,refund.public,1355)
        outputs=[(100*COIN,htlc.output),(RECOVERY_VALUE,htlc.output),(100*COIN,miner_script),
            (value-201*COIN-RECOVERY_VALUE,miner_script)]
        sig=miner_a.sign(sighash(coinbase,0,miner_script,outputs))
        funding=transaction(coinbase,0,push(sig)+push(miner_a.public),outputs);funding_id=hash256(funding)[::-1].hex();txids.add(funding_id)
        def spend(index,key,branch,amount=99*COIN):
            lock=1355 if branch=='refund' else 0;outs=[(amount,destination if branch=='refund' else claim_destination)]
            signature=key.sign(sighash(funding_id,index,htlc.redeem,outs,lock))
            ss=push(signature)+(b'\0' if branch=='refund' else push(secret)+b'\x51')+push(htlc.redeem)
            raw=transaction(funding_id,index,ss,outs,lock)
            require(verify(htlc.output,raw)=={'result':1,'error':0,'flags':517},'native fixture signature invalid')
            txids.add(hash256(raw)[::-1].hex());return raw
        claim_raw=spend(0,claim,'claim');refund_raw=spend(0,refund,'refund')
        recovery_raw=spend(1,refund,'refund',RECOVERY_VALUE-RECOVERY_FEES[0])
        recovery_high=spend(1,refund,'refund',RECOVERY_VALUE-RECOVERY_FEES[1])
        claim_id,refund_id,recovery_low_id,recovery_id=(hash256(x)[::-1].hex()
            for x in (claim_raw,refund_raw,recovery_raw,recovery_high))
        recovery_path=out/'refund-recovery.hex';recovery_sha=prepare_recovery(recovery_path,recovery_raw)
        prepare_recovery(out/'refund-conflict.hex',refund_raw)
        recovery_high_sha=prepare_recovery(out/'refund-recovery-high.hex',recovery_high)
        policy_outs=[(150000,destination),(100*COIN-150000-COIN,miner_script)]
        psig=miner_a.sign(sighash(funding_id,2,miner_script,policy_outs))
        policy_raw=transaction(funding_id,2,push(psig)+push(miner_a.public),policy_outs)
        bundle={'domain':'GPUBNB:DOGE:RECOVERY:v1','schemaVersion':1,'network':'regtest',
            'genesis':report['initialIdentities']['a']['genesis'],'sourceCommit':SOURCE_COMMIT,
            'contract':{'redeemHex':htlc.redeem.hex(),'outputHex':htlc.output.hex()},
            'funding':{'txid':funding_id,'vout':1,'valueKoinu':str(RECOVERY_VALUE),'transactionHex':funding.hex()},
            'policy':{'maxFeeKoinu':str(RECOVERY_FEES[1]),'minRefundKoinu':str(RECOVERY_VALUE-RECOVERY_FEES[1])},
            'refunds':[{'transactionHex':raw.hex(),'sha256':digest,'txid':hash256(raw)[::-1].hex(),
                'destinationHex':destination.hex(),'outputValueKoinu':str(amount),'feeKoinu':str(RECOVERY_VALUE-amount),
                'lockTime':1355,'sequence':0xfffffffe}
                for raw,digest,amount in [(recovery_raw,recovery_sha,RECOVERY_VALUE-RECOVERY_FEES[0]),
                    (recovery_high,recovery_high_sha,RECOVERY_VALUE-RECOVERY_FEES[1])]]}
        if bundle_validator is not None:bundle_validator(bundle)
        bundle_path=out/'recovery-bundle.json';bundle_digest=persist_bundle(bundle_path,bundle)
        report['recoveryBundleSha256']=bundle_digest
        report['preLockRecovery']={'fundingTxid':funding_id,'refundSha256':recovery_sha,'refundVout':1,'readbackVerified':True,'rpcCountBeforeFunding':len(trace)};save()
        submit('a',funding)
        wait_for('funding mempool relay',lambda:funding_id in rpc('b','getrawmempool'))
        funding_block=mine('a')[0];wait_for('funding confirmation relay',synchronized)
        for n in NODES:
            observed=rpc(n,'gettxout',funding_id,'1','true')
            require(observed is not None and observed['confirmations']==1
                    and Decimal(str(observed['value']))*COIN==RECOVERY_VALUE
                    and observed['scriptPubKey']['hex']==htlc.output.hex(),'independent funding UTXO mismatch')
        report['fundingAnchor']={'fundingBlockHash':funding_block,'fundingHeight':1353};save()
        destroy_keys()
        require(not list(keys.iterdir()),'private keys survived pre-partition destruction');report['keysRemovedBeforePartition']=True
        # Different local hard-dust policies: reject a mempool transaction, then accept its valid block.
        policy_id=submit('a',policy_raw);submit('b',policy_raw,reject='dust')
        require(policy_id not in rpc('b','getrawmempool'),'strict-policy node admitted dust control')
        mine('a');wait_for('policy transaction block relay',synchronized)
        require(tx('b',policy_id)['confirmations']==1,'consensus block rejected due to local relay policy')
        report['localPolicyDifferential']={'aHardDustDoge':'0.001','bHardDustDoge':'0.002','outputKoinu':150000,'aAdmitted':True,'bRejected':'dust','bAcceptedConfirmedBlock':True}
        submit('a',refund_raw,reject='non-final')
        rpc('b','setnetworkactive','false');wait_for('partition peers disconnected',lambda:not peer_view('a') and not peer_view('b'))
        common_tip=rpc('a','getblockchaininfo');require(common_tip['blocks']==1354,'unexpected partition anchor')
        mine('a');mine('b')
        submit('a',claim_raw);mine('a',2)
        submit('b',refund_raw);mine('b',4)
        require(tx('a',claim_id)['confirmations']==2 and tx('b',refund_id)['confirmations']==4,'fork transaction confirmations mismatch')
        partition=snapshot('partitioned_claim',claim_id)
        require(partition[0]['tipHash']!=partition[1]['tipHash'],'fork tips unexpectedly equal')
        report['fork']={'commonHeight':1354,'aHeight':1357,'bHeight':1359,'aRollbackDepth':3,'winningBranchLength':5}
        rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry')
        converged=wait_for('longer-work reconvergence',synchronized)
        require(converged['blocks']==1359,'unexpected winning chain height')
        for n in NODES:
            require(tx(n,refund_id)['confirmations']==4,'winning refund not independently confirmed')
            require(rpc(n,'gettxout',funding_id,'0','true') is None,'conflicted funding output restored incorrectly')
            losing=tx(n,claim_id);require(losing is None or losing.get('confirmations',0)==0,'orphaned claim still confirmed')
        snapshot('reorged_claim',claim_id,refund_id);snapshot('converged_refund',refund_id)
        report['auxpow']=[assert_auxpow(n,converged['bestblockhash']) for n in NODES]
        # A young 1-DOGE input stays below Dogecoin's free-priority threshold.
        # Merely increasing minrelaytxfee on a 100-DOGE input is insufficient:
        # sendrawtransaction can accept high-priority, below-floor transactions.
        low_rejection=submit('b',read_signed(recovery_path,recovery_sha),reject='insufficient priority')
        require(recovery_low_id not in rpc('b','getrawmempool'),'insufficient-fee refund entered node-B mempool')
        fee_network=rpc('b','getnetworkinfo')
        require(Decimal(str(fee_network['relayfee']))==Decimal('0.01'),'strict relay fee profile missing')
        report['keylessFeeRecovery']={'fundingValueKoinu':str(RECOVERY_VALUE),
            'lowFeeKoinu':str(RECOVERY_FEES[0]),'selectedFeeKoinu':str(RECOVERY_FEES[1]),
            'retainedValueKoinu':str(RECOVERY_VALUE-RECOVERY_FEES[1]),
            'feeCapKoinu':str(RECOVERY_FEES[1]),'lowFeeTxid':recovery_low_id,'selectedTxid':recovery_id,
            'nodeBRelayDogePerKb':str(fee_network['relayfee']),'nativeLowFeeRejection':low_rejection,
            'keysUnavailable':not list(keys.iterdir()),'newSignatureCreated':False,
            'pendingReplacementAttempted':False};save()
        # Integration hook receives only public recovery data and node-B connection metadata.
        # Parent may provide the separately packaged recovery CLI here; the base lab still
        # proves independent node-B broadcast of stored bytes without any surviving signer.
        hook_results=[]
        def independent_recovery(mode, expected_state=None, expected_transition=None, node='b'):
            require(node in NODES and recovery_runner is not None and len(hook_results)<5,
                'at most five private independent recovery calls required')
            result=recovery_runner({'mode':mode,'bundlePath':str(bundle_path),'bundleSha256':bundle_digest,
                'cliPath':str(bins/'dogecoin-cli'),'cliSha256':report['members']['dogecoin-cli']['sha256'],
                'nodeCommonArguments':list(common[node]),'nodeBDataDirectory':str(work/('data-'+node)),
                'nodeBRpcPort':RPC_PORTS[node],
                'backendDirectoryToHide':str(HERE.parents[3]),'nodeADataDirectoryToHide':str(work/'data-a'),
                'originalKeysDirectoryToHide':str(keys),'parentNetNs':parent,'parentMountNs':os.readlink('/proc/self/ns/mnt'),
                'expectedRefundTxid':recovery_id,'evidenceDirectory':str(out),
                'maxRpcCalls':min(64,MAX_RPC-len(trace)-len(external_calls))})
            require(type(result) is dict and result.get('txid')==recovery_id,'independent recovery hook identity mismatch')
            if expected_state:require(result.get('state')==expected_state,'independent recovery state mismatch')
            if expected_transition:require(result.get('transition')==expected_transition,'independent recovery transition mismatch')
            calls=result.get('rpcCalls')
            require(type(calls) is list and len(calls)<=64,'bounded external recovery RPC audit required')
            for call in calls:
                require(type(call) is dict and set(call)=={'method','params'},'exact recovery RPC audit row required')
                validate_rpc(node,call['method'],call['params'],addresses=addresses,blocks=blocks,txids=txids,submitted=submitted | {recovery_raw.hex(),recovery_high.hex()})
            external_calls.extend({'source':node,**call} for call in calls)
            require(len(trace)+len(external_calls)<=MAX_RPC,'recovery exceeded shared RPC budget')
            result['source']=node
            hook_results.append(result);report['independentRecoveryHook']=hook_results;save()
            return result
        if recovery_runner:
            independent_recovery('rebroadcast')
        else:
            require(submit('b',read_signed(out/'refund-recovery-high.hex',recovery_high_sha))==recovery_id,'stored refund identity mismatch')
            report['independentRecoveryHook']={'status':'NOT_TESTED','reason':'standalone recovery process not injected'}
        wait_for('recovery refund mempool relay',lambda:recovery_id in rpc('a','getrawmempool'))
        if recovery_runner:
            repeated=independent_recovery('rebroadcast','PENDING',node='a')
            require(repeated.get('selectedFeeKoinu')==str(RECOVERY_FEES[1]),
                'lower observed fee floor switched the already-pending refund')
            report['keylessFeeRecovery']['lowerFloorPendingRerelay']={
                'source':'a','nodeRelayDogePerKb':str(rpc('a','getnetworkinfo')['relayfee']),
                'samePendingTxid':True,'sameSignedBytes':True,'selectedFeeKoinu':repeated['selectedFeeKoinu']};save()
        recovery_block=mine('b')[0];final=wait_for('recovery block relay',synchronized)
        for n in NODES:
            recovered=tx(n,recovery_id)
            require(recovered['confirmations']==1,'second-node refund not independently confirmed')
            require(len(recovered['vout'])==1 and Decimal(str(recovered['vout'][0]['value']))*COIN==RECOVERY_VALUE-RECOVERY_FEES[1]
                and recovered['vout'][0]['scriptPubKey']['hex']==destination.hex(),'native recovery amount/destination mismatch')
            mempool_low=tx(n,recovery_low_id)
            require(mempool_low is None or mempool_low.get('confirmations',0)==0,'lower-fee variant unexpectedly confirmed')
        snapshot('recovery_refund_confirmed',recovery_id)
        if recovery_runner:
            independent_recovery('observe','CONFIRMED')
            rpc('b','setnetworkactive','false');wait_for('recovery partition',lambda:not peer_view('a') and not peer_view('b'))
            rpc('b','invalidateblock',recovery_block)
            require(tx('b',recovery_id).get('confirmations',0)==0,'local recovery rollback failed')
            independent_recovery('observe','PENDING','REORGED')
            snapshot('local_recovery_reorg',recovery_id)
            rpc('b','reconsiderblock',recovery_block)
            independent_recovery('observe','CONFIRMED')
            rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry')
            wait_for('recovery private peer reconnection',lambda:peer_view('a') and peer_view('b'))
            final=wait_for('recovery rejoin',synchronized)
            snapshot('local_recovery_restored',recovery_id)
        expected_tip=final['bestblockhash']
        rpc('a','stop');processes['a'].wait(timeout=15);require(processes['a'].returncode==0,'unclean node-A stop');logs['a'].close()
        restarted=start('a');require(restarted['chain']=='regtest','network changed after restart')
        rpc('a','addnode','127.0.0.1:18445','onetry')
        wait_for('restart private peer connection',lambda:peer_view('a') and peer_view('b'))
        restored=wait_for('restart reconvergence',synchronized)
        require(restored['bestblockhash']==expected_tip and restored['blocks']==1360,'restart changed winning chain')
        for n in NODES:require(tx(n,recovery_id)['confirmations']==1,'restart lost recovery confirmation')
        # Submit seven deliberately malformed proofs before the valid proof for
        # the very same cached native template. This excludes duplicate-block
        # shortcuts and demonstrates that rejection does not poison the cache.
        template=rpc('a','createauxblock',addresses['a'])
        require(template['height']==1361 and template['previousblockhash']==expected_tip
                and template['chainid']==98 and template['bits']=='207fffff'
                and re.fullmatch('[0-9a-f]{64}',template['hash']),'native AuxPoW template mismatch')
        blocks.add(template['hash'])
        fixtures=auxpow_vectors(template['hash'],template['target'])
        require(len(fixtures)==MAX_PROOFS,'fixed AuxPoW fixture count required')
        aux_submitted.update((template['hash'],f['hex']) for f in fixtures)
        probe={'template':template,'cases':[],'keysUnavailable':not list(keys.iterdir())}
        require(probe['keysUnavailable'],'signing keys present during AuxPoW probes')
        report['auxpowAdversarial']=probe;save()
        for fixture in fixtures:
            offset=len((out/'daemon-a.log').read_text())
            accepted=rpc('a','submitauxblock',template['hash'],fixture['hex'])
            require(type(accepted) is bool and accepted is fixture['expectedAccepted'],
                    'native AuxPoW acceptance mismatch: '+fixture['case'])
            row={k:v for k,v in fixture.items() if k!='hex'}
            row['nativeAccepted']=accepted;probe['cases'].append(row);save()
            if not accepted:
                wait_for('native AuxPoW rejection log',lambda:fixture['expectedNativeReason']
                    in (out/'daemon-a.log').read_text()[offset:],timeout=5)
                unchanged=synchronized()
                require(unchanged is not None and unchanged['bestblockhash']==expected_tip
                        and unchanged['blocks']==1360,'rejected AuxPoW changed a native tip')
                row.update(nativeReasonObserved=True,bothTipsUnchanged=True);save()
            else:
                generated+=1
                accepted_tip=wait_for('valid AuxPoW private relay',synchronized)
                require(accepted_tip['blocks']==1361 and accepted_tip['bestblockhash']==template['hash'],
                        'valid AuxPoW control failed independent relay')
                probe['nativeAcceptedBlocks']=[assert_auxpow(n,template['hash']) for n in NODES]
                probe['sameTemplateValidAfterRejections']=True
                for n in NODES:require(tx(n,recovery_id)['confirmations']==2,'AuxPoW control lost recovery confirmation')
                save()
        finish()
    except BaseException as error:
        report['error']=type(error).__name__+': '+str(error);raise
    finally:
        signal.alarm(0)
        for process in processes.values():
            if process.poll() is None:process.kill();process.wait(timeout=15)
        for log in logs.values():
            if not log.closed:log.close()
        destroy_keys()
        save();(out/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(out.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--manifest',action='store_true')
    parser.add_argument('--lab-suite',choices=LAB_SUITES,default='multinode')
    parser.add_argument('--handoff-directory');parser.add_argument('--handoff-sha256');parser.add_argument('--execution-commit')
    for name in ('evidence','verification','work','authorization','parent-net-ns'):parser.add_argument('--'+name)
    args=parser.parse_args()
    if args.manifest:print(json.dumps(manifest(args.lab_suite),indent=2,sort_keys=True))
    else:
        require(all(getattr(args,k.replace('-','_')) for k in ('evidence','verification','work','authorization','parent-net-ns')),'all laboratory arguments required')
        sys.path.insert(0,str(HERE.parents[2]/'recovery'/'dogecoin'))
        from recovery_core import validate_bundle
        from cleanroom import run_recovery_hook
        run(args,recovery_runner=run_recovery_hook,bundle_validator=validate_bundle)
