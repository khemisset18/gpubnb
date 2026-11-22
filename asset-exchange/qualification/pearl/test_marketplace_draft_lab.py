"""Offline-only adversarial tests for synthetic PRL/DOGE listing draft model."""
from __future__ import annotations

import copy
import json
import pathlib
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from marketplace_draft_lab import DraftRefused, SyntheticDraftLedger

FIXTURE = pathlib.Path(__file__).with_name("fixtures") / "public_prl_offer_v1.json"
RAW = FIXTURE.read_bytes()
OWNER = "lab_alice"
OTHER = "lab_bob"
KEY = "cmd_create_000001"


def create(store, *, actor=OWNER, command=KEY, raw=RAW, now=100,
           expiry=200):
    return store.create(actor_label=actor, command_id=command,
                        raw_request=raw, now_tick=now, expires_tick=expiry)


def cancel(store, draft_id, *, actor=OWNER, command="cmd_cancel_000001",
           revision=1, now=110):
    return store.cancel(actor_label=actor, draft_id=draft_id,
                        command_id=command, expected_revision=revision,
                        now_tick=now)


def changed_fixture(**fields):
    data = json.loads(RAW)
    data['offer'].update(fields)
    return json.dumps(data).encode('ascii')


class MarketplaceDraftLabTests(unittest.TestCase):
    def setUp(self):
        self.store = SyntheticDraftLedger()

    def refused(self, callback, pattern=None):
        with self.assertRaises(DraftRefused) as ctx:
            callback()
        if pattern:
            self.assertIn(pattern, str(ctx.exception))

    def test_01_synthetic_draft_created_without_posting(self):
        row = create(self.store)
        self.assertEqual(row['classification'],
                         'PRL_SYNTHETIC_MARKETPLACE_DRAFT_NO_PUBLICATION')
        self.assertEqual(row['status'], 'DRAFT_PREVIEW_ONLY')
        self.assertEqual(row['offeredGrains'], '100000000')
        self.assertEqual(row['requestedAtoms'], '250000000')

    def test_02_owner_listing_can_be_viewed(self):
        draft = create(self.store)
        self.assertEqual(self.store.view(actor_label=OWNER,
                         draft_id=draft['draftId'], now_tick=110), draft)

    def test_03_marketplace_never_grants_financial_permissions(self):
        draft = create(self.store)
        for key in ('actorAuthenticated', 'networkIdentityVerified',
                    'realExchangeListingCreated', 'qualified', 'canPostOffer',
                    'canTakeOffer', 'canFund', 'canSign', 'canBroadcast',
                    'canSettle', 'automaticSettlementSupported'):
            self.assertIs(draft[key], False, key)

    def test_04_other_actor_cannot_read(self):
        draft = create(self.store)
        self.refused(lambda: self.store.view(actor_label=OTHER,
                     draft_id=draft['draftId'], now_tick=110), 'draft unavailable')

    def test_05_other_actor_cannot_cancel(self):
        draft = create(self.store)
        self.refused(lambda: cancel(self.store, draft['draftId'], actor=OTHER),
                     'draft unavailable')
        self.assertEqual(self.store.view(actor_label=OWNER, draft_id=draft['draftId'],
                                         now_tick=110)['revision'], 1)

    def test_06_unknown_draft_same_error_as_foreign(self):
        draft = create(self.store)
        for identifier in ('prl-lab-99999999', draft['draftId']):
            self.refused(lambda: self.store.view(actor_label=OTHER,
                         draft_id=identifier, now_tick=110), 'draft unavailable')

    def test_07_replay_same_create_is_idempotent(self):
        first = create(self.store)
        second = create(self.store)
        self.assertEqual(first, second)
        self.assertEqual(len(self.store.list_own(actor_label=OWNER, now_tick=110)), 1)

    def test_08_idempotency_reused_with_different_amount_refused(self):
        create(self.store)
        self.refused(lambda: create(self.store, raw=changed_fixture(offeredGrains='200000000')),
                     'idempotency')
        self.assertEqual(len(self.store.list_own(actor_label=OWNER, now_tick=110)), 1)

    def test_09_idempotency_reused_with_different_expiry_refused(self):
        create(self.store)
        self.refused(lambda: create(self.store, expiry=201), 'idempotency')

    def test_10_json_key_reordering_yields_same_canonical_intent(self):
        original = create(self.store)
        d = json.loads(RAW)
        reordered = json.dumps(dict(reversed(list(d.items())))).encode('ascii')
        second = create(self.store, raw=reordered)
        self.assertEqual(original, second)

    def test_11_two_owners_can_use_identical_command_text(self):
        a = create(self.store)
        b = create(self.store, actor=OTHER)
        self.assertNotEqual(a['draftId'], b['draftId'])
        self.assertEqual(len(self.store.list_own(actor_label=OTHER, now_tick=110)), 1)

    def test_12_cancellation_is_versioned_and_remains_unposted(self):
        draft = create(self.store)
        output = cancel(self.store, draft['draftId'])
        self.assertEqual(output['status'], 'CANCELLED_PREVIEW_ONLY')
        self.assertEqual(output['revision'], 2)
        self.assertFalse(output['canPostOffer'])

    def test_13_cancellation_replay_is_idempotent(self):
        draft = create(self.store)
        a = cancel(self.store, draft['draftId'])
        b = cancel(self.store, draft['draftId'])
        self.assertEqual(a, b)

    def test_14_second_cancel_with_new_command_refused(self):
        draft = create(self.store)
        cancel(self.store, draft['draftId'])
        self.refused(lambda: cancel(self.store, draft['draftId'], command='cmd_cancel_000002',
                                    revision=2), 'cannot be cancelled')

    def test_15_stale_revision_cannot_cancel(self):
        draft = create(self.store)
        self.refused(lambda: cancel(self.store, draft['draftId'], revision=2),
                     'stale expected revision')
        self.assertEqual(self.store.view(actor_label=OWNER, draft_id=draft['draftId'],
                                         now_tick=110)['revision'], 1)

    def test_16_cross_operation_idempotency_key_reuse_denied(self):
        draft = create(self.store)
        self.refused(lambda: cancel(self.store, draft['draftId'], command=KEY),
                     'idempotency')

    def test_17_cancellation_key_cannot_target_other_draft(self):
        a = create(self.store)
        b = create(self.store, command='cmd_create_000002')
        cancel(self.store, a['draftId'])
        self.refused(lambda: cancel(self.store, b['draftId']), 'idempotency')

    def test_18_expiry_is_hypothetical_and_fail_closed(self):
        draft = create(self.store)
        before = self.store.view(actor_label=OWNER, draft_id=draft['draftId'], now_tick=199)
        after = self.store.view(actor_label=OWNER, draft_id=draft['draftId'], now_tick=200)
        self.assertEqual(before['status'], 'DRAFT_PREVIEW_ONLY')
        self.assertEqual(after['status'], 'EXPIRED_PREVIEW_ONLY')
        self.assertIs(after['canTakeOffer'], False)

    def test_19_expired_draft_cannot_be_cancelled_as_if_active(self):
        draft = create(self.store)
        self.refused(lambda: cancel(self.store, draft['draftId'], now=200),
                     'cannot be cancelled')

    def test_20_create_after_expiry_not_accepted(self):
        self.refused(lambda: create(self.store, now=200, expiry=200), 'expiry')

    def test_21_expiry_window_is_bounded(self):
        self.assertEqual(create(self.store, expiry=1540)['expiresTick'], 1540)
        self.refused(lambda: create(self.store, command='cmd_other_000001',
                                    expiry=1541), 'expiry')

    def test_22_invalid_tick_types_and_values_refused(self):
        for field in ('now', 'expiry'):
            for value in (-1, 10**12, True, None, '100', 100.0):
                with self.subTest(field=field, value=value):
                    self.refused(lambda: create(self.store, **{field: value}))

    def test_23_reverse_time_is_rejected(self):
        draft = create(self.store)
        self.refused(lambda: self.store.view(actor_label=OWNER,
                     draft_id=draft['draftId'], now_tick=99), 'clock')
        self.refused(lambda: cancel(self.store, draft['draftId'], now=99), 'clock')
        self.refused(lambda: create(self.store, now=99), 'clock')

    def test_24_invalid_revision_types_refused(self):
        draft = create(self.store)
        for value in (0, -1, True, None, '1', 1.0):
            with self.subTest(value=value):
                self.refused(lambda: cancel(self.store, draft['draftId'], revision=value))

    def test_25_owner_label_strict_ascii(self):
        for owner in ('alice', 'lab_Alice', 'lab_éve', 'lab_a', 'lab_'+'a'*40,
                      None, True, b'lab_alice', 'lab_alice\n', 'lab_a/b'):
            with self.subTest(owner=owner):
                self.refused(lambda: create(self.store, actor=owner))

    def test_26_command_label_strict_ascii(self):
        for command in ('cmd_a', 'CMD_CREATE_00001', 'cmd_é'*4, None, False,
                        'cmd_'+'a'*40, 'cmd_a/bad', 'cmd_create_00001\n'):
            with self.subTest(command=command):
                self.refused(lambda: create(self.store, command=command))

    def test_27_record_id_malformed_refused(self):
        create(self.store)
        for identifier in (None, True, 'prl-lab-1', 'prl-lab-00000001 ',
                           'prl-lab-00000001/../../x'):
            with self.subTest(identifier=identifier):
                self.refused(lambda: self.store.view(actor_label=OWNER,
                             draft_id=identifier, now_tick=110))

    def test_28_wrong_chain_or_fake_signature_denied(self):
        for field, val in [('assetSymbol', 'MTN'), ('network', 'mainnet'),
                           ('protocolVersion', 'LIVE'), ('kind', 'ACTIVE_ORDER')]:
            d = json.loads(RAW)
            d[field] = val
            self.refused(lambda d=d: create(self.store, raw=json.dumps(d).encode()))
        d = json.loads(RAW)
        d['walletSeed'] = 'NEVER_MATERIAL'
        self.refused(lambda: create(self.store, raw=json.dumps(d).encode()))

    def test_29_duplicate_json_root_field_denied(self):
        raw = RAW.replace(b'"assetSymbol": "PRL"',
                          b'"assetSymbol": "PRL", "assetSymbol": "PRL"')
        self.refused(lambda: create(self.store, raw=raw))

    def test_30_duplicate_json_nested_field_denied(self):
        raw = RAW.replace(b'"canSign": false',
                          b'"canSign": false, "canSign": false')
        self.refused(lambda: create(self.store, raw=raw))

    def test_31_unknown_financial_privileges_denied(self):
        d = json.loads(RAW)
        d['permissions']['canPostOffer'] = True
        self.refused(lambda: create(self.store, raw=json.dumps(d).encode()))

    def test_32_noncanonical_amounts_denied(self):
        for value in ('0', '-1', '01', '1.5', '9'*40, 1.0, None, True):
            with self.subTest(value=value):
                self.refused(lambda: create(self.store, raw=changed_fixture(offeredGrains=value)))

    def test_33_invalid_raw_json_refused(self):
        for raw in (None, '{}', '', b'\xff\xff', b'{', b'[]', b'x'*8193):
            with self.subTest(type=type(raw).__name__):
                self.refused(lambda: create(self.store, raw=raw))

    def test_34_owner_quota_bounded(self):
        for i in range(4):
            create(self.store, command=f'cmd_create_{i:06d}')
        self.refused(lambda: create(self.store, command='cmd_create_999999'), 'quota')
        self.assertEqual(len(self.store.list_own(actor_label=OWNER, now_tick=110)), 4)

    def test_35_owner_quota_not_bypassed_by_cancellation(self):
        for i in range(4):
            r = create(self.store, command=f'cmd_create_{i:06d}')
            if i == 0:
                cancel(self.store, r['draftId'])
        self.refused(lambda: create(self.store, command='cmd_create_999999'), 'quota')

    def test_36_global_quota_bounded(self):
        for owner_n in range(32):
            actor = f'lab_user{owner_n:03d}'
            for j in range(4):
                create(self.store, actor=actor, command=f'cmd_create_{j:06d}')
        self.refused(lambda: create(self.store, actor='lab_newperson'), 'quota')

    def test_37_own_list_never_discloses_others(self):
        create(self.store)
        create(self.store, actor=OTHER)
        own = self.store.list_own(actor_label=OWNER, now_tick=110)
        self.assertEqual(len(own), 1)
        self.assertEqual(own[0]['ownerLabel'], OWNER)

    def test_38_render_is_copy_not_storage_reference(self):
        d = create(self.store)
        d['canSign'] = True
        d['requestedAtoms'] = '1'
        inspected = self.store.view(actor_label=OWNER, draft_id=d['draftId'], now_tick=110)
        self.assertIs(inspected['canSign'], False)
        self.assertEqual(inspected['requestedAtoms'], '250000000')

    def test_39_list_return_is_also_detached(self):
        create(self.store)
        got = self.store.list_own(actor_label=OWNER, now_tick=110)
        got[0]['canFund'] = True
        self.assertIs(self.store.list_own(actor_label=OWNER, now_tick=110)[0]['canFund'], False)

    def test_40_concurrent_same_create_idempotent(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            rows = list(pool.map(lambda _i: create(self.store), range(32)))
        self.assertEqual(len({r['draftId'] for r in rows}), 1)
        self.assertEqual(len(self.store.list_own(actor_label=OWNER, now_tick=110)), 1)

    def test_41_concurrent_same_cancel_idempotent(self):
        d = create(self.store)
        with ThreadPoolExecutor(max_workers=8) as pool:
            rows = list(pool.map(lambda _i: cancel(self.store, d['draftId']), range(32)))
        self.assertEqual({r['revision'] for r in rows}, {2})

    def test_42_parallel_distinct_owners_isolated(self):
        actors = [f'lab_peer{i:03d}' for i in range(30)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            rows = list(pool.map(lambda owner: create(self.store, actor=owner), actors))
        self.assertEqual(len({r['draftId'] for r in rows}), 30)
        for actor in actors:
            self.assertEqual(len(self.store.list_own(actor_label=actor, now_tick=110)), 1)

    def test_43_no_disk_access_during_operations(self):
        with patch('builtins.open', side_effect=AssertionError('I/O forbidden')):
            d = create(self.store)
            self.store.view(actor_label=OWNER, draft_id=d['draftId'], now_tick=110)
            self.store.list_own(actor_label=OWNER, now_tick=110)
            cancel(self.store, d['draftId'])

    def test_44_replay_after_cancel_preserves_cancel_state(self):
        d = create(self.store)
        cancel(self.store, d['draftId'])
        row = create(self.store, now=115)
        self.assertEqual(row['status'], 'CANCELLED_PREVIEW_ONLY')
        self.assertEqual(row['revision'], 2)

    def test_45_no_public_search_or_publish_api_exposed(self):
        for name in ('publish', 'post', 'take', 'accept', 'settle', 'withdraw',
                     'broadcast', 'sign', 'fund', 'connect', 'send'):
            self.assertFalse(hasattr(self.store, name))

    def test_46_id_is_not_a_secret_and_not_sufficient_for_access(self):
        d = create(self.store)
        self.assertEqual(d['draftId'], 'prl-lab-00000001')
        self.refused(lambda: self.store.view(actor_label=OTHER,
                     draft_id=d['draftId'], now_tick=110), 'draft unavailable')
        self.assertFalse(d['actorAuthenticated'])

    def test_47_no_programmatic_source_mutation(self):
        before = RAW
        d = create(self.store)
        self.assertEqual(RAW, before)
        self.assertEqual(d['intentSha256'], create(self.store)['intentSha256'])


if __name__ == '__main__':
    unittest.main()
