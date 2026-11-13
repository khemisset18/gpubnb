"""Untrusted RPC consistency and funding-reorg regressions; no native node."""
from decimal import Decimal
import unittest
import test_recovery as fixture_tests
import recovery_core as recovery


class RpcConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture_tests.RecoveryTests.setUpClass()
        cls.bundle=fixture_tests.RecoveryTests.bundle

    @classmethod
    def tearDownClass(cls):
        fixture_tests.RecoveryTests.tearDownClass()

    def rpc(self,states,*,funding_confirmed=True,unspent=False):
        base=fixture_tests.FakeRpc(self.bundle,'PENDING')
        entries={e['txid']:e for e in self.bundle['refunds']}
        by_txid={self.bundle['refunds'][index]['txid']:state for index,state in enumerate(states)}
        def call(method,*params,**kwargs):
            value=base(method,*params,**kwargs)
            if method=='getrawtransaction':
                if params[0]==self.bundle['funding']['txid']:
                    if not funding_confirmed:return {'hex':self.bundle['funding']['transactionHex'],'confirmations':0}
                elif params[0] in by_txid:
                    state=by_txid[params[0]]
                    return {'hex':entries[params[0]]['transactionHex'],'confirmations':int(state=='CONFIRMED'),
                            **({'blockhash':'bb'*32} if state=='CONFIRMED' else {})}
                else:return None
            if method=='getmempoolentry':
                return {'fee':Decimal('0.01')} if by_txid.get(params[0])=='PENDING' else None
            if method=='gettxout' and unspent:
                return {'value':Decimal(100),'scriptPubKey':{'hex':self.bundle['contract']['outputHex']}}
            return value
        return call,base.calls

    def refusal(self,states,reason,**kwargs):
        for operation in (recovery.observe,recovery.rebroadcast):
            rpc,calls=self.rpc(states,**kwargs)
            with self.assertRaisesRegex(ValueError,reason):operation(self.bundle,rpc)
            self.assertFalse(any(method=='sendrawtransaction' for method,_ in calls))

    def test_two_conflicting_pending_refunds_are_not_arbitrarily_selected(self):
        self.refusal(['PENDING','PENDING'],'conflicting active refund')

    def test_confirmed_and_conflicting_pending_cannot_be_reported_together(self):
        self.refusal(['CONFIRMED','PENDING'],'conflicting active refund')

    def test_two_confirmed_conflicts_remain_rejected(self):
        self.refusal(['CONFIRMED','CONFIRMED'],'conflicting active refund')

    def test_refund_observed_spending_an_unspent_funding_output_refuses(self):
        self.refusal(['PENDING'],'refund and unspent funding',unspent=True)

    def test_active_confirmed_refund_requires_active_confirmed_funding(self):
        self.refusal(['CONFIRMED'],'confirmed refund without confirmed funding',funding_confirmed=False)

    def test_pending_refund_after_funding_reorg_can_be_observed_but_not_rebroadcast(self):
        rpc,calls=self.rpc(['PENDING'],funding_confirmed=False)
        status=recovery.observe(self.bundle,rpc)
        self.assertEqual(status['state'],'PENDING')
        self.assertFalse(status['fundingConfirmed'])
        self.assertFalse(status['automaticSettlement'])
        with self.assertRaisesRegex(ValueError,'funding is not confirmed on active chain'):
            recovery.rebroadcast(self.bundle,rpc)
        self.assertFalse(any(method=='sendrawtransaction' for method,_ in calls))


if __name__=='__main__':unittest.main()
