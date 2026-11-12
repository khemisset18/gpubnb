import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import multinode
import auxpow_boundaries as aux
from auxpow_fixtures import TARGET,REASONS

class ExpandedAuxpowBoundaries(unittest.TestCase):
    def test_new_cases_are_distinct_from_previous_eight_and_use_bounded_work(self):
        names=(*aux.NEGATIVE,*aux.POSITIVE)
        self.assertEqual(len(set(names)),12);self.assertFalse(set(names)&(set(REASONS)|{'valid-control'}))
        with patch('auxpow_fixtures.vectors',side_effect=AssertionError('previous suite forbidden')):
            rows=[aux.fixture('ab'*32,TARGET.to_bytes(32,'little').hex(),name) for name in names]
        self.assertEqual(len({r['sha256'] for r in rows}),12)
        for row in rows:
            self.assertLessEqual(row['parentAttempts'],256);self.assertLessEqual(len(bytes.fromhex(row['hex'])),4096)
            self.assertLessEqual(int.from_bytes(aux.scrypt_hash(bytes.fromhex(row['parentHeaderHex'])),'little'),TARGET)
        self.assertEqual(next(x for x in rows if x['case']=='chain-branch-height-30')['chainBranchLength'],30)
        self.assertEqual(next(x for x in rows if x['case']=='parent-branch-height-31')['parentBranchLength'],31)
        self.assertGreater(next(x for x in rows if x['case']=='trailing-rpc-data')['submittedTrailingBytes'],0)

    def test_case_and_target_substitution_refuse(self):
        for name,target in [('parent-work',TARGET.to_bytes(32,'little').hex()),('unknown','00'*32),('legacy-root-offset-20','ff'*32)]:
            with self.assertRaises(ValueError):aux.fixture('ab'*32,target,name)

    def test_new_scope_forbids_transactions_signers_remine_and_preserves_old_limits(self):
        profile=multinode.manifest('auxpow-expanded');old=multinode.manifest()
        self.assertEqual(profile['maxGeneratedBlocks'],16);self.assertEqual(profile['maxRpc'],400)
        self.assertEqual(profile['maxBroadcastFixtures'],0);self.assertEqual(profile['maxAuxpowFixtures'],32)
        self.assertFalse(profile['signingAllowed']);self.assertEqual(old['maxAuxpowFixtures'],8)
        context={'addresses':{'a':'private-a','b':'private-b'},'blocks':{'a'*64},'txids':{'b'*64},'submitted':{'00'}}
        for method,params in [('sendrawtransaction',('00',)),('getrawmempool',()),('generatetoaddress',('1352','private-a','1000000','0'))]:
            with self.assertRaises(ValueError):multinode.validate_rpc('a',method,params,**context,lab_suite='auxpow-expanded')
        registry={('a'*64,f'{i:02x}') for i in range(20)}
        multinode.validate_rpc('b','submitauxblock',('a'*64,'00'),**context,aux_submitted=registry,lab_suite='auxpow-expanded')
        with self.assertRaises(ValueError):multinode.validate_rpc('b','submitauxblock',('a'*64,'00'),**context,aux_submitted=registry)

    def test_public_seed_receipt_cannot_be_substituted_before_chain_bytes_are_read(self):
        with patch('recovery_core.read_regular',return_value=b'{}'):
            with self.assertRaisesRegex(ValueError,'receipt'):aux.load_public_seed('/unused','00'*32)

    def report(self):
        stages=[]
        for label in ('before-probes','after-negative-probes','after-valid-boundaries','partitioned-boundary-chain','converged-boundary-reorg'):
            rows=[{'chainId':'dogecoin','networkId':'regtest','sourceId':'doge-'+n,
                'tipHash':('b' if label=='partitioned-boundary-chain' and n=='b' else 'a')*64,
                'tipHeight':1355,'observedAtUnixMs':1700000000000} for n in ('a','b')]
            stages.append({'label':label,'observations':rows})
        return {'experimentStatus':'PASS','qualificationStatus':'BLOCKED','manifest':{'labSuite':'auxpow-expanded'},
            'auxpowExpanded':{'previousEightControlsRepeated':False,'cases':[{'status':'PASS'}]*12,'tipStages':stages}}

    def check_report(self,value,root):
        source=root/'input.json';output=root/'output.json';source.write_text(json.dumps(value))
        result=subprocess.run(['node',str(Path(__file__).with_name('check-watcher-evidence.mjs')),str(source),str(output)],
            capture_output=True,text=True,timeout=10)
        return result,output

    def test_historical_tip_review_never_promotes_block_agreement_to_financial_progression(self):
        with tempfile.TemporaryDirectory() as tmp:
            result,out=self.check_report(self.report(),Path(tmp));self.assertEqual(result.returncode,0,result.stderr)
            review=json.loads(out.read_text());self.assertFalse(review['settlementAllowed'])
            self.assertTrue(all(not x['canAdvance'] and not x['settlementAllowed'] for x in review['tipStages'].values()))
            self.assertEqual(review['tipStages']['partitioned-boundary-chain']['consistency'],'UNCERTAIN')

    def test_historical_review_rejects_missing_partition_duplicate_source_or_wrong_mode(self):
        changes=[lambda r:r['auxpowExpanded']['tipStages'].pop(),
                 lambda r:r['auxpowExpanded']['tipStages'][3]['observations'][1].update(tipHash='a'*64),
                 lambda r:r['auxpowExpanded']['tipStages'][0]['observations'][1].update(sourceId='doge-a'),
                 lambda r:r['manifest'].update(labSuite='multinode')]
        with tempfile.TemporaryDirectory() as tmp:
            for change in changes:
                report=self.report();change(report);result,_=self.check_report(report,Path(tmp))
                self.assertNotEqual(result.returncode,0);self.assertIn('Error',result.stderr)

if __name__=='__main__':unittest.main()
