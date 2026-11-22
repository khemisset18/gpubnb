"""Real external-process protocol tests with disposable software-test keys only."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import select
import signal
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import external_signer as broker
import refund_ladder as policy
from offline_candidate import build_candidate
from test_signer import EphemeralSigner, transaction


@unittest.skipUnless(os.name == 'posix', 'external signer v1 qualifies POSIX only')
class ExternalSignerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory(prefix='doge-external-fixture-keys-')
        cls.claim = EphemeralSigner(cls.keys.name, 'claim')
        cls.refund = EphemeralSigner(cls.keys.name, 'refund')
        contract = build_candidate(hashlib.sha256(b'external software fixture').digest(),
                                   cls.claim.public, cls.refund.public, 1355)
        raw = transaction('01' * 32, 0, b'\x51', [(10_000_000_000, contract.output)])
        cls.request = policy.create_refund_signing_request(
            contract={'redeemHex': contract.redeem.hex(), 'outputHex': contract.output.hex()},
            funding={'txid': policy.txid(raw), 'vout': 0, 'valueKoinu': '10000000000',
                     'transactionHex': raw.hex()},
            policy={'maxFeeKoinu': '100000000', 'minRefundKoinu': '9900000000'},
            destination_hex='76a914' + '11' * 20 + '88ac',
            fees=['1000000', '10000000', '100000000'], request_id='external_fixture_v1',
            created_at_height=1352, request_expires_at_height=1360)

    @classmethod
    def tearDownClass(cls):
        cls.claim.destroy()
        cls.refund.destroy()
        cls.keys.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='doge-external-broker-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.signer_root = self.root / 'separate-test-signer'
        self.signer_root.mkdir(mode=0o700)
        self.key = self.signer_root / 'refund.pem'
        fd = os.open(self.key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, self.refund.path.read_bytes())
        finally:
            os.close(fd)
        self.marker = self.signer_root / 'calls.txt'
        self.journal = self.root / 'broker-journal'
        self.package = self.make_package()
        self.pairing, self.receipt = self.pair(self.package)

    def pair(self, package):
        return broker.create_pairing(package,
            expected_adapter_sha256=hashlib.sha256(package).hexdigest(),
            refund_public_hex=self.refund.public.hex(), signer_id='external_test_signer',
            authorization=broker.PAIR_AUTHORIZATION)

    def make_package(self, mode='valid', approved_request=None):
        request = self.request if approved_request is None else approved_request
        main = f'''import copy, json, sys
from pathlib import Path
import external_signer as broker
from test_signer import EphemeralSigner
MODE={mode!r}
KEY={str(self.key)!r}
MARKER={str(self.marker)!r}
TERMS={request['termsDigest']!r}
REQUEST={request['requestDigest']!r}
NOW=1353
raw=sys.stdin.buffer.read(65537)
assert len(raw)<=65536
envelope=broker.decode(raw)
broker.policy.exact(envelope,[*broker.SESSION_FIELDS,'pairing','request','review'],'signer session')
assert envelope['domain']==broker.SEND_DOMAIN and type(envelope['schemaVersion']) is int and envelope['schemaVersion']==1
request=broker.policy.validate_refund_signing_request(envelope['request'],trusted_terms_digest=TERMS,trusted_request_digest=REQUEST,current_height=NOW)
review=broker.policy.signer_review_fields(request,trusted_terms_digest=TERMS,trusted_request_digest=REQUEST,current_height=NOW)
assert envelope['review']==review and envelope['reviewDigest']==broker.public_digest(broker.REVIEW_DOMAIN,review)
assert envelope['requestDigest']==REQUEST
pairing=broker.validate_pairing(envelope['pairing'],envelope['pairingDigest'])
signer=EphemeralSigner.__new__(EphemeralSigner)
signer.path=Path(KEY)
public=signer._run(['ec','-in',KEY,'-pubout','-conv_form','compressed','-outform','DER'])
assert public.startswith(broker.policy.SPKI_PREFIX)
signer.public=public[len(broker.policy.SPKI_PREFIX):]
assert signer.public.hex()==pairing['refundPublicHex']==review['refundPublicHex']
# This is disposable software-test approval, never a physical device/display claim.
assert b'PRIVATE KEY' not in raw
with Path(MARKER).open('ab') as out:out.write(b'approved-software-test-request\\n')
signatures=[signer.sign(bytes.fromhex(entry['sighashHex'])).hex() for entry in request['entries']]
response={{'domain':broker.policy.RESPONSE_DOMAIN,'schemaVersion':1,'requestId':request['requestId'],'requestDigest':REQUEST,'refundPublicHex':signer.public.hex(),'signatures':signatures}}
reply={{key:envelope[key] for key in broker.SESSION_FIELDS}}
reply.update(domain=broker.REPLY_DOMAIN,response=response)
if MODE=='wrong-session':reply['sessionId']='00'*16
if MODE=='wrong-challenge':reply['challenge']='00'*32
if MODE=='wrong-pairing':reply['pairingDigest']='00'*32
if MODE=='wrong-review':reply['reviewDigest']='00'*32
if MODE=='extra-outer':reply['deviceFirmware']='unqualified'
if MODE=='boolean-version':reply['schemaVersion']=True
if MODE=='wrong-role':response['refundPublicHex']={self.claim.public.hex()!r}
if MODE=='wrong-signature':response['signatures'][1]=response['signatures'][0]
if MODE=='extra-inner':response['deviceProfile']='not-qualified'
encoded=broker.encode(reply)
if MODE=='truncated':encoded=encoded[:-1]
if MODE=='trailing':encoded+=b'{{}}'
if MODE=='duplicate':encoded=encoded[:-1]+b',"domain":"duplicate"}}'
if MODE=='nonfinite':encoded=b'{{"domain":NaN}}'
if MODE=='invalid-utf8':encoded=b'\\xff'
sys.stdout.buffer.write(encoded)
'''
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('__main__.py', main)
            for filename in ('external_signer.py', 'external_transport.py', 'refund_ladder.py'):
                archive.writestr(filename, (HERE / filename).read_bytes())
            archive.writestr('transaction.py', (HERE.parents[1] / 'recovery/dogecoin/transaction.py').read_bytes())
            for name in ('htlc_codec', 'offline_candidate', 'spend_preparation', 'test_signer'):
                archive.writestr(name + '.py', (HERE.parents[1] / 'qualification/dogecoin/d2' / (name + '.py')).read_bytes())
        return output.getvalue()

    def run_request(self, request=None, package=None, pairing=None, receipt=None,
                    height_provider=None, journal=None, **extra):
        request = copy.deepcopy(self.request if request is None else request)
        args = dict(pairing=self.pairing if pairing is None else pairing,
            trusted_pairing_digest=self.receipt if receipt is None else receipt,
            trusted_terms_digest=self.request['termsDigest'],
            trusted_request_digest=self.request['requestDigest'],
            package=self.package if package is None else package,
            height_provider=(lambda: 1353) if height_provider is None else height_provider,
            journal_directory=self.journal if journal is None else journal)
        args.update(extra)
        return broker.request_refund_signatures(request, **args)

    def recover(self, **extra):
        args = dict(pairing=self.pairing, trusted_pairing_digest=self.receipt,
            trusted_terms_digest=self.request['termsDigest'],
            trusted_request_digest=self.request['requestDigest'], journal_directory=self.journal)
        args.update(extra)
        return broker.recover_completed_refunds(copy.deepcopy(self.request), **args)

    def test_real_child_signs_exact_refunds_parent_only_verifies_and_never_broadcasts(self):
        with patch.object(EphemeralSigner, 'sign', side_effect=AssertionError('parent must not sign')):
            result = self.run_request()
        self.assertFalse(result['hardwareQualified'])
        self.assertFalse(result['cached'])
        self.assertEqual([r['feeKoinu'] for r in result['refunds']], ['1000000', '10000000', '100000000'])
        self.assertEqual(len({r['txid'] for r in result['refunds']}), 3)
        self.assertEqual(len(self.marker.read_text().splitlines()), 1)
        self.assertEqual(policy.validate_refund_ladder(result['refunds'],
            contract=self.request['contract'], funding=self.request['funding'], policy=self.request['policy']), result['refunds'])

    def test_pairing_receipt_is_durable_exclusive_and_binds_package_and_key(self):
        path = self.root / 'pairing.json'
        broker.persist_pairing(path, self.pairing, self.receipt)
        self.assertEqual(broker.load_pairing(path, self.receipt), self.pairing)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            broker.persist_pairing(path, self.pairing, self.receipt)
        changed = dict(self.pairing, signerId='other_test_signer')
        with self.assertRaisesRegex(ValueError, 'retained receipt'):
            broker.validate_pairing(changed, self.receipt)
        with self.assertRaises(ValueError):
            broker.create_pairing(
                self.package + b'changed', expected_adapter_sha256=self.pairing['adapterSha256'],
                refund_public_hex=self.refund.public.hex(), signer_id='test_signer', authorization=broker.PAIR_AUTHORIZATION)

    def test_unsupported_hardware_mainnet_extra_fields_and_false_authorization_refuse(self):
        for field, value in [('signerKind', 'hardware'), ('network', 'main'), ('profile', 'trezor-doge'),
                             ('schemaVersion', True), ('deviceFirmware', 'self-certified')]:
            pairing = dict(self.pairing, **{field: value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.run_request(pairing=pairing, receipt=broker.public_digest(broker.PAIR_DOMAIN, pairing))
        with self.assertRaises(ValueError):
            broker.create_pairing(self.package, expected_adapter_sha256=self.pairing['adapterSha256'],
                refund_public_hex=self.refund.public.hex(), signer_id='test_signer', authorization=True)
        self.assertFalse(self.marker.exists())

    def test_package_substitution_and_wrong_paired_refund_key_refuse_before_launch(self):
        with self.assertRaises(ValueError):
            self.run_request(package=self.package + b'mutated')
        pairing = dict(self.pairing, refundPublicHex=self.claim.public.hex())
        with self.assertRaisesRegex(ValueError, 'approved refund key'):
            self.run_request(pairing=pairing, receipt=broker.public_digest(broker.PAIR_DOMAIN, pairing))
        self.assertFalse(self.marker.exists())

    def test_untrusted_request_digests_or_self_consistent_mutation_cannot_authorize_signing(self):
        other = policy.create_refund_signing_request(contract=self.request['contract'],
            funding=self.request['funding'], policy=self.request['policy'],
            destination_hex='76a914' + '22' * 20 + '88ac',
            fees=['1000000', '10000000', '100000000'], request_id=self.request['requestId'],
            created_at_height=1352, request_expires_at_height=1360)
        for request in [other, dict(self.request, requestDigest='00' * 32), dict(self.request, keyPath='forbidden.pem')]:
            with self.assertRaises(ValueError):
                self.run_request(request=request)
        self.assertFalse(self.marker.exists())

    def test_completed_request_returns_identical_cached_bytes_without_resigning(self):
        first = self.run_request()
        with patch('external_signer.external_transport.exchange', side_effect=AssertionError('must not launch twice')):
            second = self.run_request(height_provider=lambda: 2000)
        self.assertEqual(first['refunds'], second['refunds'])
        self.assertTrue(second['cached'])
        self.assertEqual(first['sessionId'], second['sessionId'])
        self.assertEqual(len(self.marker.read_text().splitlines()), 1)

    def test_completed_public_refunds_recover_without_adapter_keys_or_height_service(self):
        first = self.run_request()
        self.key.unlink()
        self.package = b''
        with patch('external_signer.external_transport.exchange', side_effect=AssertionError('offline recovery must not launch')):
            result = self.recover()
        self.assertEqual(result['refunds'], first['refunds'])

    def test_reusing_request_id_for_new_terms_refuses_even_with_new_approved_receipts(self):
        self.run_request()
        other = policy.create_refund_signing_request(contract=self.request['contract'],
            funding=self.request['funding'], policy=self.request['policy'], destination_hex=self.request['destinationHex'],
            fees=['10000000'], request_id=self.request['requestId'], created_at_height=1352, request_expires_at_height=1360)
        with self.assertRaisesRegex(ValueError, 'different terms'):
            self.run_request(request=other, trusted_terms_digest=other['termsDigest'], trusted_request_digest=other['requestDigest'])
        self.assertEqual(len(self.marker.read_text().splitlines()), 1)

    def test_session_pair_challenge_review_schema_and_extra_metadata_mismatches_refuse(self):
        for mode in ['wrong-session', 'wrong-challenge', 'wrong-pairing', 'wrong-review', 'extra-outer', 'boolean-version']:
            package = self.make_package(mode)
            pairing, receipt = self.pair(package)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.run_request(package=package, pairing=pairing, receipt=receipt, journal=self.root / mode)

    def test_wrong_signature_role_or_extra_financial_response_fields_refuse(self):
        for mode in ['wrong-signature', 'wrong-role', 'extra-inner']:
            package = self.make_package(mode)
            pairing, receipt = self.pair(package)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.run_request(package=package, pairing=pairing, receipt=receipt, journal=self.root / mode)

    def test_real_process_malformed_duplicate_trailing_nonfinite_or_invalid_utf8_refuses(self):
        for mode in ['truncated', 'duplicate', 'trailing', 'nonfinite', 'invalid-utf8']:
            package = self.make_package(mode)
            pairing, receipt = self.pair(package)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.run_request(package=package, pairing=pairing, receipt=receipt, journal=self.root / mode)

    def test_expiry_and_reorg_after_external_signature_refuse_without_retry(self):
        for after in [1360, 1352, True]:
            folder = self.root / ('height-' + str(after))
            heights = iter([1353, after])
            with self.subTest(after=after), self.assertRaises(ValueError):
                self.run_request(height_provider=lambda: next(heights), journal=folder)
            with patch('external_signer.external_transport.exchange', side_effect=AssertionError('must not retry uncertain signing')):
                with self.assertRaises(policy.SignerUnavailableError):
                    self.run_request(journal=folder)

    def test_initial_expired_future_or_invalid_height_never_dispatches(self):
        for index, value in enumerate([1360, 1351, True, -1]):
            with self.subTest(height=value), self.assertRaises(ValueError):
                self.run_request(height_provider=lambda: value, journal=self.root / ('initial-' + str(index)))
        self.assertFalse(self.marker.exists())

    def test_crash_window_after_signature_before_durable_completion_keeps_inflight_refusal(self):
        original = broker._save_state
        def fail_completion(directory, name, value):
            if value['status'] == 'COMPLETE':
                raise OSError('synthetic completion persistence failure')
            return original(directory, name, value)
        with patch('external_signer._save_state', side_effect=fail_completion):
            with self.assertRaises(OSError):
                self.run_request()
        with patch('external_signer.external_transport.exchange', side_effect=AssertionError('must not sign again')):
            with self.assertRaises(policy.SignerUnavailableError):
                self.run_request()
            with self.assertRaises(policy.SignerUnavailableError):
                self.recover()
        self.assertEqual(len(self.marker.read_text().splitlines()), 1)

    def test_failure_to_persist_dispatch_intent_prevents_any_external_signing(self):
        with patch('external_signer._save_state', side_effect=OSError('synthetic intent fsync failure')):
            with self.assertRaises(OSError):
                self.run_request()
        self.assertFalse(self.marker.exists())

    def test_private_journal_and_lock_prevent_symlinks_shared_paths_and_concurrent_calls(self):
        target = self.root / 'target'
        target.mkdir(mode=0o700)
        symlink = self.root / 'linked'
        symlink.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            self.run_request(journal=symlink)
        shared = self.root / 'shared'
        shared.mkdir(mode=0o755)
        shared.chmod(0o755)
        with self.assertRaises(ValueError):
            self.run_request(journal=shared)
        with broker._journal(self.journal):
            with self.assertRaises(policy.SignerUnavailableError):
                self.run_request()
        self.assertFalse(self.marker.exists())

    def test_corrupted_or_symlinked_completed_state_never_requests_fallback_signature(self):
        self.run_request()
        state = self.journal / broker._name(self.receipt, self.request['requestId'])
        original = state.read_bytes()
        for mode in ['corrupt', 'symlink', 'wrong-review', 'late-acceptance']:
            state.unlink()
            if mode == 'symlink':
                outside = self.root / 'outside.json'
                outside.write_bytes(original)
                state.symlink_to(outside)
            elif mode == 'corrupt':
                state.write_bytes(b'{')
                state.chmod(0o600)
            else:
                data = json.loads(original)
                data['reviewDigest' if mode == 'wrong-review' else 'acceptedAtHeight'] = '00' * 32 if mode == 'wrong-review' else 1360
                state.write_bytes(broker.encode(data))
                state.chmod(0o600)
            with self.subTest(mode=mode), patch('external_signer.external_transport.exchange', side_effect=AssertionError('must not sign')):
                with self.assertRaises((ValueError, OSError)):
                    self.run_request()

    def test_pairing_snapshot_cannot_be_mutated_by_height_callback(self):
        pairing = copy.deepcopy(self.pairing)
        def height():
            pairing['signerKind'] = 'self-certified-hardware'
            return 1353
        result = self.run_request(pairing=pairing, height_provider=height)
        self.assertFalse(result['hardwareQualified'])

    def test_strict_schema_version_cannot_be_normalized_for_dispatch_or_cache_recovery(self):
        for index, version in enumerate([True, 1.0]):
            request = dict(self.request, schemaVersion=version)
            with self.subTest(version=repr(version), action='dispatch'), self.assertRaises(ValueError):
                self.run_request(request=request, journal=self.root / ('schema-' + str(index)))
        self.run_request()
        for version in [True, 1.0]:
            request = dict(self.request, schemaVersion=version)
            with self.subTest(version=repr(version), action='cached'), self.assertRaises(ValueError):
                self.run_request(request=request)
            with self.subTest(version=repr(version), action='recover'), self.assertRaises(ValueError):
                broker.recover_completed_refunds(request, pairing=self.pairing,
                    trusted_pairing_digest=self.receipt,
                    trusted_terms_digest=self.request['termsDigest'],
                    trusted_request_digest=self.request['requestDigest'], journal_directory=self.journal)

    def test_non_json_entries_are_refused_before_their_iterator_is_consumed(self):
        class ForbiddenIterator:
            def __iter__(self):
                raise AssertionError('untrusted entries iterated before type check')
        request = dict(self.request, entries=ForbiddenIterator())
        with self.assertRaises(ValueError):
            broker.request_refund_signatures(request, pairing=self.pairing,
                trusted_pairing_digest=self.receipt,
                trusted_terms_digest=self.request['termsDigest'],
                trusted_request_digest=self.request['requestDigest'], package=self.package,
                height_provider=lambda: 1353, journal_directory=self.journal)
        self.assertFalse(self.marker.exists())

    def test_parent_directory_fsync_failure_prevents_dispatch_and_retry_remains_safe(self):
        with patch('external_signer.os.fsync', side_effect=OSError('synthetic parent fsync failure')):
            with self.assertRaises(OSError):
                self.run_request()
        self.assertFalse(self.marker.exists())
        result = self.run_request()
        self.assertFalse(result['cached'])
        self.assertEqual(len(self.marker.read_text().splitlines()), 1)

    def test_interrupted_journal_write_or_fsync_removes_partial_temporary_files(self):
        with broker._journal(self.journal) as directory:
            for target in ['_write_all', 'os.fsync']:
                with self.subTest(target=target), patch('external_signer.' + target, side_effect=OSError('synthetic I/O failure')):
                    with self.assertRaises(OSError):
                        broker._save_state(directory, 'not-published.json', {'public': 'fixture'})
                self.assertFalse((self.journal / 'not-published.json').exists())
                self.assertEqual(list(self.journal.glob('pending-*')), [])

    def test_real_sigkill_after_intent_response_and_completion_has_safe_restart(self):
        for point in ['after-intent', 'before-completion', 'after-completion']:
            with self.subTest(point=point):
                self.marker.unlink(missing_ok=True)
                folder = self.root / point
                ready_read, ready_write = os.pipe()
                hold_read, hold_write = os.pipe()
                pid = os.fork()
                if pid == 0:
                    os.close(ready_read)
                    os.close(hold_write)
                    original = broker._save_state
                    def boundary(directory, name, state):
                        if point == 'before-completion' and state['status'] == 'COMPLETE':
                            os.write(ready_write, b'checkpoint')
                            os.read(hold_read, 1)
                        original(directory, name, state)
                        if ((point == 'after-intent' and state['status'] == 'IN_FLIGHT')
                                or (point == 'after-completion' and state['status'] == 'COMPLETE')):
                            os.write(ready_write, b'checkpoint')
                            os.read(hold_read, 1)
                    broker._save_state = boundary
                    try:
                        self.run_request(journal=folder)
                    except BaseException:
                        os._exit(77)
                    os._exit(78)
                os.close(ready_write)
                os.close(hold_read)
                waited = False
                try:
                    readable, _, _ = select.select([ready_read], [], [], 10)
                    self.assertTrue(readable, 'broker did not acknowledge persistence boundary')
                    self.assertEqual(os.read(ready_read, 10), b'checkpoint')
                    os.kill(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
                    waited = True
                    self.assertTrue(os.WIFSIGNALED(status))
                    self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
                finally:
                    if not waited:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        os.waitpid(pid, 0)
                    os.close(ready_read)
                    os.close(hold_write)
                calls = len(self.marker.read_text().splitlines()) if self.marker.exists() else 0
                self.assertEqual(calls, 0 if point == 'after-intent' else 1)
                with patch('external_signer.external_transport.exchange', side_effect=AssertionError('restart must not sign')):
                    if point != 'after-completion':
                        with self.assertRaises(policy.SignerUnavailableError):
                            self.run_request(journal=folder)
                        with self.assertRaises(policy.SignerUnavailableError):
                            self.recover(journal_directory=folder)
                    else:
                        saved = folder / broker._name(self.receipt, self.request['requestId'])
                        before = saved.read_bytes()
                        self.key.unlink()
                        recovered = self.recover(journal_directory=folder)
                        self.assertEqual(len(recovered['refunds']), 3)
                        self.assertEqual(saved.read_bytes(), before)
                        self.assertTrue(recovered['cached'])


if __name__ == '__main__':
    unittest.main()
