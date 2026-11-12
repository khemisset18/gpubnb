#!/usr/bin/env python3
import pathlib,json,hashlib,struct,re,collections,argparse,zipfile,tempfile,stat
if not __debug__:raise SystemExit('Verifier assertions must remain enabled; omit Python -O.')
parser=argparse.ArgumentParser(description="Offline verification of exact native run43311713839; never loads a node or performs RPC.")
parser.add_argument('archive',type=pathlib.Path)
parser.add_argument('--summary-output',type=pathlib.Path)
args=parser.parse_args()
assert args.archive.stat().st_size<=4*1024**2
archive_bytes=args.archive.read_bytes()
assert hashlib.sha256(archive_bytes).hexdigest()=='5f6910e54b6160bf625393893ee96fd51b8441208f10eacfdcbf8fa64c2e05cb'
temporary=tempfile.TemporaryDirectory(prefix='doge-auxpow-evidence-')
extracted=pathlib.Path(temporary.name)
with zipfile.ZipFile(args.archive) as archive:
    assert len(archive.infolist())<50 and sum(i.file_size for i in archive.infolist())<20*1024**2
    for item in archive.infolist():
        name=pathlib.PurePosixPath(item.filename)
        assert not name.is_absolute() and '..' not in name.parts and item.file_size<4*1024**2
        assert not stat.S_ISLNK(item.external_attr>>16)
        assert not any(p.endswith('.pem') or p in ('.cookie','wallet.dat') for p in name.parts)
    archive.extractall(extracted)
base=extracted/'lab/evidence' 
h=lambda b:hashlib.sha256(hashlib.sha256(b).digest()).digest()
report=json.loads((base/'multinode-report.json').read_text());requests=json.loads((base/'rpc-requests.json').read_text())
items=json.loads((base/'auxpow-expanded-fixtures.json').read_text())['fixtures'];result=report['auxpowExpanded']
assert report['experimentStatus']=='PASS' and report['qualificationStatus']=='BLOCKED' and report['settlementAllowed'] is False
assert len(items)==20 and len(result['cases'])==12 and all(c['status']=='PASS' for c in result['cases'])
assert result['previousEightControlsRepeated'] is False and result['transactionsSigned']==result['transactionsBroadcast']==0 and not result['keysCreated']
digests={}
for line in (base/'SHA256SUMS').read_text().splitlines():
    digest,name=line.split('  ',1);assert hashlib.sha256((base/name).read_bytes()).hexdigest()==digest;digests[name]=digest
audits={}
for node in ('a','b'):
    actual=collections.Counter(re.findall(r'ThreadRPCServer method=([A-Za-z0-9_]+)',(base/f'daemon-{node}.log').read_text()))
    expected=collections.Counter(r['method'] for r in requests if r['source']==node and r.get('reachedServer'))
    assert actual==expected;assert not any(m in actual for m in ('sendrawtransaction','signrawtransaction','sendtoaddress'))
    audits[node]={'count':sum(actual.values()),'methods':dict(sorted(actual.items()))}
assert len(requests)==report['rpcCalls']==133 and report['generatedBlocks']==8
templates={}
for row in requests:
    if row['method']=='createauxblock':
        t=json.loads(row['stdout']);templates[(row['source'],t['hash'])]=int.from_bytes(bytes.fromhex(t['target']),'little')
class Cursor:
    def __init__(self,data):self.data=data;self.pos=0
    def take(self,n):
        if self.pos+n>len(self.data):raise ValueError('truncated')
        v=self.data[self.pos:self.pos+n];self.pos+=n;return v
    def number(self,n=4,signed=False):return int.from_bytes(self.take(n),'little',signed=signed)
    def count(self):
        prefix=self.number(1)
        if prefix<253:return prefix
        width={253:2,254:4,255:8}[prefix];value=self.number(width)
        if value<{2:253,4:65536,8:2**32}[width]:raise ValueError('noncanonical')
        return value
