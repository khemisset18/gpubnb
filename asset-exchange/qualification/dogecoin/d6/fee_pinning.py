"""Fee/pinning scenarios inside the existing two-node private laboratory.

No entry point, daemon launcher or second executor. Reuses its D0 binaries,
RPC accounting, native consensus verifier, signer, codec and recovery package.
"""
from decimal import Decimal
import hashlib
import json
import time

from offline_candidate import build_candidate
from script_diagnostics import require, hash160
from test_signer import transaction, sighash, push, hash256

COIN=100_000_000
PRESSURE_COUNT=80
PRESSURE_OUTPUTS=1600
SCENARIOS={
    1:('pending-refund','mempool-policy/exchange-protocol'),
    2:('higher-fee-replacement','mempool-policy'),
    3:('lower-fee-replacement','mempool-policy'),
    4:('claim-conflict','mempool-policy/consensus'),
    5:('rising-minimum-while-waiting','mempool-policy'),
    6:('falling-minimum-while-waiting','mempool-policy/exchange-protocol'),
    7:('transaction-lost-from-mempool','mempool-policy/exchange-protocol'),
    8:('node-restart','mempool-policy/exchange-protocol'),
    9:('different-node-policies','mempool-policy'),
    10:('unconfirmed-parent-and-descendant','mempool-policy/exchange-protocol'),
    11:('deliberate-economic-pinning','mempool-policy'),
    12:('original-signing-keys-removed','exchange-protocol'),
    13:('presigned-coverage-exhausted','exchange-protocol'),
    14:('reorganisation-during-conflict','consensus/exchange-protocol'),
    15:('unauthorized-replacement-refused','exchange-protocol/mempool-policy'),
}


def _id(raw):return hash256(raw)[::-1].hex()


def _rate(value):
    amount=Decimal(str(value))*COIN
    require(amount.is_finite() and amount>=0 and amount==amount.to_integral_value(),'integer native fee rate required')
    return int(amount)


