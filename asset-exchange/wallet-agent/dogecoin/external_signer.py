"""Paired external software signing, exclusively for the existing DOGE Regtest profile.

This public broker has no signing key, RPC broadcast, HTTP listener or hardware
driver. A locally selected, independently pinned zipapp performs signing in a
separate process. Process separation is not an OS/network sandbox. Pairing and
session echoes do not prove firmware provenance or a physical display.
"""
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import zipfile

import refund_ladder as policy
import external_transport

PAIR_DOMAIN = 'GPUBNB:DOGE:EXTERNAL_SIGNER_PAIRING:v1'
SEND_DOMAIN = 'GPUBNB:DOGE:EXTERNAL_SIGNER_SESSION:v1'
REPLY_DOMAIN = 'GPUBNB:DOGE:EXTERNAL_SIGNER_REPLY:v1'
REVIEW_DOMAIN = 'GPUBNB:DOGE:EXTERNAL_SIGNER_REVIEW:v1'
JOURNAL_DOMAIN = 'GPUBNB:DOGE:EXTERNAL_SIGNER_JOURNAL:v1'
PROFILE = 'DOGE_REGTEST_LEGACY_P2SH_CLTV_SIGHASH_ALL_EXTERNAL_SOFTWARE_V1'
PAIR_AUTHORIZATION = 'AUTHORIZE_DOGE_REGTEST_EXTERNAL_SOFTWARE_SIGNER'
MAX_PACKAGE = 8 * 1024 * 1024
MAX_MESSAGE = 128 * 1024
PAIR_FIELDS = ('domain', 'schemaVersion', 'profile', 'network', 'genesis',
               'sourceCommit', 'signerKind', 'signerId', 'refundPublicHex',
               'adapterSha256', 'adapterBytes')
SESSION_FIELDS = ('domain', 'schemaVersion', 'pairingDigest', 'sessionId',
                  'challenge', 'requestDigest', 'reviewDigest')
JOURNAL_FIELDS = ('domain', 'schemaVersion', 'pairingDigest', 'requestId',
                  'requestDigest', 'termsDigest', 'sessionId', 'challenge',
                  'reviewDigest', 'observedBeforeHeight', 'acceptedAtHeight',
                  'status', 'responseEnvelope')


def encode(value):
    try:
        raw = json.dumps(value, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=True, allow_nan=False).encode('ascii')
    except (ValueError, TypeError, RecursionError) as error:
        raise ValueError('invalid external signer JSON') from error
    policy.require(len(raw) <= MAX_MESSAGE, 'external signer message exceeds bound')
    return raw


def decode(raw):
    policy.require(type(raw) is bytes and 0 < len(raw) <= MAX_MESSAGE,
                   'bounded external signer JSON required')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            policy.require(key not in result, 'duplicate external signer JSON key')
            result[key] = value
        return result

    def invalid(_):
        raise ValueError('nonfinite external signer JSON number')

    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                          parse_constant=invalid)
    except (UnicodeError, RecursionError, json.JSONDecodeError) as error:
        raise ValueError('malformed external signer response') from error


def public_digest(domain, value):
    return hashlib.sha256(domain.encode('ascii') + b'\0' + encode(value)).hexdigest()


def _package(package, expected_sha256):
    policy.require(type(package) is bytes and 0 < len(package) <= MAX_PACKAGE,
                   'bounded immutable external signer package required')
    policy.require(hashlib.sha256(package).hexdigest() == policy.digest(expected_sha256),
                   'external signer package identity mismatch')
    try:
        with zipfile.ZipFile(io.BytesIO(package)) as bundle:
            rows = bundle.infolist()
            names = [row.filename for row in rows]
            policy.require(0 < len(rows) <= 64 and len(names) == len(set(names))
                           and '__main__.py' in names, 'bounded unique zipapp required')
            policy.require(sum(row.file_size for row in rows) <= 16 * 1024 * 1024,
                           'external signer package expansion bound')
            for row in rows:
                path = PurePosixPath(row.filename)
                policy.require(not path.is_absolute() and '..' not in path.parts
                               and '\\' not in row.filename
                               and not stat.S_ISLNK(row.external_attr >> 16),
                               'unsafe external signer package member')
    except (zipfile.BadZipFile, OSError) as error:
        raise ValueError('invalid external signer zipapp') from error
    return package


