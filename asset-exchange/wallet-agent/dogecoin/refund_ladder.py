"""Regtest-only DOGE refund policy shared by recovery and an external signer.

No keys, network client, wallet, shell command, signing operation or automatic
broadcast lives here. Verification uses OpenSSL's existing secp256k1 primitive.
Native admission/chain state must be established separately by the caller.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
_NAMES = ('htlc_codec', 'offline_candidate', 'spend_preparation', 'test_signer', 'transaction')
# A standalone zipapp keeps these modules together. Compare origins before
# importing so unrelated PYTHONPATH modules cannot substitute a policy helper.
_specs = {name: importlib.util.find_spec(name) for name in _NAMES}
_bundled = all(spec is not None and spec.origin is not None
    and Path(spec.origin).resolve().parent == HERE for spec in _specs.values())
if _bundled:
    import transaction as _codec
    SUPPORT = HERE
else:
    SUPPORT = HERE / 'support'
    PARSER = HERE / 'transaction.py'
    if not SUPPORT.is_dir():
        exchange = HERE.parents[1]
        SUPPORT = exchange / 'qualification' / 'dogecoin' / 'd2'
        PARSER = exchange / 'recovery' / 'dogecoin' / 'transaction.py'
    sys.path.insert(0, str(SUPPORT))
    _spec = importlib.util.spec_from_file_location('gpubnb_doge_recovery_transaction', PARSER)
    _codec = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_codec)
from htlc_codec import decode_htlc, SEQUENCE
from offline_candidate import SOURCE, checked_pubkey
from spend_preparation import GENESIS, MAX_MONEY, destination
from test_signer import transaction, sighash, push, decode_der, ORDER
for _module in _NAMES[:-1]:
    if Path(sys.modules[_module].__file__).resolve().parent != SUPPORT.resolve():
        raise ImportError('DOGE policy helper came from an unexpected location')
parse_transaction, txid = _codec.parse_transaction, _codec.txid

REQUEST_DOMAIN = 'GPUBNB:DOGE:REFUND_SIGN_REQUEST:v1'
RESPONSE_DOMAIN = 'GPUBNB:DOGE:REFUND_SIGN_RESPONSE:v1'
MAX_LADDER = 8
SOFT_DUST_KOINU = 1_000_000
SPKI_PREFIX = bytes.fromhex('3036301006072a8648ce3d020106052b8104000a032200')


class FeeCoverageError(ValueError):
    """No already-signed refund covers the observed fee requirement."""


class SignerUnavailableError(ValueError):
    """External signer did not return an authorized signed response."""


def require(ok, message):
    if not ok:
        raise ValueError(message)


def exact(value, fields, label):
    require(type(value) is dict and set(value) == set(fields), label + ': unexpected or missing fields')


def hex_bytes(value, maximum, *, size=None):
    require(type(value) is str and 0 < len(value) <= 2 * maximum
            and re.fullmatch(r'(?:[0-9a-f]{2})+', value), 'canonical bounded hex required')
    raw = bytes.fromhex(value)
    require(size is None or len(raw) == size, 'wrong public byte length')
    return raw


def amount(value, *, positive=False):
    require(type(value) is str and re.fullmatch(r'0|[1-9][0-9]{0,18}', value), 'canonical koinu integer required')
    number = int(value)
    require((number > 0 if positive else number >= 0) and number <= MAX_MONEY, 'koinu amount outside profile')
    return number


def height(value):
    require(type(value) is int and 0 <= value <= 0xffffffff, 'uint32 height required')
    return value


def digest(value, label='digest'):
    require(type(value) is str and re.fullmatch('[0-9a-f]{64}', value), 'canonical ' + label + ' required')
    return value


def common_terms(contract, funding, policy):
    exact(contract, ['redeemHex', 'outputHex'], 'contract')
    redeem = hex_bytes(contract['redeemHex'], 520)
    parsed = decode_htlc(redeem)
    require(hex_bytes(contract['outputHex'], 520) == parsed.output, 'contract P2SH mismatch')
    exact(funding, ['txid', 'vout', 'valueKoinu', 'transactionHex'], 'funding')
    digest(funding['txid'], 'funding txid'); height(funding['vout'])
    raw = hex_bytes(funding['transactionHex'], 10000)
    require(txid(raw) == funding['txid'], 'funding identity changed; obtain new signed refunds')
    decoded = parse_transaction(raw)
    require(funding['vout'] < len(decoded['outputs']), 'funding output absent')
    output = decoded['outputs'][funding['vout']]
    value = amount(funding['valueKoinu'], positive=True)
    require(output['valueKoinu'] == value and output['scriptPubKey'] == parsed.output,
            'funding output amount/script mismatch')
    exact(policy, ['maxFeeKoinu', 'minRefundKoinu'], 'refund policy')
    cap = amount(policy['maxFeeKoinu'], positive=True)
    minimum = amount(policy['minRefundKoinu'], positive=True)
    require(minimum >= SOFT_DUST_KOINU and cap < value and value - cap >= minimum,
            'refund policy exceeds value or falls below retained minimum')
    return parsed, value, cap, minimum


def verify_public_signature(public, signature, message_digest):
    """Verify strict low-S DER using only public temporary files and OpenSSL."""
    checked_pubkey(public)
    require(type(signature) is bytes and signature[-1:] == b'\x01', 'legacy SIGHASH_ALL required')
    _, s = decode_der(signature[:-1])
    require(s <= ORDER // 2, 'low-S signature required')
    require(type(message_digest) is bytes and len(message_digest) == 32, 'prehashed digest required')
    with tempfile.TemporaryDirectory(prefix='doge-public-verification-') as tmp:
        public_path, sig_path = Path(tmp)/'public.der', Path(tmp)/'signature.der'
        for path, data in [(public_path, SPKI_PREFIX + public), (sig_path, signature[:-1])]:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(data)
            finally:
                os.close(fd)
        try:
            result = subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-keyform', 'DER',
                '-inkey', str(public_path), '-sigfile', str(sig_path), '-pkeyopt', 'digest:sha256'],
                input=message_digest, capture_output=True, timeout=5,
                env={'PATH':'/usr/bin:/bin', 'LANG':'C.UTF-8'})
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SignerUnavailableError('public signature verification primitive unavailable') from error
    require(result.returncode == 0, 'refund signature verification failed')


def validate_signed_refund(entry, *, contract, funding, policy):
    parsed, value, cap, minimum = common_terms(contract, funding, policy)
    exact(entry, ['transactionHex', 'sha256', 'txid', 'destinationHex', 'outputValueKoinu',
                  'feeKoinu', 'lockTime', 'sequence'], 'signed refund')
    raw = hex_bytes(entry['transactionHex'], 10000)
    require(hashlib.sha256(raw).hexdigest() == digest(entry['sha256']), 'refund byte digest mismatch')
    require(txid(raw) == digest(entry['txid'], 'refund txid'), 'refund txid mismatch')
    decoded = parse_transaction(raw)
    require(len(decoded['outputs']) == 1, 'exactly one refund output required')
    vin, output = decoded['inputs'][0], decoded['outputs'][0]
    require(vin['txid'] == funding['txid'] and vin['vout'] == funding['vout'], 'refund funding outpoint mismatch')
    dest = destination(entry['destinationHex'])
    net, fee = amount(entry['outputValueKoinu'], positive=True), amount(entry['feeKoinu'], positive=True)
    require(fee <= cap and net >= minimum and value - net == fee, 'refund fee or retained amount violates policy')
    require(output['valueKoinu'] == net and output['scriptPubKey'] == dest, 'refund destination/value mismatch')
    require(type(entry['lockTime']) is int and entry['lockTime'] == decoded['lockTime'] == parsed.lock,
            'refund lock differs from the approved contract')
    require(type(entry['sequence']) is int and entry['sequence'] == vin['sequence'] == SEQUENCE,
            'refund sequence outside the approved profile')
    script = vin['scriptSig']
    require(len(script) >= 2 and 9 <= script[0] <= 73, 'direct canonical refund signature push required')
    signature = script[1:1+script[0]]
    require(script == push(signature) + b'\0' + push(parsed.redeem), 'canonical refund branch scriptSig required')
    # Reserialization binds every raw field, including version and vector layout.
    require(raw == transaction(funding['txid'], funding['vout'], script, [(net, dest)], parsed.lock, SEQUENCE),
            'serialized refund differs from approved transaction')
    verify_public_signature(parsed.refund_public, signature,
        sighash(funding['txid'], funding['vout'], parsed.redeem, [(net, dest)], parsed.lock, SEQUENCE))
    return dict(entry)


def validate_refund_ladder(entries, *, contract, funding, policy):
    require(type(entries) is list and 1 <= len(entries) <= MAX_LADDER, 'one to eight pre-signed refunds required')
    checked, previous, identities, destination_hex = [], -1, set(), None
    for entry in entries:
        current = validate_signed_refund(entry, contract=contract, funding=funding, policy=policy)
        fee = amount(current['feeKoinu'], positive=True)
        require(fee > previous, 'refund ladder fees must strictly increase')
        require(current['txid'] not in identities, 'duplicate refund identity')
        require(destination_hex is None or current['destinationHex'] == destination_hex,
                'refund ladder destination changed')
        destination_hex, previous = current['destinationHex'], fee
        identities.add(current['txid']); checked.append(current)
    return checked


def select_presigned_refund(entries, required_fee_koinu, *, contract, funding, policy):
    required = amount(required_fee_koinu)
    checked = validate_refund_ladder(entries, contract=contract, funding=funding, policy=policy)
    for entry in checked:
        if amount(entry['feeKoinu']) >= required:
            return entry
    raise FeeCoverageError('observed fee requirement exceeds every approved pre-signed refund; signer is required')


def _hash(domain, value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    require(len(raw) <= 65536, 'signer request exceeds bound')
    return hashlib.sha256(domain.encode() + b'\0' + raw).hexdigest()


def create_refund_signing_request(*, contract, funding, policy, destination_hex, fees,
                                  request_id, created_at_height, request_expires_at_height):
    parsed, value, cap, minimum = common_terms(contract, funding, policy)
    dest = destination(destination_hex)
    require(type(fees) is list and 1 <= len(fees) <= MAX_LADDER, 'one to eight fee steps required')
    require(type(request_id) is str and re.fullmatch('[A-Za-z0-9_-]{8,64}', request_id), 'bounded request id required')
    created, expires = height(created_at_height), height(request_expires_at_height)
    require(created < expires, 'signing request deadline must follow its creation')
    entries, previous = [], -1
    for text in fees:
        fee = amount(text, positive=True)
        require(previous < fee <= cap and value - fee >= minimum, 'fee ladder violates approved budget')
        net = value - fee
        entries.append({'feeKoinu':text, 'outputValueKoinu':str(net),
            'unsignedTransactionHex':transaction(funding['txid'], funding['vout'], b'', [(net,dest)], parsed.lock, SEQUENCE).hex(),
            'sighashHex':sighash(funding['txid'], funding['vout'], parsed.redeem, [(net,dest)], parsed.lock, SEQUENCE).hex()})
        previous = fee
    terms = {'network':'regtest','genesis':GENESIS,'sourceCommit':SOURCE,
        'contract':dict(contract),'funding':dict(funding),'policy':dict(policy),'destinationHex':destination_hex}
    request = {'domain':REQUEST_DOMAIN, 'schemaVersion':1, **terms,
        'requestId':request_id,'createdAtHeight':created,'requestExpiresAtHeight':expires,
        'termsDigest':_hash('GPUBNB:DOGE:REFUND_TERMS:v1', terms), 'entries':entries}
    return {**request, 'requestDigest':_hash(REQUEST_DOMAIN, request)}


def validate_refund_signing_request(request, *, trusted_terms_digest, trusted_request_digest, current_height):
    exact(request, ['domain','schemaVersion','network','genesis','sourceCommit','contract','funding','policy',
        'destinationHex','requestId','createdAtHeight','requestExpiresAtHeight','termsDigest','entries','requestDigest'], 'signer request')
    require(request['domain'] == REQUEST_DOMAIN and type(request['schemaVersion']) is int
            and request['schemaVersion'] == 1 and request['network'] == 'regtest'
            and request['genesis'] == GENESIS and request['sourceCommit'] == SOURCE, 'wrong signer domain/network/source')
    require(type(request['entries']) is list and 1 <= len(request['entries']) <= MAX_LADDER, 'bounded signer entries required')
    for entry in request['entries']:
        exact(entry, ['feeKoinu','outputValueKoinu','unsignedTransactionHex','sighashHex'], 'signer entry')
    expected = create_refund_signing_request(contract=request['contract'], funding=request['funding'], policy=request['policy'],
        destination_hex=request['destinationHex'], fees=[entry['feeKoinu'] for entry in request['entries']],
        request_id=request['requestId'], created_at_height=request['createdAtHeight'],
        request_expires_at_height=request['requestExpiresAtHeight'])
    require(request == expected and request['termsDigest'] == digest(trusted_terms_digest)
            and request['requestDigest'] == digest(trusted_request_digest), 'signer request differs from trusted displayed terms')
    now = height(current_height)
    require(request['createdAtHeight'] <= now < request['requestExpiresAtHeight'], 'signing request is stale or expired')
    return expected



def signer_review_fields(request, *, trusted_terms_digest, trusted_request_digest, current_height):
    """Deterministic public review fields; the caller must actually display them."""
    checked = validate_refund_signing_request(request, trusted_terms_digest=trusted_terms_digest,
        trusted_request_digest=trusted_request_digest, current_height=current_height)
    def doge(text):
        number = amount(text)
        return str(number // 100_000_000) + '.' + str(number % 100_000_000).zfill(8)
    parsed, _, _, _ = common_terms(checked['contract'], checked['funding'], checked['policy'])
    return {'asset':'DOGE','network':checked['network'],'genesis':checked['genesis'],
        'sourceCommit':checked['sourceCommit'],'requestDigest':checked['requestDigest'],
        'fundingOutpoint':checked['funding']['txid']+':'+str(checked['funding']['vout']),
        'inputDoge':doge(checked['funding']['valueKoinu']),'destinationScriptHex':checked['destinationHex'],
        'refundPublicHex':parsed.refund_public.hex(),'lockTime':parsed.lock,'sequence':SEQUENCE,
        'maximumFeeDoge':doge(checked['policy']['maxFeeKoinu']),
        'minimumRefundDoge':doge(checked['policy']['minRefundKoinu']),
        'requestExpiresAtHeight':checked['requestExpiresAtHeight'],
        'steps':[{'feeDoge':doge(row['feeKoinu']),'refundDoge':doge(row['outputValueKoinu']),
                  'sighashHex':row['sighashHex']} for row in checked['entries']]}


def finalize_refund_signing_response(request, response, *, trusted_terms_digest, trusted_request_digest, current_height):
    approved = validate_refund_signing_request(request, trusted_terms_digest=trusted_terms_digest,
        trusted_request_digest=trusted_request_digest, current_height=current_height)
    if response is None:
        raise SignerUnavailableError('external signer disconnected or returned no response; no signing fallback')
    exact(response, ['domain','schemaVersion','requestId','requestDigest','refundPublicHex','signatures'], 'signer response')
    require(response['domain'] == RESPONSE_DOMAIN and type(response['schemaVersion']) is int and response['schemaVersion'] == 1
            and response['requestId'] == approved['requestId'] and response['requestDigest'] == approved['requestDigest'],
            'external signer response identity mismatch')
    parsed, _, _, _ = common_terms(approved['contract'], approved['funding'], approved['policy'])
    require(hex_bytes(response['refundPublicHex'],33,size=33) == parsed.refund_public, 'external signer refund role mismatch')
    require(type(response['signatures']) is list and len(response['signatures']) == len(approved['entries']),
            'external signer omitted a refund step')
    result = []
    for step, encoded in zip(approved['entries'], response['signatures']):
        signature = hex_bytes(encoded, 73)
        net = amount(step['outputValueKoinu'], positive=True)
        raw = transaction(approved['funding']['txid'], approved['funding']['vout'],
            push(signature) + b'\0' + push(parsed.redeem), [(net,bytes.fromhex(approved['destinationHex']))], parsed.lock, SEQUENCE)
        result.append({'transactionHex':raw.hex(),'sha256':hashlib.sha256(raw).hexdigest(),'txid':txid(raw),
            'destinationHex':approved['destinationHex'],'outputValueKoinu':step['outputValueKoinu'],
            'feeKoinu':step['feeKoinu'],'lockTime':parsed.lock,'sequence':SEQUENCE})
    return validate_refund_ladder(result, contract=approved['contract'], funding=approved['funding'], policy=approved['policy'])