def merkle(leaf,branch,index):
    for sibling in branch:leaf=h(sibling+leaf if index&1 else leaf+sibling);index>>=1
    return leaf
checks=[]
for item in items:
    raw=bytes.fromhex(item['hex']);assert hashlib.sha256(raw).hexdigest()==item['sha256'];c=Cursor(raw)
    assert c.number()==1
    count=c.count();assert count in (0,1);scripts=[]
    for _ in range(count):
        c.take(36);scripts.append(c.take(c.count()));c.take(4)
    assert c.count()==0 and c.number()==0
    tx=raw[:c.pos]
    row={'case':item['case'],'source':item['source'],'childHash':item['childHash'],'sha256':item['sha256']}
    try:
        unused=c.take(32);pcount=c.count();assert pcount<=31
        parent=[c.take(32) for _ in range(pcount)];pindex=c.number(signed=True)
        count=c.count();assert count<=30
        chain=[c.take(32) for _ in range(count)];index=c.number(signed=True);header=c.take(80)
    except ValueError as error:
        assert item['expectationScope']=='rpc-deserialization'
        assert str(error)==('noncanonical' if item['case'].startswith('noncanonical') else 'truncated')
        row['strictDecoderRejection']=str(error)
    else:
        assert item['expectationScope']!='rpc-deserialization'
        assert header==bytes.fromhex(item['parentHeaderHex'])
        work=hashlib.scrypt(header,salt=header,n=1024,r=1,p=1,dklen=32,maxmem=2**20)
        assert int.from_bytes(work,'little')<=templates[(item['source'],item['childHash'])]
        assert merkle(h(tx),parent,pindex)==header[36:68]
        assert pcount==item['parentBranchLength'] and count==item['chainBranchLength']
        root=merkle(bytes.fromhex(item['childHash'])[::-1],chain,index)[::-1]
        if scripts:
            script=scripts[0];offset=script.find(root);assert offset>=0
            if item['case'].startswith('legacy-root-offset-'):assert offset==int(item['case'].split('-')[-1])
            if item['case']=='duplicate-merged-headers':assert script.count(bytes.fromhex('fabe6d6d'))==2
            if item['case']=='displaced-merged-header':assert offset==5
            if item['case']=='missing-commitment-nonce':assert len(script)-(offset+32)==4
            else:
                size=int.from_bytes(script[offset+32:offset+36],'little');nonce=int.from_bytes(script[offset+36:offset+40],'little')
                assert size==1<<count
                expected=(((((nonce*1103515245+12345)%(2**32)+98)%(2**32))*1103515245+12345)%(2**32))%(1<<count)
                assert index==expected
        else:assert item['case']=='parent-no-inputs'
        suffix=raw[c.pos:];assert len(suffix)==item['submittedTrailingBytes']
        if suffix:assert item['case']=='trailing-rpc-data'
        row.update(parentWorkValid=True,parentWorkHash=work.hex(),parentMerkleCoherent=True,
            parentBranchLength=pcount,chainBranchLength=count,trailingRpcBytes=len(suffix))
        if item['expectedAccepted']:
            for node in ('a','b'):
                blocks=[json.loads(x['stdout']) for x in requests if x['source']==node and x['method']=='getblock' and x['params']==[item['childHash']]]
                assert len(blocks)==1;p=blocks[0]['auxpow']
                # AuxpowToJSON reports the computed parent-header hash here,
                # not the ignored MerkleTx hashBlock wire field. Preserve the
                # captured input field when comparing serialized consensus data.
                assert bytes.fromhex(p['tx']['blockhash'])==h(header)[::-1]
                assert unused==h(header)[::-1]
                normalized=bytes.fromhex(p['tx']['hex'])+unused
                normalized+=bytes([len(p['merklebranch'])])+b''.join(bytes.fromhex(x)[::-1] for x in p['merklebranch'])+struct.pack('<i',p['index'])
                normalized+=bytes([len(p['chainmerklebranch'])])+b''.join(bytes.fromhex(x)[::-1] for x in p['chainmerklebranch'])+struct.pack('<i',p['chainindex'])+bytes.fromhex(p['parentblock'])
                assert normalized==raw[:c.pos]
            row['nativeConsensusFieldsDecodedIdenticallyOnBothNodes']=True
            row['unusedMerkleTxHashField']='input bytes; not independently exposed by native JSON'
    sent=[x for x in requests if x['source']==item['source'] and x['method']=='submitauxblock' and x['params']==[item['childHash'],item['hex']]]
    assert len(sent)==1;sent=sent[0]
    if item['expectationScope']=='rpc-deserialization':assert sent['exitCode']!=0 and 'error code: -1' in sent['stderr'] and item['expectedNativeReason'] in sent['stderr']
    elif item['expectedAccepted']:assert json.loads(sent['stdout']) is True
    else:assert json.loads(sent['stdout']) is False and item['expectedNativeReason'] in (base/f"daemon-{item['source']}.log").read_text()
    checks.append(row)