def create_pairing(package, *, expected_adapter_sha256, refund_public_hex,
                   signer_id, authorization):
    """Explicit local pairing; keep the returned digest independently of the file."""
    policy.require(authorization == PAIR_AUTHORIZATION, 'explicit local signer pairing required')
    _package(package, expected_adapter_sha256)
    public = policy.hex_bytes(refund_public_hex, 33, size=33)
    policy.checked_pubkey(public)
    policy.require(type(signer_id) is str and re.fullmatch('[A-Za-z0-9_-]{8,64}', signer_id),
                   'bounded local signer identity required')
    pairing = {'domain': PAIR_DOMAIN, 'schemaVersion': 1, 'profile': PROFILE,
               'network': 'regtest', 'genesis': policy.GENESIS,
               'sourceCommit': policy.SOURCE, 'signerKind': 'external-software',
               'signerId': signer_id, 'refundPublicHex': refund_public_hex,
               'adapterSha256': expected_adapter_sha256, 'adapterBytes': len(package)}
    return pairing, public_digest(PAIR_DOMAIN, pairing)


def validate_pairing(pairing, trusted_pairing_digest):
    policy.exact(pairing, PAIR_FIELDS, 'external signer pairing')
    policy.require(pairing['domain'] == PAIR_DOMAIN and type(pairing['schemaVersion']) is int
                   and pairing['schemaVersion'] == 1 and pairing['profile'] == PROFILE
                   and pairing['network'] == 'regtest' and pairing['genesis'] == policy.GENESIS
                   and pairing['sourceCommit'] == policy.SOURCE
                   and pairing['signerKind'] == 'external-software',
                   'unsupported external signer profile/network/kind')
    policy.require(type(pairing['adapterBytes']) is int
                   and 0 < pairing['adapterBytes'] <= MAX_PACKAGE,
                   'invalid external signer package size')
    policy.require(type(pairing['signerId']) is str
                   and re.fullmatch('[A-Za-z0-9_-]{8,64}', pairing['signerId']),
                   'invalid paired signer identity')
    policy.checked_pubkey(policy.hex_bytes(pairing['refundPublicHex'], 33, size=33))
    policy.digest(pairing['adapterSha256'])
    policy.require(public_digest(PAIR_DOMAIN, pairing) == policy.digest(trusted_pairing_digest),
                   'pairing differs from independently retained receipt')
    return pairing


