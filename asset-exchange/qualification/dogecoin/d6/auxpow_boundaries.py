# Copyright (c) 2014 Daniel Kraft
# Copyright (c) 2015-2022 The Dogecoin Core developers
# Distributed under the MIT license; see ../d2/DOGECOIN_COPYING.
"""New AuxPoW properties inside the existing private native executor.

Uses the exact1.14.9 auxpow_tests.cpp and QA serialization strategies.
No daemon launcher, signer or CLI. Native nodes alone decide acceptance.
"""
import hashlib
import json
from pathlib import Path
import re
import struct
import time
from script_diagnostics import require
from test_signer import hash256
from auxpow_fixtures import scrypt_hash,TARGET,MAX_PARENT_ATTEMPTS

SEED_MANIFEST_SHA256='ace1f4d52cfac8c0cb68ad23c2ce603d2e0b0f1c4c92fe3f4591b0e24b1ac0b9'
SEED_STREAM_SHA256='3416b8b69aea7cd1f690810e068954ac3132197bd2a1ed074a7b0c89c6e25309'
MAX_EXPANDED_PROOFS=32
NEGATIVE={
    'parent-noncoinbase-index':('consensus','AuxPow is not a generate'),
    'parent-no-inputs':('consensus','Aux POW coinbase has no inputs'),
    'duplicate-merged-headers':('consensus','Multiple merged mining headers in coinbase'),
    'displaced-merged-header':('consensus','Merged mining header is not just before chain merkle root'),
    'legacy-root-offset-21':('consensus','Aux POW chain merkle root must start in the first 20 bytes of the parent coinbase'),
    'missing-commitment-nonce':('consensus','Aux POW missing chain merkle tree size and nonce in parent coinbase'),
    'truncated-parent-header':('rpc-deserialization','CDataStream::read(): end of data'),
    'noncanonical-parent-branch-count':('rpc-deserialization','non-canonical ReadCompactSize()'),
}
POSITIVE=('legacy-root-offset-20','chain-branch-height-30','parent-branch-height-31','trailing-rpc-data')

def load_public_seed(directory,digest):
    from vm_recovery import check_stream,MAX_CHAIN_BYTES
    from recovery_core import read_regular
    root=Path(directory).resolve();raw=read_regular(root/'parcel.json')
    require(digest==SEED_MANIFEST_SHA256 and hashlib.sha256(raw).hexdigest()==digest,
            'exact previously verified public seed receipt required')
    manifest=json.loads(raw)
    require(manifest['executionCommit']=='6307538265aef8273447891f445a28531043d1b5'
            and manifest['phase']=='prepared' and len(manifest['blocks'])==1355,'wrong public seed provenance')
    stream=read_regular(root/'public-chain.dat',MAX_CHAIN_BYTES)
    require(hashlib.sha256(stream).hexdigest()==manifest['files']['public-chain.dat']==SEED_STREAM_SHA256,
            'public seed block bytes differ')
    check_stream(stream,manifest['blocks'])
    return manifest

def expected_index(nonce,chain_id,height):
    require(type(nonce) is int and 0<=nonce<=0xffffffff and type(chain_id) is int
            and 0<=chain_id<=0xffff and type(height) is int and 0<=height<=30,'bounded chain-index terms required')
    value=(nonce*1103515245+12345)&0xffffffff
    value=(value+chain_id)&0xffffffff
    value=(value*1103515245+12345)&0xffffffff
    return value%(1<<height)

def merkle(leaf,branch,index):
    require(type(leaf) is bytes and len(leaf)==32 and len(branch)<=31,'bounded fixture merkle branch required')
    for sibling in branch:
        require(type(sibling) is bytes and len(sibling)==32,'fixed merkle sibling required')
        leaf=hash256(sibling+leaf if index&1 else leaf+sibling);index>>=1
    return leaf

