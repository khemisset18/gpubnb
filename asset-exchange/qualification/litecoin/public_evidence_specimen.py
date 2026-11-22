"""Non-recoverable, public-only Litecoin offline evidence specimen.

NEVER treat this file as a recoverable refund package, an ownership proof,
a chain attestation, or an executable transaction. Only internal consistency
of a strictly fictional request and a candidate HTLC's public bytes is tested.
SHA256 below is an UNKEYED checksum: anyone can recalculate it.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from offline_preflight import Refused, parse_request, validate_request
from candidate_htlc import ScriptRefused, inspect_synthetic_htlc_script

DOMAIN = 'GPUbnb:LTC:PUBLIC_EVIDENCE_SPECIMEN:v1'
GENESIS = '530827f38f93b43ed12af0b3ad25a288dc02ed74d6d7857862df51fc56c416f9'
FLAGS = frozenset({'canSign', 'canBroadcast', 'canRefund', 'canFund',
                   'nativeConsensusVerified', 'chainEvidenceVerified',
                   'independentRecoveryVerified', 'automaticSettlementSupported',
                   'qualified', 'realFundsUsed', 'hardwareQualified'})
ROOT = frozenset({'schemaVersion', 'kind', 'domain', 'chainId', 'network',
                  'asset', 'protocolVersion', 'genesis', 'request',
                  'requestSha256', 'candidateScriptHex', 'candidateScriptSha256',
                  'candidateP2WSHScriptPubKeyHex', 'permissions', 'bundleSha256'})
MAX_BYTES = 16384


class SpecimenRefused(ValueError):
    """Failed closed without producing any usable recovery artifact."""


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, allow_nan=False,
                      separators=(',', ':')).encode('ascii')


def _reject_dupes(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise SpecimenRefused('duplicate JSON field')
        result[key] = value
    return result


def _reject_nan(_value: str) -> None:
    raise SpecimenRefused('nonfinite numeric literal')


def build_public_specimen(request_bytes: bytes, script: bytes) -> dict:
    """Wrap public bytes into an intentionally NON-RECOVERABLE exhibit."""
    try:
        request = parse_request(request_bytes)
        preflight = validate_request(request)
        inspected = inspect_synthetic_htlc_script(script)
    except (Refused, ScriptRefused) as exc:
        raise SpecimenRefused('invalid public request or script') from exc
    if inspected['refundHeight'] != request['review']['refundLockHeight']:
        raise SpecimenRefused('script height disagrees with public request')
    base = {
        'schemaVersion': 1,
        'kind': 'SYNTHETIC_PUBLIC_EVIDENCE_NOT_RECOVERY',
        'domain': DOMAIN,
        'chainId': 'litecoin',
        'network': 'regtest',
        'asset': 'LTC',
        'protocolVersion': 'LTC_BASECHAIN_TRANSPARENT_V1',
        'genesis': GENESIS,
        'request': request,
        'requestSha256': preflight['requestSha256'],
        'candidateScriptHex': inspected['scriptHex'],
        'candidateScriptSha256': _sha(script),
        'candidateP2WSHScriptPubKeyHex': inspected['p2wshScriptPubKeyHex'],
        'permissions': {name: False for name in sorted(FLAGS)},
    }
    base['bundleSha256'] = _sha(_canonical(base))
    return base


def verify_public_specimen(raw: bytes) -> dict:
    """No IO. Checks internal consistency only, NOT source authenticity."""
    if type(raw) is not bytes or not 0 < len(raw) <= MAX_BYTES:
        raise SpecimenRefused('specimen size/type refused')
    try:
        obj = json.loads(raw.decode('utf-8', errors='strict'),
                         object_pairs_hook=_reject_dupes,
                         parse_constant=_reject_nan)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise SpecimenRefused('invalid JSON') from exc
    if type(obj) is not dict or set(obj) != ROOT:
        raise SpecimenRefused('specimen root schema refused')
    for field, expected in (
        ('schemaVersion', 1),
        ('kind', 'SYNTHETIC_PUBLIC_EVIDENCE_NOT_RECOVERY'),
        ('domain', DOMAIN), ('chainId', 'litecoin'), ('network', 'regtest'),
        ('asset', 'LTC'), ('protocolVersion', 'LTC_BASECHAIN_TRANSPARENT_V1'),
        ('genesis', GENESIS),
    ):
        if type(obj[field]) is not type(expected) or obj[field] != expected:
            raise SpecimenRefused(f'{field}: unsupported value')
    if type(obj['permissions']) is not dict or set(obj['permissions']) != FLAGS:
        raise SpecimenRefused('permission schema mismatch')
    if any(obj['permissions'][field] is not False for field in FLAGS):
        raise SpecimenRefused('unsafe permissions')
    checksum = obj['bundleSha256']
    if (type(checksum) is not str or len(checksum) != 64
            or any(c not in '0123456789abcdef' for c in checksum)):
        raise SpecimenRefused('malformed checksum')
    if _sha(_canonical({key: val for key, val in obj.items()
                        if key != 'bundleSha256'})) != checksum:
        raise SpecimenRefused('specimen content checksum mismatch')
    if type(obj['request']) is not dict:
        raise SpecimenRefused('request type mismatch')
    try:
        request_bytes = _canonical(obj['request'])
    except (ValueError, TypeError) as exc:
        raise SpecimenRefused('invalid nested request') from exc
    script_hex = obj['candidateScriptHex']
    if (type(script_hex) is not str or not 0 < len(script_hex) <= 512
            or len(script_hex) % 2 or any(c not in '0123456789abcdef' for c in script_hex)):
        raise SpecimenRefused('noncanonical script hex')
    script = bytes.fromhex(script_hex)
    expected = build_public_specimen(request_bytes, script)
    if obj != expected:
        raise SpecimenRefused('bundle cross-field inconsistency')
    return {
        'classification': 'PUBLIC_EVIDENCE_SPECIMEN_CONSISTENT_NOT_RECOVERABLE',
        'bundleSha256': checksum,
        'sourceAuthenticityVerified': False,
        'nativeConsensusVerified': False,
        'independentRecoveryVerified': False,
        'qualified': False,
        'canRefund': False,
        'canSign': False,
        'canBroadcast': False,
        'automaticSettlementSupported': False,
    }
