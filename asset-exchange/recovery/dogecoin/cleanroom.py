"""Private qualification adapter: run the standalone tool with backend hidden.

This adapter is a test laboratory component. The zipapp itself does not import
or need it. No native process is launched by importing or packaging this file.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

from package import build_package
from recovery_core import read_regular, require, load_bundle, CLI_SHA256, AUTHORIZATION

ENTRY='''import json, os, pathlib, subprocess, sys
app,bundle,digest,cli,rpcdir,port,parentnet,parentmnt,budget,mode,journal,trace,proof,*hidden=sys.argv[1:]
assert mode in ('observe','rebroadcast')
assert os.readlink('/proc/self/ns/mnt')!=parentmnt
for name in hidden:
    assert pathlib.Path(name).is_dir() and not any(pathlib.Path(name).iterdir())
assert not list(pathlib.Path.cwd().glob('*.pem'))
record={'separateMountNamespace':True,'backendUnavailable':True,'nodeADataUnavailable':True,
        'originalSigningKeysUnavailable':True,'isolatedPython':True,'walletKeysProvided':False,
        'networkNamespace':os.readlink('/proc/self/ns/net'),
        'standalonePackageSha256':__import__('hashlib').sha256(pathlib.Path(app).read_bytes()).hexdigest()}
pathlib.Path(proof).write_text(json.dumps(record,sort_keys=True)+'\\n')
command=[sys.executable,'-I',app,mode,'--bundle',bundle,'--bundle-sha256',digest,
         '--rpc-cli',cli,'--rpc-datadir',rpcdir,'--rpc-port',port,'--parent-net-ns',parentnet,
         '--authorization','AUTHORIZE_DOGE_RECOVERY_PRIVATE_REGTEST','--journal',journal,'--rpc-trace',trace,
         '--rpc-budget',budget]
r=subprocess.run(command,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','TMPDIR':str(pathlib.Path.cwd()/'tmp')},
                 capture_output=True,text=True,timeout=180)
sys.stdout.write(r.stdout);sys.stderr.write(r.stderr);raise SystemExit(r.returncode)
'''
MOUNTS='''set -euo pipefail
for hidden in "$1" "$2" "$3"; do
  mount -t tmpfs -o size=4096,mode=000 tmpfs "$hidden"
done
shift 3
exec "$@"
'''
PACKAGE_DIGESTS={}
EXPECTED_REFUSALS=frozenset({
    'funding is not confirmed on active chain; no broadcast',
    'funding unavailable or ambiguous; no broadcast',
    'no pre-signed refund covers current fee floor; signatory or new authorization required',
    'pending refund no longer covers fee floor; automatic non-RBF replacement forbidden',
    'RPC getblockchaininfo failed'})


def refresh_service_cookie(source,target):
    """Refresh only the explicitly selected private blockchain RPC credential.

    The standalone process never reads the original node folder. Atomic replace
    prevents a corrupted destination file from redirecting a credential write.
    Neither the credential nor its hash is included in public evidence.
    """
    cookie=read_regular(source,1024);target=Path(target)
    require(not target.is_symlink(),'RPC cookie symlink forbidden')
    fd,name=tempfile.mkstemp(prefix='.rpc-cookie-',dir=target.parent)
    try:
        with os.fdopen(fd,'wb') as stream:stream.write(cookie);stream.flush();os.fsync(stream.fileno())
        os.replace(name,target);target.chmod(0o600)
    finally:
        if Path(name).exists():Path(name).unlink()


def run_recovery_hook(context):
    required=('bundlePath','bundleSha256','cliPath','nodeBDataDirectory','nodeBRpcPort',
              'backendDirectoryToHide','nodeADataDirectoryToHide','originalKeysDirectoryToHide',
              'parentNetNs','parentMountNs','evidenceDirectory','mode')
    require(all(name in context for name in required),'incomplete cleanroom context')
    require(context['mode'] in ('observe','rebroadcast'),'unsupported cleanroom operation')
    budget=context.get('maxRpcCalls',64)
    require(type(budget) is int and 1<=budget<=64,'bounded cleanroom RPC budget required')
    label=context.get('labLabel','')
    require(type(label) is str and re.fullmatch('[a-z0-9-]{0,32}',label),'bounded cleanroom label required')
    expected_error=context.get('expectedError')
    require(expected_error is None or expected_error in EXPECTED_REFUSALS,'unsupported expected recovery refusal')
    disconnected=context.get('disconnectBlockchain',False)
    require(type(disconnected) is bool and (expected_error=='RPC getblockchaininfo failed')==disconnected,
            'disconnected incident requires its exact connection refusal')
    require(not disconnected or context['mode']=='observe','disconnected incident is observation-only')
    out=Path(context['evidenceDirectory']).resolve()
    port=context['nodeBRpcPort']
    require(type(port) is int and port in (18332,18333),'fixed private recovery RPC endpoint required')
    # Each node keeps its own cookie and observation journal. Do not reuse a
    # copied node-B credential when demonstrating re-relay through node A.
    suffix=('-'+label) if label else ''
    clean=out.parent/('recovery-cleanroom-'+str(port)+suffix)
    hidden=[str(Path(context[name]).resolve()) for name in
            ('backendDirectoryToHide','nodeADataDirectoryToHide','originalKeysDirectoryToHide')]
    require(len(set(hidden))==3,'distinct backend/node/key paths required')
    for path in hidden:
        require(Path(path).is_dir() and Path(path)!=Path('/') and Path(path) not in clean.parents,
                'cleanroom must be outside hidden roots')
    if not clean.exists():
        clean.mkdir(mode=0o700)
        (clean/'tmp').mkdir(mode=0o700)
        (clean/'rpc').mkdir(mode=0o700);(clean/'rpc'/'regtest').mkdir(mode=0o700)
        PACKAGE_DIGESTS[str(clean)]=build_package(clean/'doge-recovery.pyz')
        raw=read_regular(context['bundlePath'])
        require(hashlib.sha256(raw).hexdigest()==context['bundleSha256'],'independent bundle receipt mismatch')
        (clean/'bundle.json').write_bytes(raw);(clean/'bundle.json').chmod(0o600)
        load_bundle(clean/'bundle.json',context['bundleSha256'])
        cli=read_regular(context['cliPath'],16*1024*1024)
        require(hashlib.sha256(cli).hexdigest()==CLI_SHA256,'cleanroom RPC executable mismatch')
        (clean/'dogecoin-cli').write_bytes(cli);(clean/'dogecoin-cli').chmod(0o700)
        (clean/'rpc'/'dogecoin.conf').write_text('regtest=1\ntestnet=0\n');(clean/'rpc'/'dogecoin.conf').chmod(0o600)
        (clean/'entry.py').write_text(ENTRY);(clean/'entry.py').chmod(0o600)
    # Revalidate copied package/bundle each call, never reacquire signing keys.
    require(str(clean) in PACKAGE_DIGESTS and hashlib.sha256(read_regular(clean/'doge-recovery.pyz')).hexdigest()==PACKAGE_DIGESTS[str(clean)],
            'standalone package differs from reviewed cleanroom copy')
    load_bundle(clean/'bundle.json',context['bundleSha256'])
    refresh_service_cookie(Path(context['nodeBDataDirectory'])/'regtest'/'.cookie',clean/'rpc'/'regtest'/'.cookie')
    proof=out/('cleanroom-proof-'+str(port)+suffix+'-'+context['mode']+'.json')
    trace=clean/'rpc-trace.json'
    args=[str(clean/'doge-recovery.pyz'),str(clean/'bundle.json'),context['bundleSha256'],
          str(clean/'dogecoin-cli'),str(clean/'rpc'),str(context['nodeBRpcPort']),context['parentNetNs'],context['parentMountNs'],
          str(budget),context['mode'],str(clean/'journal.json'),str(trace),str(proof),*hidden]
    mount_script=MOUNTS.replace('set -euo pipefail\n','set -euo pipefail\nip link set lo up\n',1) if disconnected else MOUNTS
    command=['unshare',*(['--net'] if disconnected else []),'--mount','--propagation','private','--','/bin/bash','-c',mount_script,
            'doge-recovery-cleanroom',*hidden,sys.executable,'-I',str(clean/'entry.py'),*args]
    with subprocess.Popen(command,cwd=clean,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'},
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True) as child:
        try:stdout,stderr=child.communicate(timeout=210)
        except BaseException:
            os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=15);raise
        require(len(stdout)<=8192 and len(stderr)<=8192,'cleanroom output bound')
        if expected_error is not None:
            require(child.returncode==1 and not stdout.strip(),'expected recovery refusal did not occur')
            refusal=json.loads(stderr)
            require(set(refusal)=={'state','error','automaticSettlement'} and refusal['state']=='UNKNOWN'
                    and refusal['error']==expected_error and refusal['automaticSettlement'] is False,
                    'different recovery refusal observed')
            observation={'state':'UNKNOWN','transition':'EXPECTED_REFUSAL','error':expected_error}
        else:
            if child.returncode:raise ValueError('independent recovery failed: '+stderr.strip())
            observation=json.loads(stdout)
    calls=json.loads(read_regular(trace))['calls']
    require(len(calls)<=budget,'standalone RPC budget exceeded')
    isolation=json.loads(read_regular(proof))
    require(isolation['backendUnavailable'] and isolation['separateMountNamespace'],'backend isolation proof missing')
    require((isolation['networkNamespace']!=os.readlink('/proc/self/ns/net'))==disconnected,
            'recovery network incident isolation mismatch')
    return {'txid':observation.get('refundTxid'),'state':observation['state'],
            'fundingConfirmed':observation.get('fundingConfirmed'),
            'transition':observation['transition'],'rpcCalls':calls,'isolationProof':isolation,
            'action':observation.get('action'),'selectedFeeKoinu':observation.get('selectedFeeKoinu'),
            'expectedRefusal':observation.get('error'),
            'blockchainDisconnected':disconnected,
            'qualificationStatus':'BLOCKED'}
