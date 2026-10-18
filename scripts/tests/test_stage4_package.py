import copy
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('stage4', Path(__file__).parents[1]/'verify_stage4_package.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
COMMIT = '1234567890abcdef1234567890abcdef12345678'
PIN = '200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'


def fixture_pe():
    b = bytearray(1024)
    b[:2] = b'MZ'
    struct.pack_into('<I', b, 60, 128)
    b[128:132] = b'PE\0\0'
    struct.pack_into('<HH', b, 132, 0x8664, 1)
    struct.pack_into('<H', b, 148, 240)
    struct.pack_into('<H', b, 152, 0x20b)
    struct.pack_into('<I', b, 260, 16)
    struct.pack_into('<II', b, 272, 0x1000, 40)
    struct.pack_into('<IIII', b, 400, 512, 0x1000, 512, 512)
    struct.pack_into('<I', b, 524, 0x1040)
    b[576:589] = b'KERNEL32.dll\0'
    return b


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for n in s.NAMES:
            (self.root/n).write_bytes(fixture_pe())
        self.identity = {
            'agent': {'frozen': True, 'agentVersion': '0.6.6', 'buildCommit': COMMIT[:12]},
            'agentRuntime': {'idnaCodec': True, 'dnsResolution': True, 'tlsContext': True},
            'helper': {'sourceCommit': COMMIT, 'workerSignerSha256': PIN, 'mutationAuthority': 'release-candidate',
                       'workerProtocol': 1, 'mediaTransportProtocol': 2, 'browserMediaProtocol': 1, 'browserInputProtocol': 1},
            'worker': {'sourceCommit': COMMIT, 'mediaSignerSha256': PIN},
            'media': {'sourceCommit': COMMIT, 'mediaAbi': 2, 'nvencApi': '13.0'}}
        (self.root/'build-identities.json').write_text(json.dumps(self.identity))
        self.proof = s.create(self.root, COMMIT, PIN)

    def tearDown(self): self.tmp.cleanup()

    def verify(self, **kwargs):
        return s.verify(self.root, kwargs.get('digest', self.proof['manifestSha256']),
                        kwargs.get('commit', COMMIT), kwargs.get('pin', PIN))

    def mutate_manifest(self, fn):
        p = self.root/'stage4.manifest.json'
        m = json.loads(p.read_text()); fn(m); p.write_text(json.dumps(m))
        self.proof['manifestSha256'] = s.sha(p)

    def test_positive_four_components_exact_identity_imports(self):
        m = self.verify()
        self.assertEqual(len(m['files']), 4)
        self.assertEqual(m['files'][0]['imports'], ['kernel32.dll'])
        self.assertFalse(m['installable'])

    def test_wrong_commit_even_if_manifest_hash_is_correct(self):
        with self.assertRaisesRegex(ValueError, 'commit_mismatch'): self.verify(commit='a'*40)

    def test_wrong_or_placeholder_pin(self):
        for pin in ['0'*64, '1'*64, 'ab'*32]:
            with self.subTest(pin=pin), self.assertRaises(ValueError): self.verify(pin=pin)

    def test_manifest_tampering(self):
        with self.assertRaisesRegex(ValueError, 'manifest_hash_mismatch'): self.verify(digest='a'*64)

    def test_missing_and_changed_binary(self):
        p=self.root/s.NAMES[0]; original=p.read_bytes(); p.unlink()
        with self.assertRaisesRegex(ValueError, 'component_missing'): self.verify()
        p.write_bytes(original+b'changed')
        with self.assertRaisesRegex(ValueError, 'component_hash_mismatch'): self.verify()

    def test_duplicate_or_traversal_manifest_entry(self):
        for name in [s.NAMES[1], '../gpubnb-agent.exe']:
            with self.subTest(name=name):
                self.mutate_manifest(lambda m: m['files'][0].update(name=name))
                with self.assertRaisesRegex(ValueError, 'exactly_four'): self.verify()

    def test_architecture_is_read_from_actual_pe(self):
        p=self.root/s.NAMES[0];b=bytearray(p.read_bytes());struct.pack_into('<H',b,132,0x14c);p.write_bytes(b)
        self.mutate_manifest(lambda m:m['files'][0].update(sha256=s.sha(p)))
        with self.assertRaisesRegex(ValueError, 'not_amd64'): self.verify()

    def test_imports_cannot_be_hidden_in_manifest(self):
        self.mutate_manifest(lambda m:m['files'][0].update(imports=[]))
        with self.assertRaisesRegex(ValueError, 'pe_metadata_mismatch'): self.verify()

    def test_bad_abi_or_pins_or_agent_identity(self):
        for component,field,value in [('agent','frozen',False),('agent','agentVersion','0.0.0'),
                                     ('helper','workerSignerSha256','ab'*32),('worker','sourceCommit','a'*40),
                                     ('helper','mutationAuthority','physical-qualification'),
                                     ('helper','mediaTransportProtocol',1),('media','mediaAbi',1),
                                     ('agentRuntime','tlsContext',False)]:
            identity=copy.deepcopy(self.identity);identity[component][field]=value
            with self.subTest(component=component,field=field),self.assertRaises(ValueError):
                s.check_identity(identity,COMMIT,PIN)

    def test_key_files_extra_binaries_and_symlinks_rejected(self):
        for name in ['private.pfx','test.key','.env','other.exe']:
            p=self.root/name;p.write_text('not a secret')
            with self.subTest(name=name),self.assertRaises(ValueError): self.verify()
            p.unlink()
        link=self.root/'link.txt'
        try:link.symlink_to(self.root/'SHA256SUMS')
        except OSError:return
        with self.assertRaisesRegex(ValueError, 'link_forbidden'):self.verify()

    def test_unsigned_never_becomes_release_by_changing_a_flag(self):
        self.mutate_manifest(lambda m:m.update(installable=True))
        with self.assertRaisesRegex(ValueError, 'policy_mismatch'):self.verify()

    def test_partial_signing_marker_prevents_reuse_even_with_valid_hashes(self):
        (self.root/'INCOMPLETE-DO-NOT-INSTALL.txt').write_text('previous signing failed')
        with self.assertRaisesRegex(ValueError, 'incomplete_package_forbidden'):self.verify()

    def test_malformed_pe_bounds_are_rejected(self):
        p=self.root/'bad.exe'
        for offset in [0,0x7fffffff,900]:
            b=fixture_pe();struct.pack_into('<I',b,60,offset);p.write_bytes(b)
            with self.subTest(offset=offset),self.assertRaises(ValueError):s.pe_info(p)


if __name__ == '__main__':unittest.main()
