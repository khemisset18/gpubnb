import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cleanroom
from recovery_core import Rpc


class CleanroomBoundaries(unittest.TestCase):
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


if __name__=='__main__':unittest.main()
