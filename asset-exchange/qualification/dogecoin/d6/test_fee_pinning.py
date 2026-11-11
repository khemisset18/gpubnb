import argparse
from pathlib import Path
import unittest
from unittest.mock import patch

import multinode
import fee_pinning
from test_signer import transaction,sighash


class FeeMatrixBoundaries(unittest.TestCase):
    def test_required_cases_are_distinct_and_classify_policy_protocol_and_consensus(self):
        self.assertEqual(set(fee_pinning.SCENARIOS),set(range(1,16)))
        self.assertEqual(len({x[0] for x in fee_pinning.SCENARIOS.values()}),15)
        self.assertTrue(all(scope in ('mempool-policy','exchange-protocol','mempool-policy/exchange-protocol',
            'mempool-policy/consensus','consensus/exchange-protocol','exchange-protocol/mempool-policy')
            for _,scope in fee_pinning.SCENARIOS.values()))

    def test_existing_codec_keeps_recovery_bound_and_only_explicit_pressure_preparation_expands_it(self):
        outputs=[(1,b'\x51')]*9
        with self.assertRaises(ValueError):transaction('a'*64,0,b'',outputs)
        with self.assertRaises(ValueError):sighash('a'*64,0,b'',outputs)
        raw=transaction('a'*64,0,b'',outputs,max_outputs=9)
        self.assertTrue(raw)
        for limit in [True,0,1602,'9']:
            with self.assertRaises(ValueError):transaction('a'*64,0,b'',outputs,max_outputs=limit)
        with self.assertRaises(ValueError):transaction('a'*64,0,b'',[(1,b'\x51')]*1602,max_outputs=1601)

    def test_fee_profile_is_finite_without_changing_the_original_profile_bounds(self):
        old=multinode.manifest();new=multinode.manifest('fee-pinning')
        self.assertEqual(old['maxBroadcastFixtures'],8);self.assertEqual(old['maxRpc'],480)
        self.assertEqual(new['maxBroadcastFixtures'],96);self.assertEqual(new['maxRpc'],800)
        self.assertEqual(new['maxFixtureBytes'],60000);self.assertEqual(new['maxPressureTransactions'],64)
        self.assertFalse(new['repeatsPreviouslyQualifiedSuite']);self.assertEqual(new['qualificationStatus'],'BLOCKED')
        self.assertNotIn('setmocktime',old['rpcAllowlist']);self.assertIn('setmocktime',new['rpcAllowlist'])
        for name in ['signrawtransaction','sendtoaddress','settxfee']:self.assertNotIn(name,new['rpcAllowlist'])

    def test_only_the_registered_private_clock_is_permitted_in_the_fee_profile(self):
        context={'addresses':{'a':'test-a','b':'test-b'},'blocks':set(),'txids':set(),'submitted':set()}
        multinode.validate_rpc('a','setmocktime',('123',),**context,lab_suite='fee-pinning',mocktimes={'123'})
        for profile,params,registered in [('multinode',('123',),{'123'}),('fee-pinning',('124',),{'123'}),
                                          ('fee-pinning',('123','extra'),{'123'})]:
            with self.assertRaises(ValueError):
                multinode.validate_rpc('a','setmocktime',params,**context,lab_suite=profile,mocktimes=registered)

    def test_unknown_lab_suite_refuses_before_native_or_file_access(self):
        with patch('subprocess.check_output',side_effect=AssertionError('process forbidden')):
            with self.assertRaisesRegex(ValueError,'suite'):
                multinode.run(argparse.Namespace(authorization=multinode.AUTHORIZATION,lab_suite='public'))

    def test_fee_mode_stays_in_the_existing_manual_executor_with_exact_branch_and_profile_gates(self):
        root=Path(__file__).resolve().parents[4]
        workflow=(root/'.github/workflows/workspace-reliability.yml').read_text()
        d3=workflow.split('\n  doge-d3-private-manual:\n',1)[1].split('\n  doge-recovery-',1)[0]
        self.assertIn("inputs.doge_suite != 'fee-pinning'",d3)
        caller=workflow.split('\n  doge-recovery-multinode-private-manual:\n',1)[1]
        self.assertIn("inputs.doge_suite == 'fee-pinning'",caller)
        self.assertIn('refs/heads/asset-exchange/doge-fee-pinning-20261111',caller)
        self.assertIn('uses: ./.github/workflows/asset-exchange-dogecoin-multinode.yml',caller)
        child=(root/'.github/workflows/asset-exchange-dogecoin-multinode.yml').read_text()
        self.assertIn("inputs.lab_suite == 'fee-pinning'",child)
        self.assertIn("github.event_name == 'workflow_dispatch'",child)
        self.assertIn('"$LAB_AUTHORIZATION" "$LAB_SUITE"',child)


if __name__=='__main__':unittest.main()
