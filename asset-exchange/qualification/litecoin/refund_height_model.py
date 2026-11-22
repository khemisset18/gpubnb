"""Conservative public-scalar Litecoin regtest refund-height *simulation*.

Models only two constraints in the v0.21.5.8 upstream source:
  - GenericTransactionSignatureChecker::CheckLockTime, and
  - IsFinalTx for a hypothetical block-height inclusion.

Not a transaction, script interpreter, chain watcher, signature, node or
spendability check. In particular, ``canRefund`` is ALWAYS false.
"""

LOCKTIME_THRESHOLD = 500_000_000
MAX_U32 = (1 << 32) - 1
# This particular synthetic template freezes a non-final sequence and version.
CANDIDATE_SEQUENCE = 0xFFFFFFFE
CANDIDATE_VERSION = 2


class ModelRefused(ValueError):
    """Invalid data presented to an offline-only conservative model."""


def _integer(value, name, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ModelRefused(f"{name}: invalid integer/range")
    return value


def simulate_refund_height(*, script_height, tx_locktime,
                            tx_sequence, hypothetical_inclusion_height,
                            tx_version=2, sighash="ALL", chain="litecoin",
                            network="regtest", mweb=False):
    """Return status of hypothetical height checks, never transaction readiness.

    The model deliberately cannot verify an actual witness, key, signature,
    txout, UTXO, mempool policy, reorg, node, MWEB state or block inclusion.
    Its inputs are public synthetic scalar *assumptions*, not chain evidence.
    """
    _integer(script_height, "script_height", 1, LOCKTIME_THRESHOLD - 1)
    _integer(tx_locktime, "tx_locktime", 0, MAX_U32)
    _integer(tx_sequence, "tx_sequence", 0, MAX_U32)
    _integer(hypothetical_inclusion_height, "hypothetical_inclusion_height", 1,
             LOCKTIME_THRESHOLD - 1)
    if type(tx_version) is not int or tx_version != CANDIDATE_VERSION:
        raise ModelRefused("unsupported synthetic transaction version")
    if type(sighash) is not str or sighash != "ALL":
        raise ModelRefused("unsupported sighash policy")
    if type(chain) is not str or chain != "litecoin":
        raise ModelRefused("wrong chain")
    if type(network) is not str or network != "regtest":
        raise ModelRefused("wrong network")
    if type(mweb) is not bool or mweb:
        raise ModelRefused("MWEB or ambiguous privacy flag")
    if tx_sequence != CANDIDATE_SEQUENCE:
        raise ModelRefused("unsupported candidate nSequence")

    # Litecoin's CheckLockTime requires type match, locktime >= CLTV arg,
    # and a non-final input sequence. We freeze the latter to 0xfffffffe.
    if tx_locktime >= LOCKTIME_THRESHOLD:
        phase = "SIMULATED_BLOCKED_LOCKTIME_TYPE_MISMATCH"
    elif tx_locktime < script_height:
        phase = "SIMULATED_BLOCKED_CLTV_HEIGHT"
    # Litecoin's IsFinalTx uses the strict '< blockheight' comparison when
    # a non-final sequence exists. The height supplied here is hypothetical.
    elif tx_locktime >= hypothetical_inclusion_height:
        phase = "SIMULATED_BLOCKED_TX_FINALITY"
    else:
        phase = "SIMULATED_SCALAR_CONDITIONS_MET_NO_CHAIN_PROOF"

    return {
        "classification": phase,
        "scriptHeight": script_height,
        "transactionLocktime": tx_locktime,
        "hypotheticalInclusionHeight": hypothetical_inclusion_height,
        "nativeConsensusVerified": False,
        "chainEvidenceVerified": False,
        "qualified": False,
        "canRefund": False,
        "canSign": False,
        "canBroadcast": False,
        "automaticSettlementSupported": False,
    }
