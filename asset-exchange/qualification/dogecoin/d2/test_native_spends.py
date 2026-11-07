import argparse
import json
from pathlib import Path
import unittest
import tempfile
import os
from unittest.mock import patch
import native_spends

class NativeSpendsGuards(unittest.TestCase):
    def test_spent_and_absent_prevouts_have_distinct_native_errors(self):
        spent='error code: -26\nerror message:\n18: bad-txns-inputs-spent\n'
        missing='error code: -25\nerror message:\nMissing inputs\n'
        native_spends.require_rejection(26,spent,'bad-txns-inputs-spent')
        native_spends.require_rejection(25,missing,'Missing inputs')
        for code, text, reason in [(26,spent,'Missing inputs'),(25,missing,'bad-txns-inputs-spent'),(0,spent,'bad-txns-inputs-spent'),(1,'connection refused','non-final'),(1,'error code: -1\nnon-final','non-final')]:
            with self.assertRaises(ValueError):native_spends.require_rejection(code,text,reason)
    def test_recovery_requires_exact_tip_not_just_height(self):
        good={'chain':'regtest','blocks':1355,'bestblockhash':'a'*64}
        self.assertTrue(native_spends.tip_matches(good,1355,'a'*64))
        for changes in [{'chain':'main'},{'blocks':True},{'blocks':0},{'bestblockhash':'b'*64}]:
            self.assertFalse(native_spends.tip_matches({**good,**changes},1355,'a'*64))
    def test_recovery_inspects_framed_records_and_exact_tip_before_restart(self):
        header=bytes(range(80));tip=native_spends.hash256(header)[::-1].hex()
        frame=bytes.fromhex('fabfb5da')+(81).to_bytes(4,'little')+header+b'X'
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'blk00000.dat';path.write_bytes(frame+b'\0'*32)
            proof=native_spends.inspect_block_files(Path(tmp),tip)
            self.assertEqual(proof[0]['records'],1)
            with self.assertRaisesRegex(ValueError,'tip missing'):
                native_spends.inspect_block_files(Path(tmp),'0'*64)
            for damaged in [frame[:-1],frame+b'bad',bytes.fromhex('c0c0c0c0')+frame[4:]]:
                path.write_bytes(damaged)
                with self.assertRaises(ValueError):native_spends.inspect_block_files(Path(tmp),tip)
    def test_signed_recovery_is_exclusive_fsynced_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'refund.hex'
            native_spends.persist_signed(path,b'public synthetic tx')
            self.assertEqual(bytes.fromhex(path.read_text().strip()),b'public synthetic tx')
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):native_spends.persist_signed(path,b'different')
            link=Path(tmp)/'link.hex';link.symlink_to(path)
            with self.assertRaises(OSError):native_spends.persist_signed(link,b'different')
    def test_manifest_never_promotes_financial_qualification(self):
        with patch('subprocess.run',side_effect=AssertionError('process')),patch('ctypes.CDLL',side_effect=AssertionError('native')):
            m=native_spends.manifest()
        self.assertEqual(m['qualificationStatus'],'BLOCKED')
        self.assertFalse(m['externalNetwork']);self.assertFalse(m['acceptNonstandard'])
        self.assertIsNone(m['promiscuousMempoolFlags'])
        self.assertNotIn('signrawtransaction',m['rpcAllowlist'])
        self.assertNotIn('sendtoaddress',m['rpcAllowlist'])
        self.assertEqual(m['maxGeneratedBlocks'],1360)
    def test_wrong_authorization_rejects_before_any_native_or_network_operation(self):
        with patch('subprocess.check_output',side_effect=AssertionError('process')),patch('ctypes.CDLL',side_effect=AssertionError('native')):
            with self.assertRaisesRegex(ValueError,'scope'):native_spends.run(argparse.Namespace(authorization='wrong'))
    def test_same_namespace_rejects_before_provenance_keys_and_native_loading(self):
        with patch('os.readlink',return_value='net:[1]'),patch('subprocess.check_output',return_value='[{"ifname":"lo","flags":["UP"]}]'),patch('ctypes.CDLL',side_effect=AssertionError('native')),patch('native_spends.EphemeralSigner',side_effect=AssertionError('key')):
            with self.assertRaisesRegex(ValueError,'distinct Linux'):native_spends.run(argparse.Namespace(authorization=native_spends.AUTHORIZATION,parent_net_ns='net:[1]'))
    def test_nonloopback_interface_rejects_before_native_or_keys(self):
        with patch('os.readlink',return_value='net:[2]'),patch('subprocess.check_output',return_value='[{"ifname":"eth0","flags":["UP"]}]'),patch('ctypes.CDLL',side_effect=AssertionError('native')),patch('native_spends.EphemeralSigner',side_effect=AssertionError('key')):
            with self.assertRaisesRegex(ValueError,'loopback'):native_spends.run(argparse.Namespace(authorization=native_spends.AUTHORIZATION,parent_net_ns='net:[1]'))

if __name__=='__main__':unittest.main()
