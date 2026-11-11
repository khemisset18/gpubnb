"""Handoff and recovery cases called only by the existing private executor.

No daemon launcher or command-line entry point. A fresh GitHub-hosted VM gets
only an allowlisted public runtime, synthetic signed transactions and public
blocks; it never gets the producer's node databases, backend or signing keys.
"""
import hashlib
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

from script_diagnostics import require
from test_signer import hash256
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'recovery'/'dogecoin'))
from recovery_core import read_regular, load_bundle, GENESIS

MAGIC=bytes.fromhex('fabfb5da')
MAX_CHAIN_BYTES=16*1024**2
RUNTIME=(
    'asset-exchange/qualification/dogecoin/d2/DOGECOIN_COPYING',
    'asset-exchange/qualification/dogecoin/d0/verify-runtime-evidence.sh',
    'asset-exchange/qualification/dogecoin/d1/network_identity.py',
    *('asset-exchange/qualification/dogecoin/d2/'+x+'.py' for x in
      ('script_diagnostics','native_spends','offline_candidate','htlc_codec','spend_preparation','test_signer')),
    *('asset-exchange/qualification/dogecoin/d6/'+x for x in
      ('multinode.py','auxpow_fixtures.py','fee_pinning.py','vm_recovery.py','run-multinode.sh')),
    *('asset-exchange/recovery/dogecoin/'+x+'.py' for x in
      ('recovery_core','transaction','package','cleanroom')),
    'asset-exchange/wallet-agent/dogecoin/refund_ladder.py',
)
PAYLOAD=('public-chain.dat','fixtures.json',*(f'bundle-{x}.json' for x in ('main','cap','parent','conflict')))


def boot_hash():
    raw=Path('/proc/sys/kernel/random/boot_id').read_bytes()
    require(re.fullmatch(rb'[0-9a-f-]{36}\n',raw) is not None,'native boot identity required')
    return hashlib.sha256(raw).hexdigest()


def check_stream(raw,blocks):
    require(type(raw) is bytes and len(raw)<=MAX_CHAIN_BYTES,'bounded public block stream required')
    require(type(blocks) is list and 1355<=len(blocks)<=1362 and len(set(blocks))==len(blocks),'bounded canonical block sequence required')
    pos=0;previous=GENESIS
    for expected in blocks:
        require(re.fullmatch('[0-9a-f]{64}',expected) is not None,'canonical block hash required')
        require(raw[pos:pos+4]==MAGIC and pos+8<=len(raw),'public stream network/framing mismatch')
        size=int.from_bytes(raw[pos+4:pos+8],'little');pos+=8
        require(80<=size<=4_000_000 and pos+size<=len(raw),'public block length mismatch')
        block=raw[pos:pos+size];pos+=size
        require(hash256(block[:80])[::-1].hex()==expected and block[4:36][::-1].hex()==previous,
                'public block identity/order mismatch')
        previous=expected
    require(pos==len(raw),'public stream trailing data')


def load_parcel(directory,digest):
    root=Path(directory).resolve();raw=read_regular(root/'parcel.json')
    require(type(digest) is str and re.fullmatch('[0-9a-f]{64}',digest) is not None
            and hashlib.sha256(raw).hexdigest()==digest,'independent handoff digest mismatch')
    manifest=json.loads(raw)
    require(set(manifest)=={'schemaVersion','executionCommit','producerBootHash','originBootHash',
        'phase','blocks','addresses','preparedFixtureSha256','bundleDigests','files'},'exact handoff manifest required')
    require(manifest['schemaVersion']==1 and manifest['phase'] in ('prepared','confirmed')
            and re.fullmatch('[0-9a-f]{40}',manifest['executionCommit']) is not None,'handoff version/source mismatch')
    for key in ('producerBootHash','originBootHash'):
        require(type(manifest[key]) is str and re.fullmatch('[0-9a-f]{64}',manifest[key]) is not None,'boot digest required')
    expected=set(RUNTIME)|set(PAYLOAD)
    require(set(manifest['files'])==expected,'exact public runtime/payload allowlist required')
    actual=set();directories={'.'}
    for name in expected:
        directories.update(str(p) for p in Path(name).parents)
    for path in root.rglob('*'):
        require(not path.is_symlink(),'handoff symlink forbidden')
        relative=str(path.relative_to(root))
        if path.is_file():actual.add(relative)
        else:require(path.is_dir() and relative in directories,'unexpected handoff directory')
    require(actual==expected|{'parcel.json'},'unexpected or missing handoff file')
    for name,digest in manifest['files'].items():
        require(re.fullmatch('[0-9a-f]{64}',digest) is not None,'file digest required')
        data=read_regular(root/name,MAX_CHAIN_BYTES)
        require(hashlib.sha256(data).hexdigest()==digest,'handoff file digest mismatch')
    check_stream(read_regular(root/'public-chain.dat',MAX_CHAIN_BYTES),manifest['blocks'])
    require(set(manifest['bundleDigests'])=={'main','cap','parent','conflict'},'exact bundle receipts required')
    for label,digest in manifest['bundleDigests'].items():load_bundle(root/f'bundle-{label}.json',digest)
    return manifest


