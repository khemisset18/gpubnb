import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import multinode
import vm_recovery as vm


def public_stream():
    previous=vm.GENESIS;stream=bytearray();blocks=[]
    for i in range(1355):
        header=struct.pack('<I',1)+bytes.fromhex(previous)[::-1]+bytes(32)+struct.pack('<III',i,1,i)
        previous=vm.hash256(header)[::-1].hex();blocks.append(previous)
        stream+=vm.MAGIC+struct.pack('<I',81)+header+b'\x00'
    return bytes(stream),blocks


class IndependentVmBoundaries(unittest.TestCase):
    def test_public_replay_rejects_network_truncation_trailing_data_and_wrong_chain_order(self):
        raw,blocks=public_stream();vm.check_stream(raw,blocks)
        for data,ids in [(b'bad!'+raw[4:],blocks),(raw[:-1],blocks),(raw+b'x',blocks),
                         (raw,list(reversed(blocks))),(raw,blocks[:-1])]:
            with self.assertRaises(ValueError):vm.check_stream(data,ids)

    def test_public_replay_binds_each_native_header_identity_not_only_the_stream_digest(self):
        raw,blocks=public_stream();changed=bytearray(raw);changed[8+40]^=1
        with self.assertRaisesRegex(ValueError,'identity/order'):vm.check_stream(bytes(changed),blocks)

    def fixture(self,root):
        stream,blocks=public_stream()
        for name in (*vm.RUNTIME,*vm.PAYLOAD):
            p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'public fixture')
        (root/'public-chain.dat').write_bytes(stream)
        manifest={'schemaVersion':1,'executionCommit':'a'*40,'producerBootHash':'b'*64,'originBootHash':'b'*64,
            'phase':'prepared','blocks':blocks,'addresses':{},'preparedFixtureSha256':{},
            'bundleDigests':{x:'c'*64 for x in ('main','cap','parent','conflict')},
            'files':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in (*vm.RUNTIME,*vm.PAYLOAD)}}
        raw=json.dumps(manifest).encode();(root/'parcel.json').write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def test_unexpected_secret_file_and_empty_server_directory_refuse_before_bundle_loading(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(vm,'load_bundle') as load:
            root=Path(tmp);digest=self.fixture(root);vm.load_parcel(root,digest);load.reset_mock()
            (root/'private-key.pem').write_text('disposable test sentinel')
            with self.assertRaisesRegex(ValueError,'unexpected or missing'):vm.load_parcel(root,digest)
            load.assert_not_called();(root/'private-key.pem').unlink();(root/'apps').mkdir()
            with self.assertRaisesRegex(ValueError,'unexpected handoff directory'):vm.load_parcel(root,digest)
            load.assert_not_called()

    def test_copied_runtime_tampering_and_symlink_are_rejected_against_retained_receipt(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(vm,'load_bundle') as load:
            root=Path(tmp);digest=self.fixture(root);target=root/vm.RUNTIME[0]
            target.write_bytes(b'altered runtime')
            with self.assertRaisesRegex(ValueError,'file digest'):vm.load_parcel(root,digest)
            load.assert_not_called();target.unlink();target.symlink_to(root/'fixtures.json')
            with self.assertRaisesRegex(ValueError,'symlink'):vm.load_parcel(root,digest)
            load.assert_not_called()

    def test_changed_manifest_cannot_supply_its_own_receipt(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(vm,'load_bundle') as load:
            root=Path(tmp);digest=self.fixture(root);m=json.loads((root/'parcel.json').read_text())
            m['executionCommit']='d'*40;(root/'parcel.json').write_text(json.dumps(m))
            with self.assertRaisesRegex(ValueError,'independent handoff digest'):vm.load_parcel(root,digest)
            load.assert_not_called()

    def test_only_vm_scopes_can_export_raw_blocks_and_consumers_cannot_remine_seed_chain(self):
        context={'addresses':{'a':'private-a','b':'private-b'},'blocks':{'a'*64},'txids':set(),'submitted':set()}
        for suite in multinode.VM_SUITES:
            multinode.validate_rpc('a','getblock',('a'*64,'false'),**context,lab_suite=suite)
        for suite in ('multinode','fee-pinning'):
            with self.assertRaises(ValueError):multinode.validate_rpc('a','getblock',('a'*64,'false'),**context,lab_suite=suite)
        for suite in ('recovery-independent','recovery-resume'):
            with self.assertRaisesRegex(ValueError,'remine'):
                multinode.validate_rpc('a','generatetoaddress',('1352','private-a','1000000','0'),**context,lab_suite=suite)
            self.assertFalse(multinode.manifest(suite)['signingAllowed'])

    def test_recovery_vm_jobs_have_no_checkout_cache_or_automatic_native_trigger(self):
        root=Path(__file__).resolve().parents[4]
        workflow=(root/'.github/workflows/asset-exchange-dogecoin-multinode.yml').read_text()
        for job in ('independent-vm','replacement-vm'):
            body=workflow.split('\n  '+job+':\n',1)[1].split('\n  replacement-vm:\n',1)[0]
            self.assertIn("github.event_name == 'workflow_dispatch'",body)
            self.assertIn('refs/heads/asset-exchange/doge-vm-recovery-20261111',body)
            self.assertIn('runs-on: ubuntu-24.04',body)
            self.assertNotIn('uses: actions/checkout',body);self.assertNotIn('uses: actions/cache',body)
            self.assertIn('EXPECTED_HANDOFF_SHA256',body)
        caller=(root/'.github/workflows/workspace-reliability.yml').read_text()
        self.assertIn("inputs.doge_suite == 'vm-recovery'",caller)
        self.assertIn("inputs.doge_suite != 'vm-recovery'",caller)


if __name__=='__main__':unittest.main()
