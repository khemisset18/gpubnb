"""Bounded non-broadcastable DOGE spend intents and source-derived arithmetic.

Only public descriptions and synthetic context facts. No transaction serializer,
signature, key, wallet, native library, RPC client or financial effect exists.
"""
import hashlib
import json
import re

from htlc_codec import bind_htlc, SEQUENCE
from offline_candidate import SOURCE, uint32, finality_model, build_candidate

GENESIS = "3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5"
MAX_MONEY = 10_000_000_000 * 100_000_000  # amount.h, not total supply.
BIP65_HEIGHT = 1351


def exact(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(label + ": unexpected or missing fields")


def hex_bytes(value, length=None):
    if type(value) is not str or len(value) > 1040 or not re.fullmatch(r"(?:[0-9a-f]{2})+", value):
        raise ValueError("canonical bounded lowercase hex required")
    raw = bytes.fromhex(value)
    if length is not None and len(raw) != length:
        raise ValueError("wrong public field length")
    return raw


def amount(value):
    if type(value) is not str or not re.fullmatch(r"0|[1-9][0-9]{0,18}", value) or int(value) > MAX_MONEY:
        raise ValueError("canonical bounded koinu integer required")
    return int(value)


def stable_hash(value):
    nodes = 0
    characters = 0

    def account_text(item, maximum):
        nonlocal characters
        if type(item) is not str or len(item) > maximum:
            raise ValueError("bounded plain intent text required")
        characters += len(item)
        if characters > 32768:
            raise ValueError("aggregate intent text bound exceeded")

    def plain(item, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > 8 or nodes > 2048:
            raise ValueError("aggregate bounded plain intent data required")
        if item is None or type(item) is bool:
            return
        if type(item) is str:
            account_text(item, 4096)
            return
        if type(item) is int and 0 <= item <= MAX_MONEY:
            return
        if type(item) is list and len(item) <= 32:
            for child in item:
                plain(child, depth + 1)
            return
        if type(item) is dict and len(item) <= 32:
            for key, child in item.items():
                account_text(key, 128)
                plain(child, depth + 1)
            return
        raise ValueError("bounded plain intent data required")

    plain(value)
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    if len(raw) > 65536:
        raise ValueError("encoded intent byte bound exceeded")
    return hashlib.sha256(b"GPUbnb:DOGE:OFFLINE_SPEND_TERMS:1\x00" + raw).hexdigest()


def destination(raw):
    raw = hex_bytes(raw)
    if not ((len(raw) == 25 and raw[:3] == b"\x76\xa9\x14" and raw[-2:] == b"\x88\xac")
            or (len(raw) == 23 and raw[:2] == b"\xa9\x14" and raw[-1:] == b"\x87")):
        raise ValueError("only exact prepared P2PKH/P2SH destinations allowed")
    return raw


def validate_terms(terms):
    exact(terms, ["schemaVersion", "network", "genesis", "sourceCommit", "redeemHex",
        "commitmentHex", "claimPublicHex", "refundPublicHex", "lockTime", "outpoint",
        "inputValueKoinu", "claimDestinationHex", "refundDestinationHex",
        "claimFeeKoinu", "refundFeeKoinu"], "terms")
    if type(terms["schemaVersion"]) is not int or terms["schemaVersion"] != 1:
        raise ValueError("unsupported terms version")
    if terms["network"] != "regtest" or terms["genesis"] != GENESIS or terms["sourceCommit"] != SOURCE:
        raise ValueError("pinned DOGE source/regtest identity required")
    expected = build_candidate(hex_bytes(terms["commitmentHex"],32),hex_bytes(terms["claimPublicHex"],33),
                               hex_bytes(terms["refundPublicHex"],33),terms["lockTime"])
    parsed = bind_htlc(hex_bytes(terms["redeemHex"]), commitment=hex_bytes(terms["commitmentHex"],32),
                       claim_public=hex_bytes(terms["claimPublicHex"],33), refund_public=hex_bytes(terms["refundPublicHex"],33),
                       lock=terms["lockTime"], output=expected.output)
    exact(terms["outpoint"], ["txid", "vout"], "outpoint")
    hex_bytes(terms["outpoint"]["txid"],32)
    uint32(terms["outpoint"]["vout"], "outpoint index")
    if terms["outpoint"]["txid"] == "0"*64 and terms["outpoint"]["vout"] == 0xFFFFFFFF:
        raise ValueError("null outpoint forbidden")
    value = amount(terms["inputValueKoinu"])
    if value <= 0:
        raise ValueError("positive input value required")
    for branch in ["claim", "refund"]:
        destination(terms[branch+"DestinationHex"])
        if not 0 < amount(terms[branch+"FeeKoinu"]) < value:
            raise ValueError("positive bounded branch fee required")
    return parsed


def prepare_spend_pair(terms):
    parsed = validate_terms(terms)
    result = {}
    for branch in ["CLAIM", "REFUND"]:
        name = branch.lower()
        script = destination(terms[name+"DestinationHex"])
        script_sig_bound = parsed.size_budget()[name+"ScriptSigMaxBytes"]
        compact_length = 1 if script_sig_bound < 253 else 3
        size_bound = 4+1+36+compact_length+script_sig_bound+4+1+8+1+len(script)+4
        result[branch] = {
            "schemaVersion":1, "kind":"UNSIGNED_NON_BROADCASTABLE_INTENT", "branch":branch,
            "termsDigest":stable_hash(terms), "network":"regtest", "genesis":GENESIS,
            "sourceCommit":SOURCE, "outpoint":dict(terms["outpoint"]),
            "inputValueKoinu":terms["inputValueKoinu"], "redeemHex":terms["redeemHex"],
            "participantPublicHex":terms[name+"PublicHex"], "version":1,
            "lockTime":0 if branch=="CLAIM" else parsed.lock, "sequence":SEQUENCE,
            "output":{"valueKoinu":str(amount(terms["inputValueKoinu"])-amount(terms[name+"FeeKoinu"])),
                      "scriptPubKeyHex":terms[name+"DestinationHex"]},
            "feeKoinu":terms[name+"FeeKoinu"], "signatureHashProfile":"LEGACY_SIGHASH_ALL_REQUIRED_NOT_TESTED",
            "serializedSizeUpperBound":size_bound, "signatureVerified":False,
            "transactionBytes":None, "qualificationStatus":"BLOCKED", "executableOperations":[]}
    return result


def check_intent(terms, intent):
    if type(intent) is not dict or intent.get("branch") not in ["CLAIM", "REFUND"]:
        raise ValueError("unsigned branch intent required")
    expected = prepare_spend_pair(terms)[intent["branch"]]
    exact(intent,list(expected),"intent")
    if stable_hash(intent) != stable_hash(expected):
        raise ValueError("intent differs from frozen terms; no silent transaction mutation")
    return expected


def require_standard_model(chain, accept_nonstandard=None):
    """init.cpp1057 arithmetic, not an observation of node configuration."""
    if chain not in ["main", "test", "regtest"] or (accept_nonstandard is not None and type(accept_nonstandard) is not bool):
        raise ValueError("explicit known chain/configuration required")
    chain_default = chain == "main"
    effective = chain_default if accept_nonstandard is None else not accept_nonstandard
    if chain_default and not effective:
        raise ValueError("main chain rejects acceptnonstdtxn override")
    return effective


def fee_rate_model(rate_koinu_per_kb, size_bytes):
    """CFeeRate::GetFee truncates, with a positive one-koinu floor; not ceil."""
    rate = amount(rate_koinu_per_kb)
    if type(size_bytes) is not int or not 0 <= size_bytes <= 100_000:
        raise ValueError("bounded serialized byte size required")
    if rate*size_bytes > 2**63-1:
        raise ValueError("fee rate multiplication would overflow CAmount")
    fee = rate*size_bytes//1000
    if fee == 0 and rate > 0 and size_bytes > 0:
        fee = 1
    return fee


def assess_prepared_intent(terms, intent, context, policy, utxo):
    """Partial requirements assessment of explicit SYNTHETIC_MODEL facts only.

    A negative predicate is useful; no set of positive predicates qualifies D2.
    Fee planning floors do not assert that sendrawtransaction enforces them.
    """
    check_intent(terms,intent)
    exact(context,["kind","network","genesis","tipHeight","nextBlockHeight","medianTimePast",
        "candidateBlockTime","csvActive","bip65Enforced"],"context")
    if context["kind"]!="SYNTHETIC_MODEL" or context["network"]!="regtest" or context["genesis"]!=GENESIS:
        raise ValueError("synthetic pinned regtest context required")
    for key in ["tipHeight","nextBlockHeight","medianTimePast","candidateBlockTime"]:
        uint32(context[key],key)
    if context["nextBlockHeight"]!=context["tipHeight"]+1:
        raise ValueError("wrong next-block context")
    if type(context["csvActive"]) is not bool or type(context["bip65Enforced"]) is not bool:
        raise ValueError("explicit deployment model required")
    if context["bip65Enforced"]!=(context["nextBlockHeight"]>=BIP65_HEIGHT):
        raise ValueError("BIP65 model inconsistent with pinned candidate block height")
    exact(policy,["acceptNonstandard","promiscuousMempoolFlags","hardDustKoinu","softDustKoinu",
        "relayRateKoinuPerKB","mempoolFeeFloorKoinu","maximumFeeKoinu"],"policy")
    standard = require_standard_model("regtest",policy["acceptNonstandard"])
    if policy["promiscuousMempoolFlags"] is not None:
        uint32(policy["promiscuousMempoolFlags"],"promiscuous flags")
    hard,soft = amount(policy["hardDustKoinu"]),amount(policy["softDustKoinu"])
    if soft<hard:
        raise ValueError("soft dust below effective hard dust")
    exact(utxo,["kind","outpoint","valueKoinu","scriptPubKeyHex","availability","coinbaseMature"],"UTXO facts")
    if utxo["kind"]!="SYNTHETIC_MODEL" or type(utxo["coinbaseMature"]) is not bool:
        raise ValueError("explicit synthetic UTXO model required")
    exact(utxo["outpoint"],["txid","vout"],"UTXO outpoint")
    uint32(utxo["outpoint"]["vout"],"UTXO output index")
    hex_bytes(utxo["outpoint"]["txid"],32)
    if utxo["outpoint"]!=terms["outpoint"] or utxo["valueKoinu"]!=terms["inputValueKoinu"] or utxo["scriptPubKeyHex"]!=validate_terms(terms).output.hex():
        raise ValueError("UTXO identity/value/script mismatch")
    if utxo["availability"] not in ["AVAILABLE","MISSING","SPENT","MEMPOOL_CONFLICT"]:
        raise ValueError("unknown UTXO availability")
    value,fee = amount(intent["output"]["valueKoinu"]),amount(intent["feeKoinu"])
    relay_planning = fee_rate_model(policy["relayRateKoinuPerKB"],intent["serializedSizeUpperBound"])
    soft_dust_surcharge = soft if value<soft else 0  # Prepared destinations are spendable.
    block_cutoff = context["medianTimePast"] if context["csvActive"] else context["candidateBlockTime"]
    mempool_final = finality_model(intent["lockTime"],[intent["sequence"]],context["nextBlockHeight"],context["medianTimePast"])
    block_final = finality_model(intent["lockTime"],[intent["sequence"]],context["nextBlockHeight"],block_cutoff)
    blockers=[]
    def need(condition,layer,reason):
        if not condition:blockers.append({"layer":layer,"reason":reason})
    need(standard,"POLICY_CONFIGURATION","STANDARDNESS_NOT_REQUIRED")
    need(policy["promiscuousMempoolFlags"] is None,"POLICY_CONFIGURATION","SCRIPT_FLAGS_OVERRIDE")
    need(value>=hard,"POLICY","HARD_DUST")
    need(mempool_final,"MEMPOOL_FINALITY","NON_FINAL")
    need(block_final,"CONSENSUS_CONTEXT_MODEL","NON_FINAL_BLOCK")
    need(context["bip65Enforced"],"PROFILE_REQUIREMENT","BIP65_NOT_ENFORCED")
    need(utxo["availability"]=="AVAILABLE","UTXO_MODEL",utxo["availability"])
    need(utxo["coinbaseMature"],"UTXO_MODEL","IMMATURE_COINBASE_OR_UNKNOWN")
    need(fee>=amount(policy["mempoolFeeFloorKoinu"]),"POLICY","DYNAMIC_MEMPOOL_FEE_FLOOR")
    need(fee>=relay_planning+soft_dust_surcharge,"PREPARATION_FEE_RESERVE","RELAY_OR_SOFT_DUST_RESERVE")
    need(fee<=amount(policy["maximumFeeKoinu"]),"USER_FEE_CAP","EXCESSIVE_FEE")
    return {"status":"MODEL_BLOCKED" if blockers else "MODEL_REQUIREMENTS_ONLY",
            "blockers":blockers,"mempoolFinalityModel":mempool_final,"blockFinalityModel":block_final,
            "relayPlanningFloorKoinu":str(min(relay_planning+soft_dust_surcharge,MAX_MONEY)),
            "rpcFreeLimiterEnforced":False,"signatureVerified":False,"utxoFactsVerified":False,
            "nativeConsensus":"NOT TESTED","nativeStandardness":"NOT TESTED","nativeMempool":"NOT TESTED",
            "qualificationStatus":"BLOCKED","executableOperations":[]}