def write_parcel(c,blocks,receipts,fixtures,prepared,*,seed=None,phase='prepared'):
    root=c['out'].parent/'handoff';require(not root.exists(),'fresh handoff directory required');root.mkdir(mode=0o700)
    runtime=Path(__file__).resolve().parents[4]
    for name in RUNTIME:
        target=root/name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(read_regular(runtime/name,MAX_CHAIN_BYTES));target.chmod(0o600)
    for label,(path,_) in receipts.items():
        (root/f'bundle-{label}.json').write_bytes(read_regular(path))
    (root/'fixtures.json').write_text(json.dumps(fixtures,sort_keys=True,separators=(',',':'))+'\n')
    prefix=b'';offset=0
    if seed:
        source,previous=seed;prefix=read_regular(Path(source)/'public-chain.dat',MAX_CHAIN_BYTES)
        require(blocks[:len(previous['blocks'])]==previous['blocks'],'seed canonical prefix changed')
        offset=len(previous['blocks'])
    stream=bytearray(prefix)
    for block in blocks[offset:]:
        raw=bytes.fromhex(c['rpc']('a','getblock',block,'false'))
        require(80<=len(raw)<=4_000_000,'bounded native public block required')
        stream+=MAGIC+struct.pack('<I',len(raw))+raw
        require(len(stream)<=MAX_CHAIN_BYTES,'public block stream budget exceeded')
    check_stream(bytes(stream),blocks);(root/'public-chain.dat').write_bytes(stream)
    manifest={'schemaVersion':1,'executionCommit':c['executionCommit'],'producerBootHash':boot_hash(),
        'originBootHash':seed[1]['originBootHash'] if seed else boot_hash(),'phase':phase,
        'blocks':blocks,'addresses':c['addresses'],'preparedFixtureSha256':prepared,
        'bundleDigests':{k:v[1] for k,v in receipts.items()},
        'files':{name:hashlib.sha256(read_regular(root/name,MAX_CHAIN_BYTES)).hexdigest() for name in (*RUNTIME,*PAYLOAD)}}
    raw=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode();(root/'parcel.json').write_bytes(raw)
    for path in root.rglob('*'):
        if path.is_file():
            with path.open('rb') as stream:os.fsync(stream.fileno())
    for directory in sorted([root,*(p for p in root.rglob('*') if p.is_dir())],key=lambda p:len(p.parts),reverse=True):
        fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    digest=hashlib.sha256(raw).hexdigest();load_parcel(root,digest)
    c['report']['handoff']={'sha256':digest,'phase':phase,'publicBlocks':len(blocks),
        'producerBootHash':manifest['producerBootHash'],'originBootHash':manifest['originBootHash'],
        'onlyAllowlistedPublicFiles':True,'oldNodeDirectoriesCopied':False,'privateKeysCopied':False,
        'serverOrExchangeDatabaseCopied':False};c['save']();return digest


