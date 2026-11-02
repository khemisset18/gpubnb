import os
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from gpubnb_agent.windows_agent_process_proof import measure_windows_agent_process

class ProcessProofTests(unittest.TestCase):
    def test_source_interpreter_cannot_claim_signed_agent(self):
        with patch('platform.system', return_value='Windows'), patch('sys.frozen', False, create=True):
            self.assertIsNone(measure_windows_agent_process('machine', 'challenge'))

    def test_measurement_is_bound_to_current_pid_and_challenge(self):
        with patch('platform.system', return_value='Windows'), patch('sys.frozen', True, create=True), patch('subprocess.run', return_value=SimpleNamespace(stdout='{"pid":'+str(os.getpid())+'}')):
            p=measure_windows_agent_process('machine-a', 'nonce-a')
            self.assertEqual(p['machineId'], 'machine-a')
            self.assertEqual(p['challenge'], 'nonce-a')
            self.assertEqual(p['pid'], os.getpid())

    def test_wrong_pid_and_measurement_outage_fail_closed(self):
        with patch('platform.system', return_value='Windows'), patch('sys.frozen', True, create=True):
            with patch('subprocess.run', return_value=SimpleNamespace(stdout='{"pid":0}')):
                self.assertIsNone(measure_windows_agent_process('machine', 'challenge'))
            with patch('subprocess.run', side_effect=OSError('offline')):
                self.assertIsNone(measure_windows_agent_process('machine', 'challenge'))
