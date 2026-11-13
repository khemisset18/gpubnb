"""One keyless funding-reorg regression inside the existing private executor.

Uses pinned public signatures/history; no launcher, signer, wallet or old code.
"""
import hashlib
from pathlib import Path
from decimal import Decimal
from script_diagnostics import require
from test_signer import hash256
from recovery_core import load_bundle,read_regular

# invalidateblock retains the higher header. The existing header-lead guard
# therefore refuses before the new funding guard; do not weaken or reorder it.
REFUSAL='node has an unresolved header lead; no broadcast'


def run_funding_reorg(c,directory,seed):
    root=Path(directory);rpc=c['rpc'];report=c['report'];save=c['save']
    require(not list(c['keys'].iterdir()),'funding reorg cannot create signing keys')
    path=root/'bundle-parent.json';digest=seed['bundleDigests']['parent']
    require(hashlib.sha256(read_regular(path)).hexdigest()==seed['files']['bundle-parent.json']==digest,
            'retained public recovery receipt mismatch')
    bundle=load_bundle(path,digest)
    require(len(bundle['refunds'])==1 and bundle['policy']['maxFeeKoinu']=='1000000',
            'fixed prior synthetic refund ladder required')
    funding=bundle['funding'];fid=funding['txid'];refund=bundle['refunds'][0];tid=refund['txid']
    require(funding['valueKoinu']=='99000000' and refund['feeKoinu']=='1000000'
            and refund['outputValueKoinu']=='98000000','fixed prior synthetic values required')
    for entry in [funding,refund]:
        raw=bytes.fromhex(entry['transactionHex']);txid=hash256(raw)[::-1].hex()
        require(txid==entry['txid'] and hashlib.sha256(raw).hexdigest()==seed['preparedFixtureSha256'][txid],
                'retained synthetic transaction identity mismatch')
        c['txids'].add(txid);c['submitted'].add(entry['transactionHex'])
    c['blocks'].update(seed['blocks'])
    result={'cases':[],'keysCreated':0,'transactionsSigned':0,'retainedBundleSha256':digest,
        'refundTxid':tid,'refundSha256':refund['sha256'],'retainedKoinu':'98000000','feeKoinu':'1000000',
        'previousNativeSuitesRepeated':False,'newFundingGuardIsolatedNatively':False,
        'qualificationStatus':'BLOCKED'}
    report['fundingReorg']=result;save()
    c['import_chain'](root/'public-chain.dat',seed['blocks'][-1],len(seed['blocks']))
    rpc('a','addnode','127.0.0.1:18445','onetry')
    c['wait']('funding regression peers',lambda:c['peers']('a') and c['peers']('b'))
    result['seedInitialBlockDownload']={node:rpc(node,'getblockchaininfo')['initialblockdownload']
                                       for node in ('a','b')}
    # Fund only after CLTV1355 is reached, so rollback does not independently
    # evict the refund for nonfinality and hide the funding-confirmation defect.
    c['submit']('a',bytes.fromhex(funding['transactionHex']))
    # A retained chain can be older than native nMaxTipAge: nodes in initial
    # download do not request transaction inventory. Mine the already-budgeted
    # funding block first; ordinary block relay exits IBD on both nodes.
    c['mine']('a');c['wait']('new funding confirmation',c['sync'])
    require(all(rpc(node,'getblockchaininfo')['initialblockdownload'] is False for node in ('a','b')),
            'fresh funding block did not exit initial block download')
    result['fundingBlockExitedInitialDownload']=True;save()
    c['submit']('a',bytes.fromhex(refund['transactionHex']))
    c['wait']('existing refund relay',lambda:tid in rpc('b','getrawmempool'))

    def recover(mode='observe',source='a',error=None):
        context={'bundlePath':str(path),'bundleSha256':digest,'mode':mode,'source':source,'labLabel':'funding-reorg'}
        if error:context['expectedError']=error
        return c['recover'](context)

    def snapshot(label):
        rows=[]
        for node in ('a','b'):
            chain=rpc(node,'getblockchaininfo');value=c['tx'](node,tid)
            pool=rpc(node,'getrawmempool')
            rows.append(c['normalize'](node,chain,value,tid in pool))
        report['stages'].append({'label':label,'observations':rows});save()

    before=recover()
    require(before['state']=='PENDING' and before['fundingConfirmed'] is True,'confirmed funding baseline missing')
    first=c['tx']('a',fid);funding_block=first['blockhash'];header=rpc('a','getblockheader',funding_block)
    require(header['height']==1356 and first['confirmations']==1,'exact funding reorg anchor required')
    require(c['tx']('b',fid)['confirmations']==1,'second node funding anchor mismatch')
    snapshot('pending-confirmed-funding')
    rpc('b','setnetworkactive','false')
    c['wait']('funding rollback partition',lambda:not c['peers']('a') and not c['peers']('b'))
    rpc('a','invalidateblock',funding_block)
    rolled_chain=rpc('a','getblockchaininfo')
    require(rolled_chain['blocks']==1355 and rolled_chain['headers']==1356,
            'native funding rollback/header lead differs')
    pool=rpc('a','getrawmempool')
    require(fid in pool and tid in pool,'native parent and refund did not both return to mempool')
    require(c['tx']('a',fid).get('confirmations',0)==0 and c['tx']('a',tid).get('confirmations',0)==0,
            'native rolled-back parent/refund is still confirmed')
    pending=recover()
    require(pending['state']=='PENDING' and pending['fundingConfirmed'] is False,'pending funding-reorg observation missing')
    refused=recover('rebroadcast',error=REFUSAL)
    require(refused['expectedRefusal']==REFUSAL
            and not any(row['method']=='sendrawtransaction' for row in refused['rpcCalls']),
            'unconfirmed funding retry was not refused before broadcast')
    result['cases'].append({'id':'pending-refund-after-funding-reorg','status':'PASS',
        'expectationScope':'exchange-protocol','fundingBlock':funding_block,'rollbackDepth':1,
        'nativeParentAndRefundPending':True,'nativeHeaders':1356,'nativeActiveBlocks':1355,
        'standaloneRefusal':REFUSAL,'refusalBroadcasts':0,'preexistingHeaderGuardRefusedFirst':True})
    snapshot('funding-rolled-back')
    rpc('a','reconsiderblock',funding_block);c['wait']('funding anchor restored',c['sync'])
    require(c['tx']('a',fid)['confirmations']==1 and tid in rpc('a','getrawmempool'),
            'restored funding did not retain pending signed refund')
    restored=recover('rebroadcast')
    broadcasts=[x['params'][0] for x in restored['rpcCalls'] if x['method']=='sendrawtransaction']
    require(restored['state']=='PENDING' and restored['fundingConfirmed'] is True
            and restored['txid']==tid and broadcasts==[refund['transactionHex']],
            'restored recovery did not retransmit the exact existing signature')
    snapshot('funding-restored')
    rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry')
    c['wait']('funding restore peers',lambda:c['peers']('a') and c['peers']('b'))
    c['mine']('a');c['wait']('refund confirmation relay',c['sync'])
    for node in ('a','b'):
        native=c['tx'](node,tid)
        require(native['confirmations']==1 and native['hex']==refund['transactionHex']
                and len(native['vout'])==1
                and Decimal(str(native['vout'][0]['value']))*100_000_000==98_000_000
                and native['vout'][0]['scriptPubKey']['hex']==refund['destinationHex'],
                'native restored refund bytes/value/destination mismatch')
        final=recover(source=node)
        require(final['state']=='CONFIRMED' and final['fundingConfirmed'] is True,'standalone confirmed anchor missing')
    result['cases'].append({'id':'same-refund-after-funding-restoration','status':'PASS',
        'expectationScope':'exchange-protocol/native-chain','identicalPendingBytesRebroadcast':True,
        'bothNodesConfirmed':True,'refundTxid':tid,'retainedKoinu':'98000000','feeKoinu':'1000000'})
    snapshot('refund-confirmed')
    require(not list(c['keys'].iterdir()),'signing key residue in keyless regression')
    save()