def consume(c,root,manifest,*,resume=False):
    rpc,submit,mine,tx,wait,sync,peers=(c[x] for x in ('rpc','submit','mine','tx','wait','sync','peers'))
    report=c['report'];current=boot_hash()
    require(current not in (manifest['producerBootHash'],manifest['originBootHash']),'consumer must run in another booted VM')
    require(set(os.environ)<= {'PATH','LANG','LC_CTYPE'},'unexpected inherited environment')
    require(not (Path(root)/'.git').exists() and not (Path(root)/'apps').exists(),'backend checkout present')
    require(not list(c['keys'].iterdir()),'consumer signing keys forbidden')
    fixtures=json.loads(read_regular(Path(root)/'fixtures.json',MAX_CHAIN_BYTES))
    require(set(fixtures)=={'funding','low','high','claim','conflictRefund','pressure'},'exact public fixture fields required')
    require(type(fixtures['pressure']) is list and len(fixtures['pressure'])==80,'bounded pressure fixture set required')
    registered=[v for k,v in fixtures.items() if k!='pressure']+fixtures['pressure']
    require(len(registered)<=96 and len(set(registered))==len(registered),'bounded distinct signed fixtures required')
    raw={k:bytes.fromhex(v) for k,v in fixtures.items() if k!='pressure'}
    for value in registered:
        data=bytes.fromhex(value);tid=hash256(data)[::-1].hex()
        require(len(data)<=60000 and hashlib.sha256(data).hexdigest()==manifest['preparedFixtureSha256'].get(tid),
                'registered synthetic transaction digest mismatch')
    c['submitted'].update(registered);c['txids'].update(manifest['preparedFixtureSha256']);c['blocks'].update(manifest['blocks'])
    receipts={k:(Path(root)/f'bundle-{k}.json',v) for k,v in manifest['bundleDigests'].items()}
    result={'separateVm':True,'physicalMachineIndependence':'NOT_TESTED','inPlaceVmReboot':'NOT_TESTED',
        'producerBootHash':manifest['producerBootHash'],'originBootHash':manifest['originBootHash'],
        'consumerBootHash':current,'nativeSignerInvocations':0,'backendCheckoutPresent':False,
        'originalNodeDirectoriesPresent':False,'inheritedSecrets':False,'cases':[],'qualificationStatus':'BLOCKED'}
    report['independentRecovery']=result;c['save']()
    def record(number,name,**detail):
        require(all(x['id']!=number for x in result['cases']),'duplicate recovery incident')
        result['cases'].append({'id':number,'name':name,'status':'PASS',**detail});c['save']()
    def recover(label='main',mode='rebroadcast',source='a',error=None,disconnected=False):
        path,digest=receipts[label]
        context={'bundlePath':str(path),'bundleSha256':digest,'mode':mode,'source':source,'labLabel':'vm-'+label}
        if error:context['expectedError']=error
        if disconnected:context['disconnectBlockchain']=True
        return c['recover'](context)
    c['import_chain'](Path(root)/'public-chain.dat',manifest['blocks'][-1],len(manifest['blocks']))
    rpc('a','addnode','127.0.0.1:18445','onetry');wait('independent VM private peers',lambda:peers('a') and peers('b'))
    if resume:
        require(manifest['phase']=='confirmed','confirmed VM replacement handoff required')
        observed=recover()
        require(observed['state']=='CONFIRMED' and observed['action']=='ALREADY_CONFIRMED'
                and not any(x['method']=='sendrawtransaction' for x in observed['rpcCalls']),
                'replacement VM attempted a duplicate refund')
        record(3,'fresh-vm-replacement-after-recovery-machine-loss',originalWorkspaceAndProcessGone=True,
            restoredOnlyPublicPackage=True,literalInPlaceReboot='NOT_TESTED',confirmedRetryBroadcasts=0)
        return
    require(manifest['phase']=='prepared','unspent independent recovery handoff required')
    record(1,'backend-totally-absent',producerJobAlreadyCompleted=True,publicBlockchainReplayed=True)
    failure=recover(mode='observe',error='RPC getblockchaininfo failed',disconnected=True)
    require(failure['blockchainDisconnected'] and not any(x['method']=='sendrawtransaction' for x in failure['rpcCalls']),
            'disconnected recovery broadcast')
    record(2,'blockchain-connection-loss',exactRefusal=failure['expectedRefusal'],broadcasts=0)
    # These are the actual standalone zipapp's offline checks in the independent
    # VM. Diagnostic altered digests test semantics; retained receipts separately
    # demonstrate that an attacker cannot authorize changed bundle bytes.
    from package import build_package
    sandbox=c['out'].parent/'independent-inspection';sandbox.mkdir(mode=0o700)
    app=sandbox/'doge-recovery.pyz';app_digest=build_package(app)
    original=read_regular(receipts['main'][0]);bundle=json.loads(original)
    def bad_bundle(number,name,data,error,*,retained=False):
        path=sandbox/f'incident-{number}.json';path.write_bytes(data)
        digest=receipts['main'][1] if retained else hashlib.sha256(data).hexdigest()
        command=[sys.executable,'-I',str(app),'inspect','--bundle',str(path),'--bundle-sha256',digest]
        child=subprocess.run(command,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},cwd=sandbox,
            capture_output=True,text=True,timeout=20)
        require(child.returncode==1 and not child.stdout and len(child.stderr)<8192,'malformed standalone bundle not refused')
        observation=json.loads(child.stderr)
        require(observation['state']=='UNKNOWN' and error in observation['error']
                and observation['automaticSettlement'] is False,'unexpected standalone semantic refusal')
        record(number,name,exactRefusal=observation['error'],broadcasts=0,packageSha256=app_digest)
    bad_bundle(4,'corrupt-recovery-bundle',b'{broken','bundle digest mismatch',retained=True)
    altered=json.loads(original);altered['policy']['maxFeeKoinu']='99999999'
    bad_bundle(5,'attacker-modifies-bundle-with-retained-receipt',json.dumps(altered).encode(),'bundle digest mismatch',retained=True)
    altered=json.loads(original);altered['network']='mainnet'
    bad_bundle(6,'wrong-network',json.dumps(altered).encode(),'wrong recovery network/source')
    altered=json.loads(original);altered['refunds'][0]['destinationHex']='76a914'+'00'*20+'88ac'
    bad_bundle(7,'wrong-destination',json.dumps(altered).encode(),'destination')
    altered=json.loads(original);altered['refunds'][0]['outputValueKoinu']='99000001'
    bad_bundle(8,'wrong-amount',json.dumps(altered).encode(),'amount')
    first=recover();again=recover()
    low_id=hash256(raw['low'])[::-1].hex();high_id=hash256(raw['high'])[::-1].hex()
    require(first['state']==again['state']=='PENDING' and first['txid']==again['txid']==low_id,'pending idempotency failed')
    record(14,'double-refund-attempt',samePendingTxid=low_id,distinctTransactionsBroadcast=1)
    rpc('b','setnetworkactive','false');wait('independent VM partition',lambda:not peers('a') and not peers('b'))
    submit('a',raw['claim'])
    blocked=recover('conflict',error='funding unavailable or ambiguous; no broadcast')
    require(not any(x['method']=='sendrawtransaction' for x in blocked['rpcCalls']),'blocked refund attempted replacement')
    record(10,'transaction-blocked-by-valid-claim',automaticReplacement=False,exactRefusal=blocked['expectedRefusal'])
    other=recover('conflict',source='b');require(other['state']=='PENDING','independent peer refund not pending')
    record(11,'divergent-mempools',aClaimObserved=True,bRefundObserved=True)
    mine('a');winning=mine('b',4)
    rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry');wait('independent conflict reorg',sync)
    confirmed=recover('conflict',mode='observe');require(confirmed['state']=='CONFIRMED','winning refund not confirmed')
    rpc('b','setnetworkactive','false');wait('independent rollback partition',lambda:not peers('a') and not peers('b'))
    rpc('a','invalidateblock',winning[0]);rolled=recover('conflict',mode='observe')
    require(rolled['transition']=='REORGED' and rolled['state']!='CONFIRMED','independent confirmed refund rollback hidden')
    rpc('a','reconsiderblock',winning[0]);restored=recover('conflict',mode='observe')
    require(restored['state']=='CONFIRMED','independent refund confirmation did not restore')
    record(12,'confirmed-refund-reorganisation',rollbackDepth=4,standaloneTransition=rolled['transition'],
        afterReconsideration=restored['state'])
    # The reorg removed the old main refund. Retransmit the exact authorized
    # bytes, then create real bounded pressure on this independent VM's node.
    recovery=recover();require(recovery['state']=='PENDING' and recovery['txid']==low_id,'independent pending refund lost')
    main=load_bundle(receipts['main'][0],receipts['main'][1]);cheap=main['refunds'][0]
    rate=int(cheap['feeKoinu'])*1000//(len(cheap['transactionHex'])//2)
    observations=[]
    for encoded in fixtures['pressure']:
        submit('a',bytes.fromhex(encoded));info=rpc('a','getmempoolinfo');observations.append(info)
        if int(Decimal(str(info['mempoolminfee']))*100_000_000)>rate and low_id not in rpc('a','getrawmempool'):break
    else:raise ValueError('independent native pressure failed to evict the cheap refund')
    exhausted=recover('cap',error='no pre-signed refund covers current fee floor; signatory or new authorization required')
    require(not any(x['method']=='sendrawtransaction' for x in exhausted['rpcCalls']),'exhausted independent ladder broadcast')
    record(13,'fee-floor-exceeds-presigned-cap',exactRefusal=exhausted['expectedRefusal'],broadcasts=0,
        pressureTransactions=len(observations),nativeFloor=observations[-1]['mempoolminfee'])
    adequate=recover();require(adequate['state']=='PENDING' and adequate['txid']==high_id,'independent keyless recovery failed')
    record(15,'original-signer-unavailable',newSignatures=0,selectedExistingFeeKoinu=adequate['selectedFeeKoinu'])
    final=mine('a');rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry');wait('independent refund relay',sync)
    for n in ('a','b'):
        native=tx(n,high_id)
        require(native['confirmations']==1 and Decimal(str(native['vout'][0]['value']))==Decimal('0.99')
                and native['vout'][0]['scriptPubKey']['hex']==main['refunds'][1]['destinationHex'],
                'independent confirmed refund amount/destination mismatch')
    repeat=recover();require(repeat['action']=='ALREADY_CONFIRMED'
        and not any(x['method']=='sendrawtransaction' for x in repeat['rpcCalls']),'confirmed duplicate broadcast')
    record(9,'refund-already-confirmed',broadcasts=0,txid=high_id,retainedKoinu='99000000',confirmedOnBothNodes=True)
    result['pressureObservations']=observations;result['inPlaceVmReboot']='NOT_TESTED'
    write_parcel(c,manifest['blocks']+winning+final,receipts,fixtures,manifest['preparedFixtureSha256'],
        seed=(root,manifest),phase='confirmed')
    result['replacementVmTestPending']=True;c['save']()