def fixture(block_hash,target_hex,case):
    require(type(block_hash) is str and re.fullmatch('[0-9a-f]{64}',block_hash),'canonical child identity required')
    require(target_hex==TARGET.to_bytes(32,'little').hex(),'fixed qualified Regtest target required')
    require(case in NEGATIVE or case in POSITIVE,'fixed new AuxPoW property required')
    height=30 if case=='chain-branch-height-30' else 0
    branch=[i.to_bytes(32,'little') for i in range(1,height+1)]
    chain_nonce=7 if height else 0;chain_index=expected_index(chain_nonce,98,height)
    root=merkle(bytes.fromhex(block_hash)[::-1],branch,chain_index)[::-1]
    payload=root+(1<<height).to_bytes(4,'little')+chain_nonce.to_bytes(4,'little')
    script=b'\xfa\xbe\x6d\x6d'+payload
    if case=='duplicate-merged-headers':script+=b'\xfa\xbe\x6d\x6d'
    elif case=='displaced-merged-header':script=b'\xfa\xbe\x6d\x6d\x00'+payload
    elif case in ('legacy-root-offset-20','legacy-root-offset-21'):script=bytes(20 if case.endswith('20') else 21)+payload
    elif case=='missing-commitment-nonce':script=script[:-4]
    require(len(script)<253,'bounded direct fixture script length required')
    if case=='parent-no-inputs':tx=bytes.fromhex('01000000000000000000')
    else:tx=bytes.fromhex('0100000001')+bytes(32)+b'\xff'*4+bytes([len(script)])+script+b'\xff'*4+bytes(5)
    parent_height=31 if case=='parent-branch-height-31' else 1 if case=='parent-noncoinbase-index' else 0
    parent_branch=[i.to_bytes(32,'little') for i in range(1,parent_height+1)]
    parent_index=1 if case=='parent-noncoinbase-index' else 0
    parent_root=merkle(hash256(tx),parent_branch,parent_index)
    prefix=struct.pack('<I',1)+bytes(32)+parent_root+bytes(8)
    for nonce in range(MAX_PARENT_ATTEMPTS):
        header=prefix+struct.pack('<I',nonce)
        if int.from_bytes(scrypt_hash(header),'little')<=TARGET:break
    else:raise ValueError('bounded new parent-work search exhausted')
    parent_count=b'\xfd\x00\x00' if case=='noncanonical-parent-branch-count' else bytes([len(parent_branch)])
    proof=tx+hash256(header)[::-1]+parent_count+b''.join(parent_branch)+struct.pack('<I',parent_index)
    proof+=bytes([height])+b''.join(branch)+struct.pack('<I',chain_index)+header
    trailing=b'\x00GPUBNB-AUX-RPC' if case=='trailing-rpc-data' else b''
    proof+=trailing
    if case=='truncated-parent-header':proof=proof[:-1]
    require(0<len(proof)<=4096,'new AuxPoW proof byte bound')
    return {'case':case,'hex':proof.hex(),'sha256':hashlib.sha256(proof).hexdigest(),
        'childHash':block_hash,'expectedAccepted':case in POSITIVE,
        'expectationScope':NEGATIVE[case][0] if case in NEGATIVE else 'rpc-parser-normalization' if trailing else 'consensus',
        'expectedNativeReason':NEGATIVE[case][1] if case in NEGATIVE else None,'parentAttempts':nonce+1,
        'chainBranchLength':height,'chainIndex':chain_index,'parentBranchLength':len(parent_branch),
        'parentIndex':parent_index,'parentHeaderHex':header.hex(),'parentScriptHex':script.hex(),
        'submittedTrailingBytes':len(trailing)}

