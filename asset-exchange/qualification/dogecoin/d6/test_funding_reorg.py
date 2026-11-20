import ast
import json
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import multinode
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'recovery'/'dogecoin'))
import funding_reorg


def route(expression,**values):
    for old,new in [('github.event_name','event'),('inputs.doge_suite','suite'),('inputs.lab_suite','suite'),
        ('github.repository_id','repo_id'),('github.repository','repo'),('github.ref','ref')]:
        expression=expression.replace(old,new)
    tree=ast.parse(expression.replace('&&',' and ').replace('||',' or '),mode='eval')
    allowed=(ast.Expression,ast.BoolOp,ast.And,ast.Or,ast.Compare,ast.Eq,ast.NotEq,ast.Name,ast.Load,ast.Constant)
    if any(not isinstance(n,allowed) or isinstance(n,ast.Name) and n.id not in values for n in ast.walk(tree)):
        raise ValueError('unsupported route expression')
    return eval(compile(tree,'<manual-route>','eval'),{'__builtins__':{}},values)


def job_condition(text,job):
    section=text.split('\n  '+job+':\n',1)[1].split('\n  ',1)[0]
    return re.search(r'^    if: (.+)$',section,re.M)[1]


class FundingReorgBoundaries(unittest.TestCase):
    def test_manual_route_matrix_is_closed_for_all_existing_modes(self):
        root=Path(__file__).resolve().parents[4]
        text=(root/'.github/workflows/workspace-reliability.yml').read_text()
        jobs=['doge-d3-private-manual','doge-recovery-multinode-private-manual',
              'doge-source-audit-manual','doge-recovery-consistency-private-manual']
        expressions={job:job_condition(text,job) for job in jobs}
        branches={'base':'asset-exchange/doge-independent-recovery-20261111',
            'fee':'asset-exchange/doge-fee-pinning-20261111','vm':'asset-exchange/doge-vm-recovery-20261111',
            'aux':'asset-exchange/doge-auxpow-boundaries-20261111','audit':'asset-exchange/doge-audit-candidate-20261112',
            'funding':'asset-exchange/doge-recovery-consistency-20261112','main':'main','dev':'dev'}
        expected={('base','both'):{jobs[0],jobs[1]},('base','d3'):{jobs[0]},('base','multinode'):{jobs[1]},
            ('fee','fee-pinning'):{jobs[1]},('vm','vm-recovery'):{jobs[1]},('aux','auxpow-expanded'):{jobs[1]},
            ('audit','source-audit'):{jobs[2]},('funding','recovery-consistency'):{jobs[3]}}
        for event in ['workflow_dispatch','push','pull_request','schedule']:
            for repo,repo_id in [('khemisset18/gpubnb','1305325878'),('other/gpubnb','1305325878'),('khemisset18/gpubnb','1')]:
                for branch,ref in branches.items():
                    for suite in ['both','d3','multinode','fee-pinning','vm-recovery','auxpow-expanded','source-audit','recovery-consistency']:
                        got={job for job,expression in expressions.items() if route(expression,event=event,repo=repo,
                            repo_id=repo_id,ref='refs/heads/'+ref,suite=suite)}
                        want=expected.get((branch,suite),set()) if event=='workflow_dispatch' and repo=='khemisset18/gpubnb' and repo_id=='1305325878' else set()
                        self.assertEqual(got,want,(event,repo,repo_id,branch,suite))

    def test_child_new_mode_cannot_run_on_another_event_branch_or_repository(self):
        root=Path(__file__).resolve().parents[4]
        text=(root/'.github/workflows/asset-exchange-dogecoin-multinode.yml').read_text()
        expression=job_condition(text,'private-multinode')
        for event in ['workflow_dispatch','push','pull_request','schedule']:
            for repo,repo_id in [('khemisset18/gpubnb','1305325878'),('other/gpubnb','1305325878'),('khemisset18/gpubnb','1')]:
                for branch in ['asset-exchange/doge-recovery-consistency-20261112',
                    'asset-exchange/doge-independent-recovery-20261111','main','dev']:
                    got=route(expression,event=event,repo=repo,repo_id=repo_id,ref='refs/heads/'+branch,suite='recovery-funding-reorg')
                    self.assertEqual(got,event=='workflow_dispatch' and repo=='khemisset18/gpubnb'
                        and repo_id=='1305325878' and branch=='asset-exchange/doge-recovery-consistency-20261112')

    def test_keyless_scope_is_finite_without_relaxing_existing_modes(self):
        m=multinode.manifest('recovery-funding-reorg')
        self.assertEqual(m['maxGeneratedBlocks'],2);self.assertEqual(m['maxBroadcastFixtures'],2)
        self.assertEqual(m['maxRpc'],400);self.assertEqual(m['maxStandaloneInvocations'],8)
        self.assertEqual(m['importedPublicBlocksMaximum'],1355)
        self.assertFalse(m['signingAllowed']);self.assertFalse(m['repeatsPreviouslyQualifiedSuite'])
        self.assertFalse(m['settlementAllowed']);self.assertEqual(m['qualificationStatus'],'BLOCKED')
        self.assertEqual(m['selectedNativeCases'],['unconfirmed-funding-refuses-rebroadcast'])
        self.assertEqual(multinode.manifest()['maxRpc'],480)
        self.assertEqual(multinode.manifest('fee-pinning')['maxRpc'],800)
        self.assertEqual(multinode.manifest('auxpow-expanded')['maxBroadcastFixtures'],0)

    def test_extra_mining_auxpow_clock_or_unregistered_transaction_refuses(self):
        fields={'addresses':{'a':'fixed-a','b':'fixed-b'},'blocks':set(),'txids':set(),'submitted':set(),
                'lab_suite':'recovery-funding-reorg'}
        multinode.validate_rpc('a','generatetoaddress',('1','fixed-a','1000000','1'),**fields)
        for count in ['1352','2','4']:
            with self.assertRaises(ValueError):
                multinode.validate_rpc('a','generatetoaddress',(count,'fixed-a','1000000','0' if count=='1352' else '1'),**fields)
        for method,params in [('createauxblock',('fixed-a',)),('submitauxblock',('aa'*32,'00')),
                              ('setmocktime',('1',)),('sendrawtransaction',('00',))]:
            with self.assertRaises(ValueError):multinode.validate_rpc('a',method,params,**fields)

    def test_key_material_refuses_before_parcel_or_rpc_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            keys=Path(tmp)/'keys';keys.mkdir();(keys/'unexpected').write_text('synthetic placeholder')
            rpc=Mock(side_effect=AssertionError('no RPC permitted'))
            with self.assertRaisesRegex(ValueError,'cannot create signing keys'):
                funding_reorg.run_funding_reorg({'keys':keys,'rpc':rpc,'report':{},'save':Mock()},'/missing',{})
            rpc.assert_not_called()

    def test_bundle_tampering_refuses_before_importing_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);keys=root/'keys';keys.mkdir();(root/'bundle-parent.json').write_text('{}')
            rpc=Mock(side_effect=AssertionError('no RPC permitted'))
            with self.assertRaisesRegex(ValueError,'receipt mismatch'):
                funding_reorg.run_funding_reorg({'keys':keys,'rpc':rpc,'report':{},'save':Mock()},root,
                    {'bundleDigests':{'parent':'0'*64},'files':{'bundle-parent.json':'0'*64}})
            rpc.assert_not_called()

    def test_new_control_keeps_key_and_receipt_guards_before_native_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);keys=root/'keys';keys.mkdir();(keys/'unexpected').write_text('synthetic placeholder')
            rpc=Mock(side_effect=AssertionError('no RPC permitted'))
            with self.assertRaisesRegex(ValueError,'cannot create signing keys'):
                funding_reorg.run_unconfirmed_funding({'keys':keys,'rpc':rpc},root,{})
            (keys/'unexpected').unlink();(root/'bundle-parent.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'receipt mismatch'):
                funding_reorg.run_unconfirmed_funding({'keys':keys,'rpc':rpc},root,
                    {'bundleDigests':{'parent':'0'*64},'files':{'bundle-parent.json':'0'*64}})
            rpc.assert_not_called()

    def control_context(self,root):
        keys=root/'keys';keys.mkdir()
        bundle={'funding':{'txid':'11'*32,'transactionHex':'00'},
                'refunds':[{'txid':'22'*32,'transactionHex':'01','sha256':'33'*32}]}
        chain={'blocks':1355,'headers':1355,'bestblockhash':'44'*32}
        def rpc(node,method,*params):
            self.assertEqual(node,'a')
            if method=='getblockchaininfo':return dict(chain)
            if method=='getrawmempool':return ['11'*32,'22'*32]
            raise AssertionError('unexpected native method '+method)
        def tx(node,txid):
            self.assertEqual(node,'a')
            return {'hex':'00' if txid=='11'*32 else '01','confirmations':0}
        def recover(context):
            self.assertEqual(context['source'],'a')
            self.assertEqual(context['labLabel'],'funding-unconfirmed')
            if context['mode']=='observe':return {'state':'PENDING','fundingConfirmed':False}
            self.assertEqual(context['mode'],'rebroadcast')
            return {'expectedRefusal':context['expectedError'],'rpcCalls':[{'method':'getblockchaininfo'}]}
        context={'keys':keys,'rpc':Mock(side_effect=rpc),'tx':Mock(side_effect=tx),
                 'report':{'stages':[]},'save':Mock(),'submit':Mock(),'import_chain':Mock(),
                 'recover':Mock(side_effect=recover)}
        return context,bundle,chain

    def test_only_new_control_runs_without_mining_or_old_scenario(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);c,bundle,_=self.control_context(root)
            with patch.object(funding_reorg,'retained_public_bundle',return_value=(root,bundle,'55'*32)),\
                 patch.object(funding_reorg,'run_funding_reorg',side_effect=AssertionError('old suite repeated')):
                funding_reorg.run_unconfirmed_funding(c,root,{'blocks':['44'*32]*1355})
            self.assertNotIn('mine',c)
            self.assertEqual(c['submit'].call_args_list,[unittest.mock.call('a',b'\x00'),unittest.mock.call('a',b'\x01')])
            self.assertEqual(c['recover'].call_count,2)
            self.assertEqual(c['report']['stages'],[])
            result=c['report']['fundingUnconfirmed']
            self.assertTrue(result['newFundingGuardIsolatedNatively'])
            self.assertEqual(result['generatedBlocks'],0)
            self.assertEqual(result['cases'][0]['id'],'unconfirmed-funding-refuses-rebroadcast')

    def test_header_lead_or_confirmed_fixture_cannot_claim_direct_guard_isolation(self):
        for change in ('header-lead','confirmed'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);c,bundle,chain=self.control_context(root)
                if change=='header-lead':chain['headers']=1356
                else:c['tx'].side_effect=lambda node,txid:{'hex':'00','confirmations':1,'blockhash':'44'*32}
                with patch.object(funding_reorg,'retained_public_bundle',return_value=(root,bundle,'55'*32)):
                    with self.assertRaisesRegex(ValueError,'synchronized public tip|unexpectedly confirmed'):
                        funding_reorg.run_unconfirmed_funding(c,root,{'blocks':['44'*32]*1355})
                c['recover'].assert_not_called()

    def test_different_refusal_or_any_standalone_send_cannot_pass_new_control(self):
        for change in ('wrong-refusal','send'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);c,bundle,_=self.control_context(root)
                c['recover'].side_effect=[{'state':'PENDING','fundingConfirmed':False},
                    {'expectedRefusal':funding_reorg.REFUSAL if change=='wrong-refusal' else funding_reorg.FUNDING_REFUSAL,
                     'rpcCalls':[{'method':'sendrawtransaction' if change=='send' else 'getblockchaininfo'}]}]
                with patch.object(funding_reorg,'retained_public_bundle',return_value=(root,bundle,'55'*32)):
                    with self.assertRaisesRegex(ValueError,'direct funding guard did not refuse'):
                        funding_reorg.run_unconfirmed_funding(c,root,{'blocks':['44'*32]*1355})

    def watcher_report(self):
        stages=[]
        for label in ['pending-confirmed-funding','funding-rolled-back','funding-restored','refund-confirmed']:
            rows=[]
            for node in ('a','b'):
                height=1357 if label=='refund-confirmed' else 1355 if label=='funding-rolled-back' and node=='a' else 1356
                confirmed=label=='refund-confirmed'
                rows.append({'chainId':'dogecoin','networkId':'regtest','sourceId':'doge-'+node,
                    'tipHash':format(height,'064x'),'tipHeight':height,'observedTxid':'c'*64,
                    'blockHash':format(height,'064x') if confirmed else None,
                    'blockHeight':height if confirmed else None,'transactionFound':True,
                    'confirmations':int(confirmed),'mempoolStatus':'ABSENT' if confirmed else 'PRESENT',
                    'conflictStatus':'NONE','observedAtUnixMs':1700000000000})
            stages.append({'label':label,'observations':rows})
        return {'experimentStatus':'PASS','qualificationStatus':'BLOCKED','manifest':{'labSuite':'recovery-funding-reorg'},
            'fundingReorg':{'keysCreated':0,'transactionsSigned':0,'previousNativeSuitesRepeated':False,
                'newFundingGuardIsolatedNatively':False,
                'cases':[{'id':'pending-refund-after-funding-reorg','status':'PASS'},
                         {'id':'same-refund-after-funding-restoration','status':'PASS'}]},'stages':stages}

    def check_watcher(self,value):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'input.json';out=root/'output.json';source.write_text(json.dumps(value))
            result=subprocess.run(['node',str(Path(__file__).with_name('check-watcher-evidence.mjs')),str(source),str(out)],
                capture_output=True,text=True,timeout=10)
            return result,json.loads(out.read_bytes()) if out.exists() else None

    def test_watcher_requires_partition_and_never_advances_from_one_confirmation(self):
        result,value=self.check_watcher(self.watcher_report());self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(value['stages']['funding-rolled-back']['consistency'],'UNCERTAIN')
        self.assertFalse(value['settlementAllowed'])
        self.assertTrue(all(not x['canAdvance'] for x in value['stages'].values()))

    def test_missing_stage_wrong_mode_or_fake_partition_refuses(self):
        for change in [lambda r:r['stages'].pop(),lambda r:r['manifest'].update(labSuite='multinode'),
            lambda r:r['stages'][1]['observations'][0].update(tipHash=format(1356,'064x'),tipHeight=1356)]:
            report=self.watcher_report();change(report);result,_=self.check_watcher(report)
            self.assertNotEqual(result.returncode,0)


    def unconfirmed_report(self):
        refusal=funding_reorg.FUNDING_REFUSAL
        rows=[]
        for state in ('PENDING','UNKNOWN'):
            rows.append({'source':'a','labLabel':'funding-unconfirmed','state':state,'fundingConfirmed':False,
                'txid':'22'*32 if state=='PENDING' else None,
                'transition':'PENDING' if state=='PENDING' else 'EXPECTED_REFUSAL','qualificationStatus':'BLOCKED',
                'expectedRefusal':refusal if state=='UNKNOWN' else None,'rpcCalls':[{'method':'getblockchaininfo'}],
                'isolationProof':{'backendUnavailable':True,'originalSigningKeysUnavailable':True}})
        return {'experimentStatus':'PASS','qualificationStatus':'BLOCKED','generatedBlocks':0,'stages':[],
            'manifest':{'labSuite':'recovery-funding-reorg','selectedNativeCases':['unconfirmed-funding-refuses-rebroadcast']},
            'independentRecoveryCalls':rows,'fundingUnconfirmed':{'keysCreated':0,'transactionsSigned':0,
                'oldFundingReorgCasesRepeated':False,'newFundingGuardIsolatedNatively':True,
                'activeBlocks':1355,'activeHeaders':1355,'fundingConfirmations':0,'refundConfirmations':0,
                'fundingTxid':'11'*32,'refundTxid':'22'*32,'refundSha256':'33'*32,'retainedBundleSha256':'55'*32,
                'standaloneInvocations':2,'generatedBlocks':0,'refusalBroadcasts':0,'standaloneRefusal':refusal,
                'cases':[{'id':'unconfirmed-funding-refuses-rebroadcast','status':'PASS'}]}}

    def test_new_evidence_contract_requires_only_the_isolated_guard(self):
        result,value=self.check_watcher(self.unconfirmed_report())
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(value['newFundingGuardIsolatedNatively'])
        self.assertFalse(value['oldFundingReorgCasesRepeated'])
        self.assertFalse(value['settlementAllowed']);self.assertFalse(value['canAdvance'])

    def test_new_contract_rejects_replays_mining_wrong_refusal_or_broadcast(self):
        changes=[lambda r:r.update(generatedBlocks=1),
            lambda r:r['manifest'].update(selectedNativeCases=['old-two-cases']),
            lambda r:r['fundingUnconfirmed'].update(activeHeaders=1356),
            lambda r:r['fundingUnconfirmed'].update(standaloneRefusal=funding_reorg.REFUSAL),
            lambda r:r['fundingUnconfirmed'].update(oldFundingReorgCasesRepeated=True),
            lambda r:r['fundingUnconfirmed']['cases'].append({'id':'pending-refund-after-funding-reorg','status':'PASS'}),
            lambda r:r.update(fundingReorg={}),
            lambda r:(r['fundingUnconfirmed'].pop('refundTxid'),r['independentRecoveryCalls'][0].pop('txid')),
            lambda r:r['fundingUnconfirmed'].update(refundTxid='BAD'),
            lambda r:r['independentRecoveryCalls'].append(r['independentRecoveryCalls'][0]),
            lambda r:r['independentRecoveryCalls'][1].update(state='PENDING'),
            lambda r:r['independentRecoveryCalls'][1].update(transition='PENDING'),
            lambda r:r['independentRecoveryCalls'][1].update(qualificationStatus='PASS'),
            lambda r:r['independentRecoveryCalls'][1]['rpcCalls'].append({'method':'sendrawtransaction'})]
        for change in changes:
            report=self.unconfirmed_report();change(report);result,_=self.check_watcher(report)
            self.assertNotEqual(result.returncode,0)


if __name__=='__main__':unittest.main()