def _read_fd(fd, maximum=MAX_MESSAGE):
    info = os.fstat(fd)
    policy.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                   and 0 < info.st_size <= maximum, 'bounded single-link regular file required')
    chunks, size = [], 0
    while True:
        chunk = os.read(fd, min(8192, maximum + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        policy.require(size <= maximum, 'external signer file grew beyond bound')
    return b''.join(chunks)


def read_public_file(path, maximum=MAX_MESSAGE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        return _read_fd(fd, maximum)
    finally:
        os.close(fd)


def persist_pairing(path, pairing, trusted_pairing_digest):
    """Exclusive 0600 write, fsync and readback; an interrupted file is never replaced."""
    validate_pairing(pairing, trusted_pairing_digest)
    target = Path(path)
    raw = encode(pairing) + b'\n'
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        _write_all(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    policy.require(read_public_file(target) == raw, 'paired signer durable readback mismatch')
    return trusted_pairing_digest


def load_pairing(path, trusted_pairing_digest):
    return validate_pairing(decode(read_public_file(path)), trusted_pairing_digest)


def _write_all(fd, raw):
    view = memoryview(raw)
    while view:
        wrote = os.write(fd, view)
        policy.require(wrote > 0, 'external signer journal write failed')
        view = view[wrote:]


@contextmanager
def _journal(directory):
    policy.require(os.name == 'posix', 'external signer journal requires qualified POSIX host')
    import fcntl
    path = Path(directory)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Persist the journal directory entry, including a retry after an
        # earlier interrupted mkdir. Fsync of the child alone is insufficient.
        os.fsync(parent)
    finally:
        os.close(parent)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        info = os.fstat(fd)
        policy.require(info.st_uid == os.getuid() and not info.st_mode & 0o077,
                       'private owner-only signer journal directory required')
        lock = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=fd)
        info = os.fstat(lock)
        policy.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                       and info.st_uid == os.getuid() and not info.st_mode & 0o077,
                       'private single-link signer journal lock required')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise policy.SignerUnavailableError('external signer journal already in use') from error
        yield fd
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def _name(pairing_digest, request_id):
    return hashlib.sha256((pairing_digest + '\0' + request_id).encode('ascii')).hexdigest() + '.json'


def _load_state(directory_fd, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        policy.require(info.st_uid == os.getuid() and not info.st_mode & 0o077,
                       'private signer journal entry required')
        return decode(_read_fd(fd))
    finally:
        os.close(fd)


def _save_state(directory_fd, name, value):
    raw = encode(value) + b'\n'
    policy.require(len(raw) <= MAX_MESSAGE, 'external signer journal exceeds bound')
    temporary = 'pending-' + secrets.token_hex(16)
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory_fd)
        _write_all(fd, raw)
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
    policy.require(_load_state(directory_fd, name) == value,
                   'external signer journal durable readback mismatch')


def _static_request(request, trusted_terms_digest, trusted_request_digest):
    """Recheck the original schema/terms, not authorization at the present tip."""
    policy.require(type(request) is dict, 'external signer request object required')
    try:
        original_height = request['createdAtHeight']
    except KeyError as error:
        raise ValueError('malformed external signer request') from error
    # Reuse the unchanged strict validator, including int-vs-bool/float checks.
    # Fresh signing separately validates the two independently observed heights;
    # cached public signatures separately validate their recorded acceptance.
    return policy.validate_refund_signing_request(request,
        trusted_terms_digest=trusted_terms_digest, trusted_request_digest=trusted_request_digest,
        current_height=original_height)


def _bind_request(pairing, request):
    parsed, _, _, _ = policy.common_terms(request['contract'], request['funding'], request['policy'])
    policy.require(parsed.refund_public.hex() == pairing['refundPublicHex'],
                   'paired signer is not the approved refund key')


def _check_state(state, pairing_digest, request):
    policy.exact(state, JOURNAL_FIELDS, 'external signer journal')
    policy.require(state['domain'] == JOURNAL_DOMAIN and type(state['schemaVersion']) is int
                   and state['schemaVersion'] == 1 and state['pairingDigest'] == pairing_digest
                   and state['requestId'] == request['requestId']
                   and state['requestDigest'] == request['requestDigest']
                   and state['termsDigest'] == request['termsDigest'],
                   'signer request ID is already bound to different terms')
    policy.hex_bytes(state['sessionId'], 16, size=16)
    policy.hex_bytes(state['challenge'], 32, size=32)
    before = policy.height(state['observedBeforeHeight'])
    expected_review = policy.signer_review_fields(request,
        trusted_terms_digest=request['termsDigest'], trusted_request_digest=request['requestDigest'],
        current_height=before)
    policy.require(state['reviewDigest'] == public_digest(REVIEW_DOMAIN, expected_review),
                   'stored signer review differs from approved request')
    policy.require(state['status'] in ('IN_FLIGHT', 'COMPLETE'), 'invalid signer journal state')
    if state['status'] == 'IN_FLIGHT':
        policy.require(state['responseEnvelope'] is None and state['acceptedAtHeight'] is None,
                       'invalid unfinished signer journal')
    else:
        accepted = policy.height(state['acceptedAtHeight'])
        policy.require(before <= accepted < request['requestExpiresAtHeight'],
                       'invalid stored signer acceptance height')


def _reply(reply, state):
    policy.exact(reply, (*SESSION_FIELDS, 'response'), 'external signer reply')
    policy.require(reply['domain'] == REPLY_DOMAIN and type(reply['schemaVersion']) is int
                   and reply['schemaVersion'] == 1
                   and all(reply[key] == state[key] for key in
                           ('pairingDigest', 'sessionId', 'challenge', 'requestDigest', 'reviewDigest')),
                   'external signer session/review identity mismatch')
    return reply['response']


def _completed(state, pairing_digest, request, *, cached):
    _check_state(state, pairing_digest, request)
    if state['status'] != 'COMPLETE':
        raise policy.SignerUnavailableError(
            'prior signing attempt is incomplete; no automatic retry or fallback signing')
    response = _reply(state['responseEnvelope'], state)
    # A stored response is public and already approved. Only this recovery path
    # rechecks its original acceptance height: it does not request a
    # new signature or claim a fresh chain observation. Existing refunds do not
    # expire when the signing-request deadline passes.
    refunds = policy.finalize_refund_signing_response(
        request, response, trusted_terms_digest=request['termsDigest'],
        trusted_request_digest=request['requestDigest'], current_height=state['acceptedAtHeight'])
    return {'schemaVersion': 1, 'profile': PROFILE, 'pairingDigest': pairing_digest,
            'requestId': request['requestId'], 'requestDigest': request['requestDigest'],
            'reviewDigest': state['reviewDigest'], 'sessionId': state['sessionId'],
            'cached': cached, 'hardwareQualified': False, 'refunds': refunds}


def recover_completed_refunds(request, *, pairing, trusted_pairing_digest,
                              trusted_terms_digest, trusted_request_digest, journal_directory):
    """Read only already-completed public signatures, without an adapter/key/RPC."""
    pairing = decode(encode(validate_pairing(pairing, trusted_pairing_digest)))
    request = _static_request(request, trusted_terms_digest, trusted_request_digest)
    _bind_request(pairing, request)
    with _journal(journal_directory) as directory:
        state = _load_state(directory, _name(trusted_pairing_digest, request['requestId']))
        if state is None:
            raise policy.SignerUnavailableError('completed signed refund record is absent')
        return _completed(state, trusted_pairing_digest, request, cached=True)


def request_refund_signatures(request, *, pairing, trusted_pairing_digest,
                              trusted_terms_digest, trusted_request_digest, package,
                              height_provider, journal_directory, timeout_seconds=15):
    """Dispatch once; journal and return only fully verified public refunds.

    height_provider is the local caller's independently validated Regtest tip,
    called before dispatch and again after the response. Never use a height
    declared by the signer or backend. A prior incomplete attempt is refused.
    """
    pairing = decode(encode(validate_pairing(pairing, trusted_pairing_digest)))
    request = _static_request(request, trusted_terms_digest, trusted_request_digest)
    _bind_request(pairing, request)
    _package(package, pairing['adapterSha256'])
    policy.require(len(package) == pairing['adapterBytes'], 'paired adapter package length mismatch')
    policy.require(type(timeout_seconds) is int and 1 <= timeout_seconds <= 120,
                   'bounded integer external signer timeout required')
    policy.require(callable(height_provider), 'independent Regtest height provider required')
    with _journal(journal_directory) as directory:
        name = _name(trusted_pairing_digest, request['requestId'])
        prior = _load_state(directory, name)
        if prior is not None:
            return _completed(prior, trusted_pairing_digest, request, cached=True)
        before = policy.height(height_provider())
        review = policy.signer_review_fields(request, trusted_terms_digest=trusted_terms_digest,
            trusted_request_digest=trusted_request_digest, current_height=before)
        review_digest = public_digest(REVIEW_DOMAIN, review)
        state = {'domain': JOURNAL_DOMAIN, 'schemaVersion': 1,
                 'pairingDigest': trusted_pairing_digest, 'requestId': request['requestId'],
                 'requestDigest': request['requestDigest'], 'termsDigest': request['termsDigest'],
                 'sessionId': secrets.token_hex(16), 'challenge': secrets.token_hex(32),
                 'reviewDigest': review_digest, 'observedBeforeHeight': before,
                 'acceptedAtHeight': None, 'status': 'IN_FLIGHT', 'responseEnvelope': None}
        envelope = {'domain': SEND_DOMAIN, 'schemaVersion': 1, 'pairingDigest': trusted_pairing_digest,
                    'sessionId': state['sessionId'], 'challenge': state['challenge'],
                    'requestDigest': request['requestDigest'], 'reviewDigest': review_digest,
                    'pairing': pairing, 'request': request, 'review': review}
        payload = encode(envelope) + b'\n'
        policy.require(len(payload) <= 64 * 1024, 'external signer request transport bound')
        _save_state(directory, name, state)
        raw = external_transport.exchange(package, payload, timeout_seconds=timeout_seconds)
        reply = decode(raw)
        response = _reply(reply, state)
        after = policy.height(height_provider())
        policy.require(after >= before, 'Regtest height rolled back during signing; fresh approval required')
        refunds = policy.finalize_refund_signing_response(
            request, response, trusted_terms_digest=trusted_terms_digest,
            trusted_request_digest=trusted_request_digest, current_height=after)
        complete = {**state, 'status': 'COMPLETE', 'acceptedAtHeight': after,
                    'responseEnvelope': reply}
        _save_state(directory, name, complete)
        result = _completed(complete, trusted_pairing_digest, request, cached=False)
        policy.require(result['refunds'] == refunds, 'stored signed refund result changed')
        return result