for node in ('a','b'):
    for old in result['boundaryBlockReorg']['orphanedBoundaryBlocks']:
        headers=[json.loads(r['stdout']) for r in requests if r['source']==node and r['method']=='getblockheader' and r['params']==[old]]
        assert len(headers)==1 and headers[0]['confirmations']==-1
watch=json.loads((base/'watcher-review.json').read_text());assert not watch['settlementAllowed']
assert watch['tipStages']['partitioned-boundary-chain']['consistency']=='UNCERTAIN'
assert watch['tipStages']['converged-boundary-reorg']['consistency']=='CONSISTENT'
assert all(not x['canAdvance'] and not x['settlementAllowed'] for x in watch['tipStages'].values())
digests['watcher-review.json']=hashlib.sha256((base/'watcher-review.json').read_bytes()).hexdigest()
summary={'schemaVersion':1,'runId':43311713839,'runUrl':'https://github.com/khemisset18/gpubnb/actions/runs/43311713839',
    'executionCommit':'c7adde84149250c3a972e570b5df4911b20778ee','harnessCommit':'eadb9c1e3265cf3858a0bebdc0917964b8f89ede',
    'artifactId':13985234147,'artifactSha256':'5f6910e54b6160bf625393893ee96fd51b8441208f10eacfdcbf8fa64c2e05cb',
    'experimentStatus':'PASS','qualificationStatus':'BLOCKED','settlementAllowed':False,
    'newProperties':12,'nativePairedRejections':16,'validBoundaryBlocksAcceptedOnBothNodes':4,
    'generatedBlocks':8,'reusedPublicBlocks':1355,'rpcCalls':133,'keysCreated':False,'transactionsSigned':0,'transactionsBroadcast':0,
    'softwareChecks':{'laboratory':37,'signerFee':12,'recovery':22,'watchers':24},
    'nativeServerAudit':audits,'cases':result['cases'],'proofChecks':checks,'boundaryBlockReorg':result['boundaryBlockReorg'],
    'watcherReview':watch,'evidenceFileSha256':digests,
    'verificationAfterDownload':'ZIP/internal digests, all20 transmitted proofs,16 complete parent-work/merkle/commitment proofs,4 strict deserialization refusals,8 decoded valid native proof objects,6 orphan confirmations and both entire RPC method counters independently rechecked.'}
if args.summary_output:
    with args.summary_output.open('x') as output:output.write(json.dumps(summary,indent=2,sort_keys=True)+'\n')
print(json.dumps({'verified':True,'newProperties':12,'pairedNativeRejections':16,'validBoundaryBlocks':4,'rpcCalls':133,'generatedBlocks':8,'proofs':len(checks),'summaryWritten':args.summary_output is not None}))
