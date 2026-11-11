import copy
from decimal import Decimal
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import recovery_core as recovery
from package import build_package
sys.path.insert(0,str(HERE.parents[1]/'wallet-agent'/'dogecoin'))
fixture_module=importlib.import_module('test_refund_ladder')


class FakeRpc:
    def __init__(self,bundle,state='UTXO_AVAILABLE',rate='0'):
        self.bundle=bundle;self.state=state;self.calls=[];self.rate=rate;self.index=0;self.tip=1356
        self.genesis=recovery.GENESIS;self.change_tip=False
    def __call__(self,method,*params,missing_ok=False):
        self.calls.append((method,params))
        if method=='getblockchaininfo':
            return {'chain':'regtest','blocks':self.tip,'headers':self.tip,'bestblockhash':'bb'*32,'mediantime':1700000000,
                    'softforks':[{'id':'bip65','reject':{'status':True}}]}
        if method=='getnetworkinfo':return {'version':1140900,'relayfee':Decimal('0.001')}
        if method=='getpeerinfo':return []
        if method=='getblockhash':return self.genesis if params[0]==0 else ('aa'*32 if params[0]==1353 else 'bb'*32)
        if method=='getblockheader':return {'height':1353 if params[0]=='aa'*32 else 1356,'confirmations':1}
        if method=='getmempoolinfo':return {'mempoolminfee':Decimal(self.rate)}
        if method=='getrawtransaction':
            if params[0]==self.bundle['funding']['txid']:
                return {'hex':self.bundle['funding']['transactionHex'],'confirmations':4,'blockhash':'aa'*32}
            entry=self.bundle['refunds'][self.index]
            if params[0]==entry['txid'] and self.state in ('PENDING','CONFIRMED'):
                return {'hex':entry['transactionHex'],'confirmations':1 if self.state=='CONFIRMED' else 0,
                        **({'blockhash':'bb'*32} if self.state=='CONFIRMED' else {})}
            return None
        if method=='getmempoolentry':return {'fee':Decimal('0.01')} if self.state=='PENDING' else None
        if method=='gettxout':
            if self.change_tip:self.tip+=1
            return {'value':Decimal(100),'scriptPubKey':{'hex':self.bundle['contract']['outputHex']}} if self.state=='UTXO_AVAILABLE' else None
        if method=='sendrawtransaction':
            self.index=next(i for i,e in enumerate(self.bundle['refunds']) if e['transactionHex']==params[0])
            self.state='PENDING';return self.bundle['refunds'][self.index]['txid']
        raise AssertionError(method)


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=fixture_module.RefundLadderTests;cls.fixture.setUpClass()
        cls.bundle={'domain':recovery.DOMAIN,'schemaVersion':1,'network':'regtest','genesis':recovery.GENESIS,
                    'sourceCommit':recovery.SOURCE,'contract':cls.fixture.contract,'funding':cls.fixture.funding,
                    'policy':cls.fixture.budget,'refunds':cls.fixture.entries}
    @classmethod
    def tearDownClass(cls):cls.fixture.tearDownClass()
    def test_bundle_is_durable_pinned_and_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'bundle.json';digest=recovery.persist_bundle(path,self.bundle)
            self.assertEqual(recovery.load_bundle(path,digest),self.bundle)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            with self.assertRaises(FileExistsError):recovery.persist_bundle(path,self.bundle)
            path.write_text('{}')
            with self.assertRaisesRegex(ValueError,'digest mismatch'):recovery.load_bundle(path,digest)
    def test_missing_bad_digest_and_symlink_fail_before_signature_or_rpc(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'bundle';path.write_text('{}')
            link=Path(tmp)/'link';link.symlink_to(path)
            with patch('recovery_core.validate_bundle',side_effect=AssertionError('must not validate')):
                for target,digest in [(path,'0'*64),(path,''),(Path(tmp)/'missing','0'*64),(link,hashlib.sha256(b'{}').hexdigest())]:
                    with self.assertRaises((ValueError,OSError)):recovery.load_bundle(target,digest)
    def test_durability_failure_never_returns_prelock_receipt(self):
        for call in (1,2):
            with tempfile.TemporaryDirectory() as tmp,patch('recovery_core.os.fsync',side_effect=[None]*(call-1)+[OSError('durability failed')]):
                with self.assertRaisesRegex(OSError,'durability'):
                    recovery.persist_bundle(Path(tmp)/'bundle',self.bundle)
    def test_same_output_path_cannot_overwrite_recovery_input(self):
        with patch('recovery_core.load_bundle',side_effect=AssertionError('must not load')):
            with self.assertRaisesRegex(ValueError,'distinct files'):
                recovery.main(['observe','--bundle','same','--bundle-sha256','0'*64,'--journal','same'])
    def test_rpc_namespace_guard_precedes_native_binary_access(self):
        with patch('recovery_core.os.readlink',return_value='net:[1]'),patch('subprocess.check_output',return_value='[{"ifname":"lo","flags":["UP"]}]'),patch('recovery_core.read_regular',side_effect=AssertionError('no binary access')):
            with self.assertRaisesRegex(ValueError,'distinct private'):
                recovery.Rpc('unused','unused',18333,'net:[1]')
    def test_duplicate_keys_wrong_network_and_extra_fields_reject(self):
        with self.assertRaises(ValueError):recovery.decode_json(b'{"x":1,"x":2}')
        for key,value in [('network','main'),('genesis','0'*64),('sourceCommit','0'*40),('schemaVersion',True),('secret','do not accept')]:
            changed=copy.deepcopy(self.bundle);changed[key]=value
            with self.assertRaises(ValueError):recovery.validate_bundle(changed)
    def test_observation_and_reorg_never_trigger_settlement(self):
        for state in ['UTXO_AVAILABLE','PENDING','CONFIRMED','SPENT_OR_UNKNOWN']:
            with self.subTest(state=state):
                result=recovery.observe(self.bundle,FakeRpc(self.bundle,state))
                self.assertEqual(result['state'],state);self.assertFalse(result['automaticSettlement'])
        result=recovery.observe(self.bundle,FakeRpc(self.bundle,'PENDING'),{'state':'CONFIRMED'})
        self.assertEqual(result['transition'],'REORGED')
    def test_wrong_network_and_moving_tip_refuse_observation(self):
        rpc=FakeRpc(self.bundle);rpc.genesis='0'*64
        with self.assertRaisesRegex(ValueError,'network/version'):recovery.observe(self.bundle,rpc)
        rpc=FakeRpc(self.bundle);rpc.change_tip=True
        with self.assertRaisesRegex(ValueError,'chain changed'):recovery.observe(self.bundle,rpc)
        self.assertFalse(any(m=='sendrawtransaction' for m,_ in rpc.calls))
    def test_header_lead_can_be_observed_but_never_authorizes_broadcast(self):
        underlying=FakeRpc(self.bundle)
        def rpc(method,*params,**kwargs):
            value=underlying(method,*params,**kwargs)
            if method=='getblockchaininfo':value['headers']+=1
            return value
        self.assertFalse(recovery.observe(self.bundle,rpc)['nodeSynchronized'])
        with self.assertRaisesRegex(ValueError,'unresolved header lead'):recovery.rebroadcast(self.bundle,rpc)
        self.assertFalse(any(m=='sendrawtransaction' for m,_ in underlying.calls))
    def test_keyless_recovery_chooses_presigned_fee_and_broadcasts_exact_bytes(self):
        rpc=FakeRpc(self.bundle,rate='0.1')
        with patch.object(fixture_module.EphemeralSigner,'sign',side_effect=AssertionError('no signer')):
            result=recovery.rebroadcast(self.bundle,rpc)
        self.assertEqual(result['state'],'PENDING');self.assertEqual(result['selectedFeeKoinu'],'10000000')
        broadcasts=[p for m,p in rpc.calls if m=='sendrawtransaction']
        self.assertEqual(broadcasts,[(self.bundle['refunds'][1]['transactionHex'],)])
    def test_fee_above_ladder_or_other_pending_refund_never_resigns_or_replaces(self):
        for state,rate,reason in [('UTXO_AVAILABLE','100','no pre-signed'),('PENDING','0.1','non-RBF')]:
            rpc=FakeRpc(self.bundle,state,rate)
            with self.assertRaisesRegex(ValueError,reason):recovery.rebroadcast(self.bundle,rpc)
            self.assertFalse(any(m=='sendrawtransaction' for m,_ in rpc.calls))
    def test_falling_fee_floor_rebroadcasts_the_existing_pending_variant(self):
        rpc=FakeRpc(self.bundle,'PENDING',rate='0')
        rpc.index=1
        with patch.object(fixture_module.EphemeralSigner,'sign',side_effect=AssertionError('no signer')):
            result=recovery.rebroadcast(self.bundle,rpc)
        self.assertEqual(result['refundTxid'],self.bundle['refunds'][1]['txid'])
        self.assertEqual(result['selectedFeeKoinu'],self.bundle['refunds'][1]['feeKoinu'])
        broadcasts=[p for m,p in rpc.calls if m=='sendrawtransaction']
        self.assertEqual(broadcasts,[(self.bundle['refunds'][1]['transactionHex'],)])
    def test_confirmed_refund_is_idempotent_and_equal_lock_is_nonfinal(self):
        rpc=FakeRpc(self.bundle,'CONFIRMED');result=recovery.rebroadcast(self.bundle,rpc)
        self.assertEqual(result['action'],'ALREADY_CONFIRMED')
        self.assertFalse(any(m=='sendrawtransaction' for m,_ in rpc.calls))
        rpc=FakeRpc(self.bundle);rpc.tip=1354
        with self.assertRaisesRegex(ValueError,'not final'):recovery.rebroadcast(self.bundle,rpc)
    def test_parser_rejects_witness_trailing_and_noncanonical_counts(self):
        raw=bytes.fromhex(self.bundle['refunds'][0]['transactionHex'])
        for damaged in [raw+b'\0',raw[:4]+b'\0\x01'+raw[5:],raw[:4]+b'\xfd\x01\0'+raw[5:],raw[:-1]]:
            with self.assertRaises(ValueError):recovery.parse_transaction(damaged)
    def test_standalone_package_is_reproducible_and_works_with_empty_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=root/'a.pyz';b=root/'b.pyz'
            self.assertEqual(build_package(a),build_package(b))
            with zipfile.ZipFile(a) as z:
                manifest=json.loads(z.read('MANIFEST.json'))
                self.assertEqual(set(z.namelist()),set(manifest['files'])|{'MANIFEST.json'})
                for name,digest in manifest['files'].items():self.assertEqual(hashlib.sha256(z.read(name)).hexdigest(),digest)
            bundle=root/'bundle.json';digest=recovery.persist_bundle(bundle,self.bundle)
            empty=root/'empty';empty.mkdir()
            result=subprocess.run([sys.executable,'-I',str(a),'inspect','--bundle',str(bundle),'--bundle-sha256',digest],
                cwd=empty,env={'PATH':'/usr/bin:/bin','TMPDIR':str(root)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['action'],'INSPECTED')
    def test_journal_is_bound_to_bundle_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'journal.json'
            recovery.save_observation(path,{'state':'CONFIRMED'},'a'*64)
            recovery.save_observation(path,{'state':'PENDING','transition':'REORGED'},'a'*64)
            value=recovery.decode_json(recovery.read_regular(path));self.assertEqual(value['transition'],'REORGED')
            self.assertEqual(value['bundleSha256'],'a'*64);self.assertEqual(path.stat().st_mode&0o777,0o600)

if __name__=='__main__':unittest.main()
