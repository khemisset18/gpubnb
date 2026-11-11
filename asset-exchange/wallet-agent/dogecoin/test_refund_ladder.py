import copy
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import refund_ladder as policy
from offline_candidate import build_candidate
from test_signer import EphemeralSigner, transaction, sighash, hash256, push, encode_der, decode_der, ORDER


class RefundLadderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='doge-signer-test-')
        cls.claim, cls.refund = EphemeralSigner(cls.tmp.name,'claim'), EphemeralSigner(cls.tmp.name,'refund')
        candidate = build_candidate(hashlib.sha256(b'public test preimage').digest(), cls.claim.public, cls.refund.public, 1355)
        cls.contract = {'redeemHex':candidate.redeem.hex(),'outputHex':candidate.output.hex()}
        funding_raw = transaction('01'*32,0,b'\x51',[(100*100_000_000,candidate.output),(1_000_000,b'\x51')])
        cls.funding = {'txid':policy.txid(funding_raw),'vout':0,'valueKoinu':'10000000000','transactionHex':funding_raw.hex()}
        cls.destination = '76a914'+'11'*20+'88ac'
        cls.budget = {'maxFeeKoinu':'100000000','minRefundKoinu':'9900000000'}
        cls.plan = cls.make_request()
        cls.response = cls.make_response(cls.plan)
        cls.entries = policy.finalize_refund_signing_response(cls.plan,cls.response,
            trusted_terms_digest=cls.plan['termsDigest'], trusted_request_digest=cls.plan['requestDigest'],current_height=1353)

    @classmethod
    def tearDownClass(cls):
        cls.claim.destroy(); cls.refund.destroy(); cls.tmp.cleanup()

    @classmethod
    def make_request(cls, **changes):
        args = dict(contract=cls.contract,funding=cls.funding,policy=cls.budget,
            destination_hex=cls.destination,fees=['1000000','10000000','100000000'],
            request_id='test_refund_ladder',created_at_height=1352,request_expires_at_height=1360)
        args.update(changes)
        return policy.create_refund_signing_request(**args)

    @classmethod
    def make_response(cls, request):
        return {'domain':policy.RESPONSE_DOMAIN,'schemaVersion':1,'requestId':request['requestId'],
            'requestDigest':request['requestDigest'],'refundPublicHex':cls.refund.public.hex(),
            'signatures':[cls.refund.sign(bytes.fromhex(entry['sighashHex'])).hex() for entry in request['entries']]}

    def validate(self, entries=None, **changes):
        args = dict(contract=self.contract,funding=self.funding,policy=self.budget)
        args.update(changes)
        return policy.validate_refund_ladder(copy.deepcopy(self.entries if entries is None else entries),**args)

    def finalize(self, request=None, response=None, **changes):
        request = self.plan if request is None else request
        args = dict(trusted_terms_digest=self.plan['termsDigest'],trusted_request_digest=self.plan['requestDigest'],current_height=1353)
        args.update(changes)
        return policy.finalize_refund_signing_response(request,self.response if response is None else response,**args)

    def test_openssl_verified_ladder_binds_exact_bytes_and_distinct_fee_steps(self):
        rows = self.validate()
        self.assertEqual([row['feeKoinu'] for row in rows],['1000000','10000000','100000000'])
        self.assertEqual(len({row['txid'] for row in rows}),3)
        self.assertEqual({row['destinationHex'] for row in rows},{self.destination})
        self.assertTrue(all(row['sequence']==0xfffffffe and row['lockTime']==1355 for row in rows))
        self.assertEqual(rows[-1]['outputValueKoinu'],'9900000000')

    def test_selects_cheapest_adequate_without_access_to_any_signing_key(self):
        args = dict(contract=self.contract,funding=self.funding,policy=self.budget)
        # Selection verifies with the refund public key; it never opens a PEM.
        with patch.object(EphemeralSigner,'sign',side_effect=AssertionError('must not sign')):
            for required,expected in [('0','1000000'),('1000000','1000000'),('1000001','10000000'),('10000000','10000000'),('10000001','100000000')]:
                self.assertEqual(policy.select_presigned_refund(self.entries,required,**args)['feeKoinu'],expected)
            with self.assertRaisesRegex(policy.FeeCoverageError,'signer is required'):
                policy.select_presigned_refund(self.entries,'100000001',**args)

    def test_ladder_is_bounded_strictly_monotonic_and_does_not_change_destination(self):
        for fees in [[],['1000000']*2,['10000000','1000000'],['0'],['100000001'],['1']*9]:
            with self.subTest(fees=fees),self.assertRaises(ValueError):self.make_request(fees=fees)
        for entries in [[],[self.entries[0]]*2,list(reversed(self.entries)),self.entries*3]:
            with self.assertRaises(ValueError):self.validate(entries)
        other = self.make_request(destination_hex='76a914'+'22'*20+'88ac',fees=['10000000'])
        row = self.finalize(other,self.make_response(other),trusted_terms_digest=other['termsDigest'],trusted_request_digest=other['requestDigest'])[0]
        with self.assertRaisesRegex(ValueError,'destination changed'):self.validate([self.entries[0],row])

    def test_fee_cap_dust_amount_format_and_profile_input_guards(self):
        for budget in [dict(self.budget,maxFeeKoinu='100000001'),dict(self.budget,minRefundKoinu='1'),
                       dict(self.budget,maxFeeKoinu='10000000000'),dict(self.budget,maxFeeKoinu='-1')]:
            with self.assertRaises(ValueError):self.make_request(policy=budget)
        for value in [True,1,1.5,'01','1e6','-1']:
            with self.assertRaises(ValueError):self.make_request(fees=[value])
        with self.assertRaises(ValueError):self.make_request(destination_hex='6a')

    def test_funding_malleability_and_wrong_utxo_metadata_refuse_old_refunds(self):
        mutated = copy.deepcopy(self.funding)
        raw = bytearray.fromhex(mutated['transactionHex']);raw[42]=0x52
        mutated['transactionHex']=raw.hex()
        with self.assertRaisesRegex(ValueError,'funding identity changed'):self.validate(funding=mutated)
        mutated['txid']=policy.txid(bytes(raw))
        with self.assertRaisesRegex(ValueError,'outpoint mismatch'):self.validate(funding=mutated)
        for field,value in [('valueKoinu','10000000001'),('vout',1),('vout',True)]:
            mutated=copy.deepcopy(self.funding);mutated[field]=value
            with self.assertRaises(ValueError):self.validate(funding=mutated)

    def test_refund_mutations_and_extra_fields_reject(self):
        for field,value in [('destinationHex','76a914'+'22'*20+'88ac'),('outputValueKoinu','1'),('feeKoinu','1'),
                            ('lockTime',1354),('sequence',0xfffffffd),('sha256','0'*64),('txid','0'*64),('unknown',1)]:
            rows=copy.deepcopy(self.entries);rows[0][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):self.validate(rows)
        rows=copy.deepcopy(self.entries)
        raw=bytearray.fromhex(rows[0]['transactionHex']);raw[-1]^=1
        rows[0].update(transactionHex=raw.hex(),sha256=hashlib.sha256(raw).hexdigest(),txid=policy.txid(bytes(raw)))
        with self.assertRaises(ValueError):self.validate(rows)

    def test_high_s_non_all_sighash_wrong_key_and_malformed_der_reject(self):
        for mode in ['high-s','sighash-none','wrong-key','malformed-der']:
            response=copy.deepcopy(self.response);sig=bytes.fromhex(response['signatures'][0])
            if mode=='high-s':
                r,s=decode_der(sig[:-1]);sig=encode_der(r,ORDER-s)+b'\x01'
            elif mode=='sighash-none':sig=sig[:-1]+b'\x02'
            elif mode=='wrong-key':sig=self.claim.sign(bytes.fromhex(self.plan['entries'][0]['sighashHex']))
            else:sig=sig[:-1]+b'\0\x01'
            response['signatures'][0]=sig.hex()
            with self.subTest(mode=mode),self.assertRaises(ValueError):self.finalize(response=response)

    def test_external_response_cannot_mutate_a_displayed_request(self):
        for field,value in [('domain','other'),('network','main'),('genesis','a'*64),('sourceCommit','a'*40),
                            ('requestId','different_request'),('requestDigest','0'*64),('schemaVersion',True)]:
            request=copy.deepcopy(self.plan);request[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):self.finalize(request=request)
        request=copy.deepcopy(self.plan);request['entries'][0]['unsignedTransactionHex']='00'
        with self.assertRaises(ValueError):self.finalize(request=request)
        for field,value in [('domain','other'),('requestId','different_request'),('requestDigest','0'*64),
                            ('refundPublicHex',self.claim.public.hex()),('signatures',self.response['signatures'][:1])]:
            response=copy.deepcopy(self.response);response[field]=value
            with self.assertRaises(ValueError):self.finalize(response=response)

    def test_request_deadline_rejects_new_signature_but_does_not_expire_presigned_refund(self):
        for current in [1351,1360,1361,True]:
            with self.assertRaises(ValueError):self.finalize(current_height=current)
        self.assertEqual(len(self.finalize(current_height=1359)),3)
        # A pre-signed transaction's CLTV is a lower bound, not an expiry date.
        self.assertEqual(len(self.validate()),3)
        self.assertNotIn('expiresAtHeight',self.entries[0])

    def test_review_fields_show_exact_network_destination_amounts_and_each_fee(self):
        displayed=policy.signer_review_fields(self.plan,trusted_terms_digest=self.plan['termsDigest'],
            trusted_request_digest=self.plan['requestDigest'],current_height=1353)
        self.assertEqual(displayed['network'],'regtest')
        self.assertEqual(displayed['destinationScriptHex'],self.destination)
        self.assertEqual(displayed['inputDoge'],'100.00000000')
        self.assertEqual(displayed['maximumFeeDoge'],'1.00000000')
        self.assertEqual([row['refundDoge'] for row in displayed['steps']],['99.99000000','99.90000000','99.00000000'])
        self.assertEqual(displayed['refundPublicHex'],self.refund.public.hex())

    def test_policy_runs_from_isolated_zipapp_with_only_public_helpers(self):
        import json
        with tempfile.TemporaryDirectory(prefix='doge-standalone-test-') as tmp:
            archive=Path(tmp)/'policy.pyz';empty=Path(tmp)/'empty';empty.mkdir()
            fixture={'entries':self.entries,'contract':self.contract,'funding':self.funding,'policy':self.budget}
            main='import json,refund_ladder\nx=json.loads('+repr(json.dumps(fixture))+')\nassert len(refund_ladder.validate_refund_ladder(x.pop("entries"),**x))==3\nprint("standalone policy passed")\n'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('__main__.py',main)
                z.write(HERE/'refund_ladder.py','refund_ladder.py')
                z.write(HERE.parents[1]/'recovery/dogecoin/transaction.py','transaction.py')
                for name in ['htlc_codec','offline_candidate','spend_preparation','test_signer']:
                    z.write(HERE.parents[1]/'qualification/dogecoin/d2'/f'{name}.py',f'{name}.py')
            done=subprocess.run([sys.executable,'-I',str(archive)],cwd=empty,
                env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},capture_output=True,text=True,timeout=20)
            self.assertEqual(done.returncode,0,done.stderr)
            self.assertEqual(done.stdout.strip(),'standalone policy passed')

    def test_disconnected_signer_or_unavailable_verifier_never_falls_back_to_signing(self):
        with patch.object(EphemeralSigner,'sign',side_effect=AssertionError('must not sign')):
            with self.assertRaisesRegex(policy.SignerUnavailableError,'no signing fallback'):
                policy.finalize_refund_signing_response(self.plan,None,trusted_terms_digest=self.plan['termsDigest'],
                    trusted_request_digest=self.plan['requestDigest'],current_height=1353)
            with patch('refund_ladder.subprocess.run',side_effect=FileNotFoundError('unavailable')):
                with self.assertRaises(policy.SignerUnavailableError):self.validate()


if __name__=='__main__':unittest.main()
