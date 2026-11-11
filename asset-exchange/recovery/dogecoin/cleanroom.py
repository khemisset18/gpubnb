"""Private qualification adapter: run the standalone tool with backend hidden.

This adapter is a test laboratory component. The zipapp itself does not import
or need it. No native process is launched by importing or packaging this file.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

from package import build_package
from recovery_core import read_regular, require, load_bundle, CLI_SHA256, AUTHORIZATION

ENTRY='''import json, os, pathlib, subprocess, sys
app,bundle,digest,cli,rpcdir,port,parentnet,parentmnt,mode,journal,trace,proof,*hidden=sys.argv[1:]
assert mode in ('observe','rebroadcast')
assert os.readlink('/proc/self/ns/mnt')!=parentmnt
for name in hidden:
    assert pathlib.Path(name).is_dir() and not any(pathlib.Path(name).iterdir())
assert not list(pathlib.Path.cwd().glob('*.pem'))
record={'separateMountNamespace':True,'backendUnavailable':True,'nodeADataUnavailable':True,
        'originalSigningKeysUnavailable':True,'isolatedPython':True,'walletKeysProvided':False,
        'standalonePackageSha256':__import__('hashlib').sha256(pathlib.Path(app).read_bytes()).hexdigest()}
pathlib.Path(proof).write_text(json.dumps(record,sort_keys=True)+'\\n')
command=[sys.executable,'-I',app,mode,'--bundle',bundle,'--bundle-sha256',digest,
         '--rpc-cli',cli,'--rpc-datadir',rpcdir,'--rpc-port',port,'--parent-net-ns',parentnet,
         '--authorization','AUTHORIZE_DOGE_RECOVERY_PRIVATE_REGTEST','--journal',journal,'--rpc-trace',trace]
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


def run_recovery_hook(context):
    required=('bundlePath','bundleSha256','cliPath','nodeBDataDirectory','nodeBRpcPort',
              'backendDirectoryToHide','nodeADataDirectoryToHide','originalKeysDirectoryToHide',
              'parentNetNs','parentMountNs','evidenceDirectory','mode')
    require(all(name in context for name in required),'incomplete cleanroom context')
    require(context['mode'] in ('observe','rebroadcast'),'unsupported cleanroom operation')
    out=Path(context['evidenceDirectory']).resolve()
    port=context['nodeBRpcPort']
    require(type(port) is int and port in (18332,18333),'fixed private recovery RPC endpoint required')
    # Each node keeps its own cookie and observation journal. Do not reuse a
    # copied node-B credential when demonstrating re-relay through node A.
    clean=out.parent/('recovery-cleanroom-'+str(port))
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
        cookie=read_regular(Path(context['nodeBDataDirectory'])/'regtest'/'.cookie',1024)
        (clean/'rpc'/'regtest'/'.cookie').write_bytes(cookie);(clean/'rpc'/'regtest'/'.cookie').chmod(0o600)
        (clean/'rpc'/'dogecoin.conf').write_text('regtest=1\ntestnet=0\n');(clean/'rpc'/'dogecoin.conf').chmod(0o600)
        (clean/'entry.py').write_text(ENTRY);(clean/'entry.py').chmod(0o600)
    # Revalidate copied package/bundle each call, never reacquire signing keys.
    require(str(clean) in PACKAGE_DIGESTS and hashlib.sha256(read_regular(clean/'doge-recovery.pyz')).hexdigest()==PACKAGE_DIGESTS[str(clean)],
            'standalone package differs from reviewed cleanroom copy')
    load_bundle(clean/'bundle.json',context['bundleSha256'])
    proof=out/('cleanroom-proof-'+str(port)+'-'+context['mode']+'.json')
    trace=clean/'rpc-trace.json'
    args=[str(clean/'doge-recovery.pyz'),str(clean/'bundle.json'),context['bundleSha256'],
          str(clean/'dogecoin-cli'),str(clean/'rpc'),str(context['nodeBRpcPort']),context['parentNetNs'],context['parentMountNs'],
          context['mode'],str(clean/'journal.json'),str(trace),str(proof),*hidden]
    command=['unshare','--mount','--propagation','private','--','/bin/bash','-c',MOUNTS,
            'doge-recovery-cleanroom',*hidden,sys.executable,'-I',str(clean/'entry.py'),*args]
    with subprocess.Popen(command,cwd=clean,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'},
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True) as child:
        try:stdout,stderr=child.communicate(timeout=210)
        except BaseException:
            os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=15);raise
        require(len(stdout)<=8192 and len(stderr)<=8192,'cleanroom output bound')
        if child.returncode:raise ValueError('independent recovery failed: '+stderr.strip())
    observation=json.loads(stdout)
    calls=json.loads(read_regular(trace))['calls']
    require(len(calls)<=64,'standalone RPC budget exceeded')
    isolation=json.loads(read_regular(proof))
    require(isolation['backendUnavailable'] and isolation['separateMountNamespace'],'backend isolation proof missing')
    return {'txid':observation.get('refundTxid'),'state':observation['state'],
            'transition':observation['transition'],'rpcCalls':calls,'isolationProof':isolation,
            'action':observation.get('action'),'selectedFeeKoinu':observation.get('selectedFeeKoinu'),
            'qualificationStatus':'BLOCKED'}
