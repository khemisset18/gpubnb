import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import cleanroom
from recovery_core import Rpc


class CleanroomBoundaries(unittest.TestCase):
    def test_different_known_refusal_is_retained_and_still_fails_the_expectation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'evidence';out.mkdir()
            hidden=[root/name for name in ('backend','node-a','keys')]
            for path in hidden:path.mkdir()
            node=root/'node-b';(node/'regtest').mkdir(parents=True)
            (node/'regtest'/'.cookie').write_bytes(b'test-service:fixture')
            clean=root/'recovery-cleanroom-18332-funding-reorg'
            (clean/'rpc'/'regtest').mkdir(parents=True)
            (clean/'doge-recovery.pyz').write_bytes(b'test package')
            cleanroom.PACKAGE_DIGESTS[str(clean)]=hashlib.sha256(b'test package').hexdigest()
            actual='node has an unresolved header lead; no broadcast'
            refusal={'state':'UNKNOWN','error':actual,'automaticSettlement':False}
            child=Mock(returncode=1)
            child.communicate.return_value=('',json.dumps(refusal))
            process=Mock();process.__enter__=Mock(return_value=child);process.__exit__=Mock(return_value=False)
            context={'bundlePath':'unused','bundleSha256':'0'*64,'cliPath':'unused',
                'nodeBDataDirectory':str(node),'nodeBRpcPort':18332,
                **dict(zip(('backendDirectoryToHide','nodeADataDirectoryToHide','originalKeysDirectoryToHide'),
                           map(str,hidden))),
                'parentNetNs':'test-net','parentMountNs':'test-mount','evidenceDirectory':str(out),
                'mode':'rebroadcast','labLabel':'funding-reorg',
                'expectedError':'funding is not confirmed on active chain; no broadcast'}
            try:
                with patch('cleanroom.load_bundle'),patch('cleanroom.subprocess.Popen',return_value=process):
                    with self.assertRaisesRegex(ValueError,'different recovery refusal observed'):
                        cleanroom.run_recovery_hook(context)
                retained=out/'cleanroom-refusal-18332-funding-reorg-rebroadcast.json'
                self.assertTrue(retained.is_file(),'actual refusal was lost from native failure evidence')
                self.assertEqual(json.loads(retained.read_bytes()),refusal)
            finally:cleanroom.PACKAGE_DIGESTS.pop(str(clean),None)

    def test_private_service_cookie_rotates_after_restart_without_exposing_original_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';target=root/'copy'
            source.write_bytes(b'test-service:old');cleanroom.refresh_service_cookie(source,target)
            self.assertEqual(target.read_bytes(),b'test-service:old')
            source.write_bytes(b'test-service:rotated');cleanroom.refresh_service_cookie(source,target)
            self.assertEqual(target.read_bytes(),b'test-service:rotated')
            self.assertEqual(target.stat().st_mode&0o777,0o600)
            self.assertFalse(list(root.glob('.rpc-cookie-*')))

    def test_cookie_destination_symlink_refuses_and_hardlink_is_replaced_without_modifying_victim(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';target=root/'copy';victim=root/'victim'
            source.write_bytes(b'test-only');victim.write_bytes(b'preserve')
            target.symlink_to(victim)
            with self.assertRaisesRegex(ValueError,'symlink'):cleanroom.refresh_service_cookie(source,target)
            self.assertEqual(victim.read_bytes(),b'preserve');target.unlink()
            os.link(victim,target);cleanroom.refresh_service_cookie(source,target)
            self.assertEqual(victim.read_bytes(),b'preserve');self.assertEqual(target.read_bytes(),b'test-only')

    def test_bad_rpc_budget_refuses_before_namespace_binary_or_network_access(self):
        with patch('subprocess.check_output',side_effect=AssertionError('process forbidden')):
            for budget in [0,65,-1,True,'1',None]:
                with self.assertRaisesRegex(ValueError,'budget'):Rpc('unused','unused',18332,'unused',budget)

    def test_smaller_rpc_budget_stops_before_the_next_subprocess(self):
        rpc=Rpc.__new__(Rpc);rpc.maximum_calls=1;rpc.calls=[];rpc.base=['unused']
        with patch('subprocess.run',return_value=subprocess.CompletedProcess([],0,'{}','')) as run:
            self.assertEqual(rpc('getmempoolinfo'),{})
            with self.assertRaisesRegex(ValueError,'budget'):rpc('getmempoolinfo')
        self.assertEqual(run.call_count,1)

    def test_cleanroom_scope_refuses_bad_budget_or_directory_label_before_files(self):
        context={key:'unused' for key in ('bundlePath','bundleSha256','cliPath','nodeBDataDirectory','nodeBRpcPort',
            'backendDirectoryToHide','nodeADataDirectoryToHide','originalKeysDirectoryToHide','parentNetNs',
            'parentMountNs','evidenceDirectory')}
        context['mode']='observe'
        with patch('cleanroom.Path.resolve',side_effect=AssertionError('file access forbidden')):
            for changes in [{'maxRpcCalls':0},{'maxRpcCalls':True},{'labLabel':'../outside'},
                            {'labLabel':'a'*33},{'expectedError':'ignore any error'}]:
                with self.assertRaises(ValueError):cleanroom.run_recovery_hook(context|changes)

    def test_disconnected_incident_cannot_be_used_for_rebroadcast_or_arbitrary_failure_suppression(self):
        context={key:'unused' for key in ('bundlePath','bundleSha256','cliPath','nodeBDataDirectory','nodeBRpcPort',
            'backendDirectoryToHide','nodeADataDirectoryToHide','originalKeysDirectoryToHide','parentNetNs',
            'parentMountNs','evidenceDirectory')}
        context['mode']='observe'
        with patch('cleanroom.Path.resolve',side_effect=AssertionError('file access forbidden')):
            for change in [{'disconnectBlockchain':True},{'expectedError':'RPC getblockchaininfo failed'},
                    {'disconnectBlockchain':'yes'}, {'disconnectBlockchain':True,'expectedError':'RPC getblockchaininfo failed','mode':'rebroadcast'}]:
                with self.assertRaises(ValueError):cleanroom.run_recovery_hook(context|change)


if __name__=='__main__':unittest.main()