def run_expanded(c,directory,seed):
    rpc,wait,sync,peers=(c[x] for x in ('rpc','wait','sync','peers'))
    out,report,save=c['out'],c['report'],c['save']
    result={'requiredNewProperties':12,'cases':[],'tipStages':[],'previousEightControlsRepeated':False,
        'keysCreated':False,'transactionsSigned':0,'transactionsBroadcast':0,'qualificationStatus':'BLOCKED'}
    report['auxpowExpanded']=result;save();fixtures=[]
    c['import_chain'](Path(directory)/'public-chain.dat',seed['blocks'][-1],len(seed['blocks']))
    rpc('a','addnode','127.0.0.1:18445','onetry');wait('new AuxPoW private peers',lambda:peers('a') and peers('b'))
    def snapshot(label):
        rows=[]
        for node in ('a','b'):
            chain=rpc(node,'getblockchaininfo')
            rows.append({'chainId':'dogecoin','networkId':'regtest','sourceId':'doge-'+node,
                'tipHash':chain['bestblockhash'],'tipHeight':chain['blocks'],'observedAtUnixMs':int(time.time()*1000)})
        result['tipStages'].append({'label':label,'observations':rows});save();return rows
    initial=snapshot('before-probes')
    require(initial[0]['tipHash']==initial[1]['tipHash']==seed['blocks'][-1],'public seed did not converge')
    def template(node):
        value=rpc(node,'createauxblock',c['addresses'][node])
        require(value.get('chainid')==98 and value.get('target')==TARGET.to_bytes(32,'little').hex(),
                'fixed qualified AuxPoW template required')
        c['blocks'].add(value['hash']);return value
    templates={n:template(n) for n in ('a','b')}
    def register(node,t,case):
        item=fixture(t['hash'],t['target'],case);item['source']=node
        c['aux_submitted'].add((t['hash'],item['hex']))
        require(len(c['aux_submitted'])<=MAX_EXPANDED_PROOFS,'new proof registry budget exceeded')
        fixtures.append(item)
        (out/'auxpow-expanded-fixtures.json').write_text(json.dumps({'sourceCommit':report['manifest']['sourceCommit'],
            'network':'regtest','fixtures':fixtures},indent=2,sort_keys=True)+'\n')
        return item
    for case,(scope,reason) in NEGATIVE.items():
        observations=[]
        for node in ('a','b'):
            t=templates[node];item=register(node,t,case)
            before=rpc(node,'getblockchaininfo');log=out/f'daemon-{node}.log';offset=len(log.read_text())
            if scope=='rpc-deserialization':native=rpc(node,'submitauxblock',t['hash'],item['hex'],parser_reject=reason)
            else:
                native=rpc(node,'submitauxblock',t['hash'],item['hex'])
                require(native is False and reason in log.read_text()[offset:],'new native consensus reason missing')
            after=rpc(node,'getblockchaininfo')
            require(after['bestblockhash']==before['bestblockhash'] and after['blocks']==before['blocks'],
                    'rejected new proof changed native chain tip')
            observations.append({'source':node,'templateHash':t['hash'],'proofSha256':item['sha256'],
                'nativeResult':native,'nativeReason':reason,'unchangedTip':after['bestblockhash'],'height':after['blocks']})
        result['cases'].append({'case':case,'expectationScope':scope,'status':'PASS','observations':observations});save()
    snapshot('after-negative-probes');accepted=[]
    for case in POSITIVE:
        t=templates['a'] if not accepted else template('a');item=register('a',t,case)
        require(rpc('a','submitauxblock',t['hash'],item['hex']) is True,'native new valid boundary refused')
        tip=wait('valid new AuxPoW relay '+case,sync)
        require(tip['bestblockhash']==t['hash'],'native boundary relay identity differs')
        observed=[]
        for node in ('a','b'):
            block=rpc(node,'getblock',t['hash']);proof=block.get('auxpow')
            require(type(proof) is dict and block['hash']==t['hash'] and block['height']==t['height']
                    and block['version']&256 and block['version']>>16==98,'native new AuxPoW block absent')
            require(len(proof['chainmerklebranch'])==item['chainBranchLength']
                    and len(proof['merklebranch'])==item['parentBranchLength']
                    and proof['parentblock']==item['parentHeaderHex'],'native boundary proof fields changed')
            observed.append({'source':node,'hash':block['hash'],'height':block['height'],
                'chainBranchLength':len(proof['chainmerklebranch']),'parentBranchLength':len(proof['merklebranch'])})
        accepted.append(t['hash'])
        result['cases'].append({'case':case,'expectationScope':item['expectationScope'],'status':'PASS',
            'proofSha256':item['sha256'],'submittedTrailingBytes':item['submittedTrailingBytes'],
            'sameTemplateValidAfterNewRejections':len(accepted)==1,'nativeAcceptedBlocks':observed});save()
    snapshot('after-valid-boundaries')
    rpc('b','setnetworkactive','false');wait('boundary chain partition',lambda:not peers('a') and not peers('b'))
    rpc('b','invalidateblock',accepted[1]);winning=c['mine']('b',4);rpc('b','reconsiderblock',accepted[1])
    partition=snapshot('partitioned-boundary-chain')
    require(partition[0]['tipHash']!=partition[1]['tipHash'],'new boundary fork observations unexpectedly agree')
    rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry')
    final=wait('boundary AuxPoW longer branch relay',sync)
    require(final['bestblockhash']==winning[-1],'wrong winning AuxPoW fork')
    for node in ('a','b'):
        for old in accepted[1:]:require(rpc(node,'getblockheader',old)['confirmations']==-1,'boundary AuxPoW block not orphaned')
    snapshot('converged-boundary-reorg')
    result['boundaryBlockReorg']={'rollbackDepth':3,'winningBranchLength':4,'winningTip':winning[-1],
        'orphanedBoundaryBlocks':accepted[1:],'bothNativeNodesConverged':True,
        'temporaryLocalRollbackReconsideredBeforePeering':True}
    require(len(result['cases'])==12 and {x['case'] for x in result['cases']}==set(NEGATIVE)|set(POSITIVE),
            'new AuxPoW matrix incomplete')
    result['experimentStatus']='PASS';save()
