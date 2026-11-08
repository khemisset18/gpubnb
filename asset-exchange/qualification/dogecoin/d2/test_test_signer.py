import hashlib
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from test_signer import (ORDER, EphemeralSigner, compact, push, transaction,
                         sighash, encode_der, decode_der, hash256)

class TestSignerTests(unittest.TestCase):
    def test_minimal_push_and_compact_boundaries(self):
        self.assertEqual(push(b'a'*75)[:1], b'\x4b')
        self.assertEqual(push(b'a'*76)[:2], b'\x4c\x4c')
        self.assertEqual(push(b'a'*256)[:3], b'\x4d\x00\x01')
        self.assertEqual(compact(253), b'\xfd\xfd\x00')
        for n in [-1, True, 10001]:
            with self.assertRaises(ValueError): compact(n)
    def test_legacy_preimage_independent_fixed_serialization(self):
        txid = '01'*32
        expected = bytes.fromhex('0100000001'+'01'*32+'020000000151feffffff010700000000000000015109000000')
        self.assertEqual(transaction(txid,2,b'\x51',[(7,b'\x51')],9), expected)
        self.assertEqual(sighash(txid,2,b'\x51',[(7,b'\x51')],9),hash256(expected+b'\x01\0\0\0'))
    def test_each_signed_field_changes_digest(self):
        base = ('01'*32, 2, b'\x51', [(7,b'\x51')],9,0xfffffffe)
        original=sighash(*base)
        for i,value in enumerate(['02'*32,3,b'\x52',[(8,b'\x51')],10,0xffffffff]):
            args=list(base);args[i]=value
            self.assertNotEqual(sighash(*args),original)
    def test_amount_and_type_bounds(self):
        for amount in [True,-1,10**19,1.5]:
            with self.assertRaises(ValueError):transaction('01'*32,0,b'',[(amount,b'\x51')])
        with self.assertRaises(ValueError):transaction('01'*32,0,b'',[(10**18,b'\x51'),(1,b'\x51')])
    def test_der_strictness_and_low_s_encoding(self):
        for r,s in [(1,1),(128,255),(ORDER-1,ORDER-1)]:
            self.assertEqual(decode_der(encode_der(r,s)),(r,s))
        for raw in [b'',bytes.fromhex('3006020100020101'),bytes.fromhex('300702020001020101'),encode_der(1,1)+b'\0']:
            with self.assertRaises(ValueError):decode_der(raw)
    def test_openssl_signatures_are_distinct_low_s_and_independently_verify(self):
        with tempfile.TemporaryDirectory() as tmp:
            a,b=EphemeralSigner(tmp,'claim'),EphemeralSigner(tmp,'refund')
            try:
                self.assertNotEqual(a.public,b.public)
                digest=hash256(b'GPUBNB private regtest test only')
                sig=a.sign(digest)
                self.assertEqual(sig[-1],1)
                self.assertLessEqual(decode_der(sig[:-1])[1],ORDER//2)
                path=Path(tmp)/'public-signature.der';path.write_bytes(sig[:-1])
                result=subprocess.run(['/usr/bin/openssl','pkeyutl','-verify','-inkey',str(a.path),'-sigfile',str(path),'-pkeyopt','digest:sha256'],input=digest,capture_output=True)
                self.assertEqual(result.returncode,0,result.stderr)
                wrong=subprocess.run(['/usr/bin/openssl','pkeyutl','-verify','-inkey',str(b.path),'-sigfile',str(path),'-pkeyopt','digest:sha256'],input=digest,capture_output=True)
                self.assertNotEqual(wrong.returncode,0)
            finally:a.destroy();b.destroy()
            self.assertFalse(a.path.exists());self.assertFalse(b.path.exists())

if __name__=='__main__': unittest.main()
