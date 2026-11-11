import argparse
import hashlib
import os
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import multinode

class MultiNodeGuards(unittest.TestCase):
    def test_readiness_client_failures_are_not_counted_as_server_requests(self):
        self.assertTrue(multinode.rpc_reached_server(0,''))
        self.assertTrue(multinode.rpc_reached_server(5,'error code: -5\nerror message:\nmissing'))
        self.assertTrue(multinode.rpc_reached_server(28,'error code: -28\nloading'))
        self.assertFalse(multinode.rpc_reached_server(1,'Could not locate RPC credentials'))
        self.assertFalse(multinode.rpc_reached_server(1,'Could not connect to server'))

    def context(self):
        return {'addresses':{'a':'public-a','b':'public-b'},'blocks':{'a'*64},'txids':{'b'*64},'submitted':{'00'}}
    def test_native_workflow_has_only_manual_dispatch_and_reviewed_source_guard(self):
        repo=Path(__file__).resolve().parents[4]
        text=(repo/'.github/workflows/asset-exchange-dogecoin-multinode.yml').read_text()
        events=text.split('on:\n',1)[1].split('\npermissions:',1)[0]
        self.assertEqual(re.findall(r'^  ([a-z_]+):',events,re.MULTILINE),['workflow_dispatch','workflow_call'])
        self.assertIn("github.event_name == 'workflow_dispatch'",text)
        for marker in ['execution_commit:','harness_commit:','authorization:',
            "os.environ['EXECUTION_COMMIT']==os.environ['GITHUB_SHA']",
            'git diff --exit-code "$HARNESS_COMMIT" HEAD',
            '.github/workflows/asset-exchange-dogecoin-multinode.yml']:
            self.assertIn(marker,text)
    def test_registered_manual_entry_cannot_start_native_jobs_from_push_or_pr(self):
        repo=Path(__file__).resolve().parents[4]
        text=(repo/'.github/workflows/workspace-reliability.yml').read_text()
        for name in ['doge-d3-private-manual','doge-recovery-multinode-private-manual']:
            section=text.split('\n  '+name+':\n',1)[1].split('\n  doge-',1)[0]
            condition=next(line for line in section.splitlines() if line.strip().startswith('if:'))
            self.assertIn("github.event_name == 'workflow_dispatch'",condition)
            self.assertIn("github.repository_id == '1305325878'",condition)
            self.assertIn("refs/heads/asset-exchange/doge-independent-recovery-20261111",condition)
            self.assertIn('uses: ./.github/workflows/asset-exchange-dogecoin-',section)
    def test_existing_signer_roles_and_paths_are_reused_without_collisions(self):
        specs=multinode.test_key_specs(Path('/fixed/test-keys'))
        self.assertEqual(len({d/(role+'.pem') for d,role in specs}),4)
        self.assertTrue(all(role in ('miner','claim','refund') for _,role in specs))
        self.assertEqual([role for _,role in specs].count('miner'),2)
    def test_manifest_has_two_fixed_loopback_nodes_and_never_qualifies(self):
        with patch('subprocess.run',side_effect=AssertionError('native process forbidden')):
            m=multinode.manifest()
        self.assertEqual(m['nodes'],2);self.assertEqual(m['maxGeneratedBlocks'],1370)
        self.assertEqual(m['qualificationStatus'],'BLOCKED');self.assertFalse(m['settlementAllowed'])
        self.assertFalse(m['walletEnabled']);self.assertFalse(m['externalNetwork'])
        self.assertEqual(m['peerEndpoints'],['127.0.0.1:18444','127.0.0.1:18445'])
        self.assertNotIn('sendtoaddress',m['rpcAllowlist']);self.assertNotIn('signrawtransaction',m['rpcAllowlist'])
    def test_unapproved_scope_fails_before_any_native_or_file_access(self):
        with patch('subprocess.check_output',side_effect=AssertionError('process')):
            with self.assertRaisesRegex(ValueError,'scope'):multinode.run(argparse.Namespace(authorization='wrong'))
    def test_same_namespace_fails_before_provenance_and_keys(self):
        with patch('os.readlink',return_value='net:[1]'),patch('subprocess.check_output',return_value='[{"ifname":"lo","flags":["UP"]}]'),patch('multinode.EphemeralSigner',side_effect=AssertionError('key')):
            with self.assertRaisesRegex(ValueError,'distinct Linux'):
                multinode.run(argparse.Namespace(authorization=multinode.AUTHORIZATION,parent_net_ns='net:[1]'))
    def test_nonloopback_interface_fails_before_provenance_and_keys(self):
        with patch('os.readlink',return_value='net:[2]'),patch('subprocess.check_output',return_value='[{"ifname":"eth0","flags":["UP"]}]'),patch('multinode.EphemeralSigner',side_effect=AssertionError('key')):
            with self.assertRaisesRegex(ValueError,'loopback'):
                multinode.run(argparse.Namespace(authorization=multinode.AUTHORIZATION,parent_net_ns='net:[1]'))
    def test_rpc_routes_only_to_fixed_opposite_private_node(self):
        multinode.validate_rpc('a','addnode',('127.0.0.1:18445','onetry'),**self.context())
        for node,method,args in [('a','addnode',('127.0.0.1:18444','onetry')),
            ('a','addnode',('example.com:18445','onetry')),('b','addnode',('8.8.8.8:18444','onetry')),
            ('a','addnode',('127.0.0.1:18445','add')),('a','setnetworkactive',('1',)),
            ('a','sendrawtransaction',('01',)),('a','getblockhash',('01',)),
            ('a','getblockhash',('1371',)),('c','getblockchaininfo',()),('a','getblockheader',('0'*64,))]:
            with self.subTest(node=node,method=method,args=args),self.assertRaises(ValueError):
                multinode.validate_rpc(node,method,args,**self.context())
    def test_mining_is_fixed_count_destination_and_effort(self):
        multinode.validate_rpc('a','generatetoaddress',('1352','public-a','1000000','0'),**self.context())
        multinode.validate_rpc('a','generatetoaddress',('1','public-a','1000000','1'),**self.context())
        for args in [('1370','public-a','1000000','0'),('1','public-b','1000000','1'),('1','public-a','1000001','1'),('1','public-a','1000000','0'),('1352','public-a','1000000','1')]:
            with self.assertRaises(ValueError):multinode.validate_rpc('a','generatetoaddress',args,**self.context())
    def test_observed_peers_never_accept_external_or_unbounded_endpoints(self):
        self.assertEqual(multinode.check_peers([{'addr':'127.0.0.1:42000'}]),[{'addr':'127.0.0.1:42000'}])
        for rows in [[{'addr':'192.0.2.1:18444'}],[{'addr':'[::1]:18444'}],[{'addr':'127.0.0.1:65536'}],[{'addr':'127.0.0.1:0'}],[{'addr':'127.0.0.1:1'}]*2]:
            with self.assertRaises(ValueError):multinode.check_peers(rows)
    def test_missing_transaction_is_unknown_not_a_confirmed_or_conflicted_fact(self):
        chain={'chain':'regtest','blocks':1359,'bestblockhash':'a'*64}
        row=multinode.normalize_observation('a',chain,None,False)
        self.assertFalse(row['transactionFound']);self.assertEqual(row['confirmations'],0)
        self.assertIsNone(row['blockHash']);self.assertEqual(row['conflictStatus'],'NONE')
        for observed in [{'txid':'b'*64,'confirmations':True},{'txid':'b'*64,'confirmations':1361}, {'txid':'b'*64,'confirmations':1}]:
            with self.assertRaises(ValueError):multinode.normalize_observation('a',chain,observed,False)
    def test_public_bundle_requires_exclusive_durable_creation(self):
        bundle={'domain':'test public bundle','value':7}
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'bundle.json';digest=multinode.persist_bundle(p,bundle)
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(),digest)
            self.assertEqual(p.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):multinode.persist_bundle(p,{'other':1})
            for failed_call in [1,2]:
                with patch('multinode.os.fsync',side_effect=[None]*(failed_call-1)+[OSError('injected fsync failure')]):
                    with self.assertRaises(OSError):multinode.persist_bundle(Path(tmp)/str(failed_call),bundle)

if __name__=='__main__':unittest.main()