def run_fee_suite(c):
    rpc,submit,mine,tx,wait,sync,peers=(c[x] for x in ('rpc','submit','mine','tx','wait','sync','peers'))
    out,report,save=c['out'],c['report'],c['save']
    miner,_,claim,refund=c['signers']
    miner_script=b'\x76\xa9\x14'+hash160(miner.public)+b'\x88\xac'
    dest=b'\x76\xa9\x14'+hash160(refund.public)+b'\x88\xac'
    claim_dest=b'\x76\xa9\x14'+hash160(claim.public)+b'\x88\xac'
    result={'requiredScenarios':15,'cases':[],'qualificationStatus':'BLOCKED',
            'profileSequence':0xfffffffe,'nativeOptInControlSequence':0xfffffffd,
            'previousQualifiedSuiteRepeated':False,'pressureTransactionsSubmitted':0}
    report['feePinning']=result;save()
    def record(number,**details):
        require(number in SCENARIOS and all(r['id']!=number for r in result['cases']),'unique required scenario')
        name,scope=SCENARIOS[number]
        result['cases'].append({'id':number,'name':name,'expectationScope':scope,'status':'PASS',**details});save()
    rpc('a','addnode','127.0.0.1:18445','onetry')
    wait('fee-lab private peers',lambda:peers('a') and peers('b'))
    mine('a',1352);initial=wait('fee-lab initial relay',sync)
    require(initial['blocks']==1352,'unexpected fee-lab activation height')
    def coinbase(height):
        bh=rpc('a','getblockhash',str(height));c['blocks'].add(bh)
        tid=rpc('a','getblock',bh)['tx'][0];c['txids'].add(tid)
        row=tx('a',tid);v=row['vout'][0]
        require(v['scriptPubKey']['hex']==miner_script.hex(),'unexpected test coinbase script')
        return tid,_rate(v['value'])
    def p2pkh(prev,index,key,script,value,outs,sequence=0xfffffffe,limit=8):
        sig=key.sign(sighash(prev,index,script,outs,sequence=sequence,max_outputs=limit))
        raw=transaction(prev,index,push(sig)+push(key.public),outs,sequence=sequence,max_outputs=limit)
        require(c['verify'](script,raw)=={'result':1,'error':0,'flags':517},'native P2PKH fixture signature invalid')
        require(sum(v for v,_ in outs)<value,'positive bounded fixture fee required')
        return raw
    cb,value=coinbase(1);pcb,pvalue=coinbase(2)
    secret=hashlib.sha256(b'GPUbnb bounded fee matrix private Regtest 2026-11-11').digest()
    htlc=build_candidate(hashlib.sha256(secret).digest(),claim.public,refund.public,1355)
    outs=[(COIN,htlc.output)]*4+[(10*COIN,miner_script),(COIN,miner_script),(COIN,miner_script),
            (value-17*COIN,miner_script)]
    funding=p2pkh(cb,0,miner,miner_script,value,outs);fid=_id(funding)
    pressure_parent=p2pkh(pcb,0,miner,miner_script,pvalue,
        [(50*COIN,miner_script)]*PRESSURE_COUNT+[(pvalue-(50*PRESSURE_COUNT+1)*COIN,miner_script)],limit=PRESSURE_COUNT+1)
    pid=_id(pressure_parent)
    def htlc_spend(prev,index,key,branch,fee,sequence=0xfffffffe,value=COIN):
        lock=1355 if branch=='refund' else 0
        outputs=[(value-fee,dest if branch=='refund' else claim_dest)]
        sig=key.sign(sighash(prev,index,htlc.redeem,outputs,lock,sequence))
        ss=push(sig)+(b'\x00' if branch=='refund' else push(secret)+b'\x51')+push(htlc.redeem)
        raw=transaction(prev,index,ss,outputs,lock,sequence)
        require(c['verify'](htlc.output,raw)=={'result':1,'error':0,'flags':517},'native HTLC fixture signature invalid')
        return raw
    low=htlc_spend(fid,0,refund,'refund',100_000)
    lower=htlc_spend(fid,0,refund,'refund',50_000)
    high=htlc_spend(fid,0,refund,'refund',1_000_000)
    optlow=htlc_spend(fid,2,refund,'refund',1_000_000,0xfffffffd)
    optlower=htlc_spend(fid,2,refund,'refund',500_000,0xfffffffd)
    opthigh=htlc_spend(fid,2,refund,'refund',2_000_000,0xfffffffd)
    pinned_claim=htlc_spend(fid,1,claim,'claim',1_000_000)
    pinned_refund=htlc_spend(fid,1,refund,'refund',2_000_000)
    parent=p2pkh(fid,4,miner,miner_script,10*COIN,[(10*COIN-1_000_000,claim_dest)],0xfffffffd)
    child=p2pkh(_id(parent),0,claim,claim_dest,10*COIN-1_000_000,[(10*COIN-21_000_000,dest)])
    parent_cheap=p2pkh(fid,4,miner,miner_script,10*COIN,[(10*COIN-2_000_000,claim_dest)],0xfffffffd)
    parent_high=p2pkh(fid,4,miner,miner_script,10*COIN,[(10*COIN-30_000_000,claim_dest)],0xfffffffd)
    unconfirmed=p2pkh(fid,5,miner,miner_script,COIN,[(COIN-1_000_000,htlc.output)])
    unconfirmed_refund=htlc_spend(_id(unconfirmed),0,refund,'refund',1_000_000,value=COIN-1_000_000)
    pressure=[]
    for index in range(PRESSURE_COUNT):
        outputs=[(1_000_000,miner_script)]*PRESSURE_OUTPUTS
        outputs.append((50*COIN-PRESSURE_OUTPUTS*1_000_000-COIN,miner_script))
        raw=p2pkh(pid,index,miner,miner_script,50*COIN,outputs,limit=1601)
        require(len(raw)<=60000,'private pressure transaction exceeds CLI/fixture bound');pressure.append(raw)
    prepared=[funding,pressure_parent,low,lower,high,optlow,optlower,opthigh,pinned_claim,pinned_refund,
              parent,child,parent_cheap,parent_high,unconfirmed,unconfirmed_refund,*pressure]
    require(len(prepared)<=96 and len({_id(x) for x in prepared})==len(prepared),'bounded distinct prepared fixtures required')
    c['submitted'].update(x.hex() for x in prepared);c['txids'].update(_id(x) for x in prepared)
    result['preparedFixtureSha256']={_id(x):hashlib.sha256(x).hexdigest() for x in prepared}
    def bundle(raw_funding,vout,amount,variants,cap):
        entries=[]
        for raw,fee in variants:
            entries.append({'transactionHex':raw.hex(),'sha256':hashlib.sha256(raw).hexdigest(),
                'txid':_id(raw),'destinationHex':dest.hex(),'outputValueKoinu':str(amount-fee),
                'feeKoinu':str(fee),'lockTime':1355,'sequence':0xfffffffe})
        return {'domain':'GPUBNB:DOGE:RECOVERY:v1','schemaVersion':1,'network':'regtest',
            'genesis':report['initialIdentities']['a']['genesis'],'sourceCommit':report['manifest']['sourceCommit'],
            'contract':{'redeemHex':htlc.redeem.hex(),'outputHex':htlc.output.hex()},
            'funding':{'txid':_id(raw_funding),'vout':vout,'valueKoinu':str(amount),'transactionHex':raw_funding.hex()},
            'policy':{'maxFeeKoinu':str(cap),'minRefundKoinu':str(amount-cap)},'refunds':entries}
    main=bundle(funding,0,COIN,[(low,100_000),(high,1_000_000)],1_000_000)
    capped=bundle(funding,0,COIN,[(low,100_000)],100_000)
    unfunded=bundle(unconfirmed,0,COIN-1_000_000,[(unconfirmed_refund,1_000_000)],1_000_000)
    require(c['bundle_validator'] is not None,'pre-lock semantic validator required')
    receipts={}
    for label,b in [('main',main),('cap',capped),('parent',unfunded)]:
        c['bundle_validator'](b);path=out/('fee-bundle-'+label+'.json')
        receipts[label]=(path,c['persist_bundle'](path,b))
    unauthorized=bundle(funding,2,COIN,[(optlow,1_000_000)],1_000_000)
    unauthorized['refunds'][0]['sequence']=0xfffffffd
    try:c['bundle_validator'](unauthorized)
    except ValueError as error:unauthorized_reason=str(error)
    else:raise ValueError('unauthorized opt-in profile accepted by Exchange policy')
    c['destroy_keys']();require(not list(c['keys'].iterdir()),'original signing keys survived preparation')
    result['keysRemovedBeforeFunding']=True;result['preLockBundleDigests']={k:v[1] for k,v in receipts.items()};save()
    submit('a',funding);submit('a',pressure_parent)
    wait('private funding relay',lambda:_id(funding) in rpc('b','getrawmempool'))
    mine('a');mine('a',2);wait('mature fee funding relay',sync)
    for n in ('a','b'):require(tx(n,fid)['confirmations']==3,'funding confirmation mismatch')
    rpc('b','setnetworkactive','false');wait('fee partition',lambda:not peers('a') and not peers('b'))
    def recover(label='main',mode='rebroadcast',error=None):
        path,digest=receipts[label]
        context={'bundlePath':str(path),'bundleSha256':digest,'mode':mode,'labLabel':'fees-'+label}
        if error is not None:context['expectedError']=error
        return c['recover'](context)
    first=recover();require(first['state']=='PENDING' and first['txid']==_id(low),'initial keyless refund not pending')
    repeated=recover();require(repeated['txid']==_id(low),'same pending refund changed on retry')
    record(1,txid=_id(low),identicalPendingRetry=True)
    reject_high=submit('a',high,reject='txn-mempool-conflict')
    reject_low=submit('a',lower,reject='txn-mempool-conflict')
    record(2,nonOptInNativeRejection=reject_high)
    record(3,nonOptInNativeRejection=reject_low)
    c['restart']('a');wait('normal restart mempool restoration',lambda:_id(low) in rpc('a','getrawmempool'))
    restored=recover(mode='observe');require(restored['state']=='PENDING','standalone observation failed after RPC cookie rotation')
    record(8,normalRestartReloadedSameTxid=True,standaloneRpcReauthenticated=True)
    c['restart']('a',True);require(_id(low) not in rpc('a','getrawmempool'),'withheld private dump unexpectedly loaded')
    lost=recover(mode='observe');require(lost['state']=='UTXO_AVAILABLE','lost mempool transaction hid confirmed funding')
    record(7,incident='Only the disposable test node mempool dump was withheld after a clean stop',
           chainAndFundingPreserved=True,standaloneState=lost['state'])
    submit('a',optlow);submit('b',optlow)
    opt_lower_reject=submit('a',optlower,reject='insufficient fee')
    submit('a',opthigh);opt_b_reject=submit('b',opthigh,reject='txn-mempool-conflict')
    require(_id(opthigh) in rpc('a','getrawmempool') and _id(optlow) in rpc('b','getrawmempool'),
            'native opt-in policy differential missing')
    record(9,aOptInReplacementAccepted=True,bReplacementDisabledRejection=opt_b_reject,
           lowerOptInFeeRejected=opt_lower_reject,policyIsNotConsensus=True)
    record(15,exchangeRejectedUnauthorizedSequence=unauthorized_reason,
           productionSequence=0xfffffffe,automaticReplacementAttempted=False,nativeNonOptInRejection=reject_high)
    submit('a',parent);submit('a',child)
    graph_reject=submit('a',parent_cheap,reject='insufficient fee')
    parent_entry=rpc('a','getmempoolentry',_id(parent));child_entry=rpc('a','getmempoolentry',_id(child))
    require(_rate(parent_entry['fee'])==1_000_000 and _rate(child_entry['fee'])==20_000_000,'native descendant fee mismatch')
    submit('a',parent_high);pool=rpc('a','getrawmempool')
    require(_id(parent) not in pool and _id(child) not in pool and _id(parent_high) in pool,'native descendant removal mismatch')
    record(11,attack='Valid pre-signed high-fee descendant makes a small parent fee bump uneconomic',
           parentFeeKoinu='1000000',childFeeKoinu='20000000',smallBumpRejection=graph_reject,
           separatelyAuthorizedDiagnosticReplacementFeeKoinu='30000000',oldParentAndChildEvicted=True,
           productionRefundFeeCapUnchanged=True)
    submit('a',unconfirmed)
    refused=recover('parent',error='funding unavailable or ambiguous; no broadcast')
    require(not any(x['method']=='sendrawtransaction' for x in refused['rpcCalls']),'unconfirmed funding recovery broadcast')
    submit('a',unconfirmed_refund)
    require(_id(unconfirmed) in rpc('a','getrawmempool') and _id(unconfirmed_refund) in rpc('a','getrawmempool'),
            'native unconfirmed parent/descendant absent')
    record(10,nativeParentAndChildAdmitted=True,exchangeRecoveryRefusedUnconfirmedFunding=True,
           protocolRefusal=refused['expectedRefusal'])
    submit('a',pinned_claim);claim_reject=submit('a',pinned_refund,reject='txn-mempool-conflict')
    submit('b',pinned_refund)
    record(4,validClaimFirstSeenOnA=True,refundRejectedOnA=claim_reject,validRefundAdmittedOnB=True)
    mine('a');mine('b',4)
    def snapshot(label,tid,competitor=None):
        rows=[]
        for n in ('a','b'):
            chain=rpc(n,'getblockchaininfo');observed=tx(n,tid);pool=rpc(n,'getrawmempool')
            competing=None
            if competitor:
                other=tx(n,competitor)
                if other and other.get('confirmations',0)>0:
                    require(other['vin'][0]['txid']==fid and other['vin'][0]['vout']==1,'conflict outpoint mismatch')
                    competing=competitor
            row=c['normalize'](n,chain,observed,tid in pool,competing);row['observedTxid']=tid;rows.append(row)
        report['stages'].append({'label':label,'observations':rows});save();return rows
    partition=snapshot('partitioned_claim',_id(pinned_claim))
    require(partition[0]['tipHash']!=partition[1]['tipHash'],'conflict fork tips equal')
    rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry')
    winning=wait('conflict longer branch relay',sync)
    for n in ('a','b'):
        require(tx(n,_id(pinned_refund))['confirmations']==4,'winning refund not independently confirmed')
        old=tx(n,_id(pinned_claim));require(old is None or old.get('confirmations',0)==0,'orphaned claim remains confirmed')
    snapshot('reorged_claim',_id(pinned_claim),_id(pinned_refund));snapshot('converged_refund',_id(pinned_refund))
    record(14,rollbackDepth=1,winningBranchLength=4,winningTip=winning['bestblockhash'],bothNodesConfirmedRefund=True)
    rpc('b','setnetworkactive','false');wait('pressure partition',lambda:not peers('a') and not peers('b'))
    again=recover();require(again['txid']==_id(low) and again['state']=='PENDING','lost refund could not be retransmitted')
    before=rpc('a','getmempoolinfo');required_rate=100_000*1000//len(low)
    result['pressureBefore']=before;result['pressureObservations']=[]
    pressure_after=None
    for raw in pressure:
        submit('a',raw);result['pressureTransactionsSubmitted']+=1
        info=rpc('a','getmempoolinfo')
        result['pressureObservations'].append(info)
        if _rate(info['mempoolminfee'])>required_rate and _id(low) not in rpc('a','getrawmempool'):
            pressure_after=info;break
    require(pressure_after is not None,'bounded native pressure did not raise the floor and evict the refund')
    native_floor_reject=submit('a',low,reject='mempool min fee not met')
    record(5,pendingRefundEvictedByActualBoundedPressure=True,before=before,after=pressure_after,
           lowFeeReadmissionRejected=native_floor_reject,pressureTransactions=result['pressureTransactionsSubmitted'])
    exhausted=recover('cap',error='no pre-signed refund covers current fee floor; signatory or new authorization required')
    require(not any(x['method']=='sendrawtransaction' for x in exhausted['rpcCalls']),'exhausted ladder attempted a broadcast')
    record(13,capKoinu='100000',nativeObservedFeeFloor=pressure_after['mempoolminfee'],
           exactProtocolRefusal=exhausted['expectedRefusal'],broadcastCalls=0,newSignatureCreated=False)
    adequate=recover();require(adequate['state']=='PENDING' and adequate['txid']==_id(high)
        and adequate['selectedFeeKoinu']=='1000000','keyless recovery failed after actual eviction')
    record(12,keysUnavailable=not list(c['keys'].iterdir()),selectedAlreadySignedFeeKoinu='1000000',
           retainedKoinu='99000000',originalKeyReacquisition=False)
    # A block from the isolated peer leaves this pending refund unmined, while
    # enabling the native rolling-fee decay. Six hours is below mempool expiry.
    empty_block=mine('b')[0]
    require(_id(high) not in rpc('b','getblock',empty_block)['tx'],'control peer unexpectedly mined pending refund')
    rpc('b','setnetworkactive','true');rpc('a','addnode','127.0.0.1:18445','onetry');wait('fee-decay block relay',sync)
    pending_before=rpc('a','getmempoolentry',_id(high));floor_before=rpc('a','getmempoolinfo')
    mock=int(time.time())+21600;c['mocktimes'].add(str(mock))
    for n in ('a','b'):rpc(n,'setmocktime',str(mock))
    floor_after=rpc('a','getmempoolinfo');pending_after=rpc('a','getmempoolentry',_id(high))
    require(_rate(floor_after['mempoolminfee'])<_rate(floor_before['mempoolminfee']),'native fee floor did not decay')
    same=recover();require(same['txid']==_id(high) and same['selectedFeeKoinu']=='1000000','falling floor changed pending bytes')
    record(6,nativeRegtestClockAdvanceSeconds=21600,realWallTimeWaitClaimed=False,
           floorBefore=floor_before,floorAfter=floor_after,samePendingTxid=_id(high),sameSignedBytes=True,
           beforeEntry=pending_before,afterEntry=pending_after)
    mine('a');wait('keyless refund block relay',sync)
    for n in ('a','b'):
        native=tx(n,_id(high));require(native['confirmations']==1 and _rate(native['vout'][0]['value'])==99_000_000
            and native['vout'][0]['scriptPubKey']['hex']==dest.hex(),'final native refund mismatch')
    snapshot('recovery_refund_confirmed',_id(high))
    confirmed=recover();require(confirmed['action']=='ALREADY_CONFIRMED','confirmed refund retry was not idempotent')
    require(not any(x['method']=='sendrawtransaction' for x in confirmed['rpcCalls']),'confirmed refund rebroadcast')
    result['confirmedDuplicateAttempt']={'action':confirmed['action'],'broadcastCalls':0}
    require({r['id'] for r in result['cases']}==set(SCENARIOS),'required fee scenarios incomplete')
    result['cases'].sort(key=lambda x:x['id']);result.update(status='PASS',passed=15,failed=0,skipped=0)
    save()
