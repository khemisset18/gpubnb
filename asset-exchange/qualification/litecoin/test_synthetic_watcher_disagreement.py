"""LTC L7 observer disagreement tests use fake public data exclusively.

No actual sources, transactions, nodes, wallets, keys, signatures or network.
"""
import copy
import unittest
from unittest.mock import patch

import synthetic_watcher_disagreement as w

TXID = "11" * 32
BLOCK = "22" * 32


def sample(label="source_a", **change):
    item = {
        "schemaVersion": 1, "kind": "SYNTHETIC_PUBLIC_OBSERVATION",
        "chainId": "litecoin", "network": "regtest", "genesis": w.GENESIS,
        "sourceLabel": label, "txid": TXID, "status": "CONFIRMED",
        "headHeight": 500, "confirmations": 2, "blockHash": BLOCK,
        "ageSeconds": 0, "mweb": False,
    }
    item.update(change)
    return item


def pair(change_a=None, change_b=None):
    return [sample("source_a", **(change_a or {})),
            sample("source_b", **(change_b or {}))]


def evaluate(change_a=None, change_b=None):
    return w.evaluate_synthetic_observers(pair(change_a, change_b))


class SyntheticWatcherDisagreementTests(unittest.TestCase):
    def denied(self, items):
        with self.assertRaises(w.SnapshotRefused):
            w.evaluate_synthetic_observers(items)

    def test_matching_confirmed_still_untrusted(self):
        self.assertEqual(evaluate()["classification"],
                         "SIMULATED_MATCHING_CONFIRMED_UNAUTHENTICATED")

    def test_matching_mempool_still_untrusted(self):
        state = dict(status="MEMPOOL", confirmations=0, blockHash=None)
        self.assertEqual(evaluate(state, state)["classification"],
                         "SIMULATED_MATCHING_MEMPOOL_UNAUTHENTICATED")

    def test_one_stale_source_uncertain(self):
        self.assertEqual(evaluate(change_b={"ageSeconds": 31})["classification"],
                         "SIMULATED_UNCERTAIN_STALE")

    def test_both_stale_sources_uncertain(self):
        self.assertEqual(evaluate({"ageSeconds": 31}, {"ageSeconds": 60})["classification"],
                         "SIMULATED_UNCERTAIN_STALE")

    def test_age_boundary_30_accepted_as_synthetic_only(self):
        self.assertEqual(evaluate({"ageSeconds": 30}, {"ageSeconds": 30})["classification"],
                         "SIMULATED_MATCHING_CONFIRMED_UNAUTHENTICATED")

    def test_one_conflicted_source_uncertain(self):
        self.assertEqual(evaluate(change_b={"status": "CONFLICTED", "confirmations": 0,
                                            "blockHash": None})["classification"],
                         "SIMULATED_UNCERTAIN_CONFLICT")

    def test_one_reorged_source_uncertain(self):
        self.assertEqual(evaluate(change_b={"status": "REORGED", "confirmations": 0,
                                            "blockHash": None})["classification"],
                         "SIMULATED_UNCERTAIN_REORG")

    def test_one_unknown_source_uncertain(self):
        self.assertEqual(evaluate(change_b={"status": "UNKNOWN", "confirmations": 0,
                                            "blockHash": None})["classification"],
                         "SIMULATED_UNCERTAIN_UNKNOWN")

    def test_mempool_vs_confirmed_is_uncertain(self):
        self.assertEqual(evaluate(change_b={"status": "MEMPOOL", "confirmations": 0,
                                            "blockHash": None})["classification"],
                         "SIMULATED_UNCERTAIN_STATUS_DISAGREEMENT")

    def test_different_heads_are_uncertain(self):
        self.assertEqual(evaluate(change_b={"headHeight": 501})["classification"],
                         "SIMULATED_UNCERTAIN_HEAD_HEIGHT_DISAGREEMENT")

    def test_different_confirmation_counts_are_uncertain(self):
        self.assertEqual(evaluate(change_b={"confirmations": 1})["classification"],
                         "SIMULATED_UNCERTAIN_CONFIRMATION_DISAGREEMENT")

    def test_different_block_hashes_are_uncertain(self):
        self.assertEqual(evaluate(change_b={"blockHash": "33" * 32})["classification"],
                         "SIMULATED_UNCERTAIN_BLOCK_HASH_DISAGREEMENT")

    def test_missing_second_source_refused(self):
        self.denied([sample()])

    def test_extra_source_refused(self):
        self.denied([sample(), sample("source_b"), sample("source_c")])

    def test_duplicate_source_labels_refused(self):
        self.denied([sample(), sample()])

    def test_invalid_container_refused(self):
        for obj in [None, {}, (), "", 5, True]:
            with self.subTest(value=repr(obj)):
                self.denied(obj)

    def test_wrong_network_denied(self):
        self.denied(pair(change_b={"network": "mainnet"}))

    def test_wrong_genesis_denied(self):
        self.denied(pair(change_a={"genesis": "00" * 32}))

    def test_wrong_coin_denied(self):
        self.denied(pair(change_a={"chainId": "dogecoin"}))

    def test_wrong_or_spoofed_mweb_denied(self):
        for mweb in [True, 0, 1, "false", None]:
            with self.subTest(mweb=repr(mweb)):
                self.denied(pair(change_b={"mweb": mweb}))

    def test_mismatched_or_invalid_txid_denied(self):
        self.denied(pair(change_b={"txid": "33" * 32}))
        for txid in ["00" * 32, "a" * 63, "FF" * 32, None, b"11"]:
            with self.subTest(txid=repr(txid)):
                self.denied(pair(change_b={"txid": txid}))

    def test_unknown_status_denied(self):
        self.denied(pair(change_b={"status": "FINAL"}))

    def test_conflicting_block_status_denied(self):
        self.denied(pair(change_b={"status": "MEMPOOL"}))
        self.denied(pair(change_b={"status": "REORGED", "blockHash": None}))

    def test_confirmed_without_block_denied(self):
        self.denied(pair(change_b={"blockHash": None}))

    def test_confirmed_with_zero_confirmations_denied(self):
        self.denied(pair(change_b={"confirmations": 0}))

    def test_confirmations_beyond_head_denied(self):
        self.denied(pair(change_b={"confirmations": 502}))

    def test_invalid_age_denied(self):
        for value in [True, -1, 86401, "0", None, 0.0]:
            with self.subTest(value=repr(value)):
                self.denied(pair(change_b={"ageSeconds": value}))

    def test_invalid_heights_denied(self):
        for value in [-1, True, None, 500000000, "500"]:
            with self.subTest(value=repr(value)):
                self.denied(pair(change_a={"headHeight": value}))

    def test_missing_or_extra_fields_denied(self):
        a = pair()
        del a[1]["status"]
        self.denied(a)
        b = pair()
        b[1]["canRefund"] = True
        self.denied(b)

    def test_source_labels_are_not_independence_proof(self):
        self.assertTrue(evaluate()["sourceLabelsAreNotIndependenceProof"])
        self.assertIs(evaluate()["realSourceIndependenceVerified"], False)

    def test_simulated_agreement_never_promotes_any_financial_state(self):
        for fields in [({}, {}), ({"status": "MEMPOOL", "confirmations": 0,
                                    "blockHash": None},
                                   {"status": "MEMPOOL", "confirmations": 0,
                                    "blockHash": None}),
                       ({}, {"headHeight": 501})]:
            result = evaluate(*fields)
            for key in ["realChainEvidenceVerified", "realSourceIndependenceVerified",
                        "nativeReorgVerified", "qualified", "canAdvance",
                        "canRefund", "canSign", "canBroadcast",
                        "automaticSettlementSupported"]:
                self.assertIs(result[key], False, (key, result["classification"]))

    def test_pure_no_io_or_input_mutation(self):
        snapshots = pair()
        original = copy.deepcopy(snapshots)
        with patch("builtins.open", side_effect=AssertionError("I/O forbidden")):
            self.assertIn("SIMULATED", w.evaluate_synthetic_observers(snapshots)["classification"])
        self.assertEqual(snapshots, original)


if __name__ == "__main__":
    unittest.main()
