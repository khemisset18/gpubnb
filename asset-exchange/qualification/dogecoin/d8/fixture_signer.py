"""Child zipapp entry for D8 qualification only; never a product signer.

The immutable fixture config independently pins the approved synthetic request.
Its only signing key is a disposable refund fixture generated after D0/namespace
checks. This program provides no physical display or hardware approval.
"""
import os
from pathlib import Path
import stat
import sys
import zipfile


def main():
    import external_signer as broker
    from test_signer import EphemeralSigner
    with zipfile.ZipFile(sys.argv[0]) as archive:
        config = broker.decode(archive.read('fixture.json'))
    broker.policy.exact(config, ('termsDigest', 'requestDigest', 'keyFile', 'markerFile',
                                 'syntheticHeight'), 'D8 fixture configuration')
    raw = sys.stdin.buffer.read(65_537)
    assert 0 < len(raw) <= 65_536 and b'PRIVATE KEY' not in raw
    envelope = broker.decode(raw)
    broker.policy.exact(envelope, (*broker.SESSION_FIELDS, 'pairing', 'request', 'review'),
                        'D8 fixture session')
    assert envelope['domain'] == broker.SEND_DOMAIN
    assert type(envelope['schemaVersion']) is int and envelope['schemaVersion'] == 1
    request = broker.policy.validate_refund_signing_request(envelope['request'],
        trusted_terms_digest=config['termsDigest'], trusted_request_digest=config['requestDigest'],
        current_height=config['syntheticHeight'])
    review = broker.policy.signer_review_fields(request,
        trusted_terms_digest=config['termsDigest'], trusted_request_digest=config['requestDigest'],
        current_height=config['syntheticHeight'])
    assert envelope['requestDigest'] == config['requestDigest']
    assert envelope['review'] == review
    assert envelope['reviewDigest'] == broker.public_digest(broker.REVIEW_DOMAIN, review)
    assert len(request['entries']) == 3
    pairing = broker.validate_pairing(envelope['pairing'], envelope['pairingDigest'])
    key = Path(config['keyFile'])
    metadata = key.lstat()
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
    assert stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_uid == os.getuid()
    signer = EphemeralSigner.__new__(EphemeralSigner)
    signer.path = key
    public = signer._run(['ec', '-in', str(key), '-pubout', '-conv_form', 'compressed', '-outform', 'DER'])
    assert public.startswith(broker.policy.SPKI_PREFIX)
    signer.public = public[len(broker.policy.SPKI_PREFIX):]
    assert signer.public.hex() == pairing['refundPublicHex'] == review['refundPublicHex']
    signatures = [signer.sign(bytes.fromhex(entry['sighashHex'])).hex()
                  for entry in request['entries']]
    receipt = {'pid': os.getpid(), 'parentPid': os.getppid(),
        'networkNamespace': os.readlink('/proc/self/ns/net'), 'signaturesProduced': len(signatures),
        'physicalUserApproval': False, 'softwareFixtureApproval': True,
        'requestDigest': request['requestDigest'], 'sessionId': envelope['sessionId']}
    fd = os.open(config['markerFile'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as handle:
            handle.write(broker.encode(receipt) + b'\n')
    finally:
        os.close(fd)
    response = {'domain': broker.policy.RESPONSE_DOMAIN, 'schemaVersion': 1,
        'requestId': request['requestId'], 'requestDigest': request['requestDigest'],
        'refundPublicHex': signer.public.hex(), 'signatures': signatures}
    reply = {key: envelope[key] for key in broker.SESSION_FIELDS}
    reply.update(domain=broker.REPLY_DOMAIN, response=response)
    sys.stdout.buffer.write(broker.encode(reply))


if __name__ == '__main__':
    main()
