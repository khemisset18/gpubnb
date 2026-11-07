import argparse
import json
from pathlib import Path
import unittest
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
