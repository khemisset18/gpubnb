"""Read-only inspection of the official Trust Wallet CRX; never install or execute it."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import struct
import zipfile
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

if not __debug__:
    raise RuntimeError('CRX evidence verifier refuses Python optimization')

ROOT = Path(__file__).resolve().parent
EXPECTED_ID = 'egjidjbpglichdcondbcbdnbeeppgdph'

def varint(data, offset):
    value = 0
    for index in range(10):
        if offset >= len(data): raise ValueError('truncated protobuf varint')
        byte = data[offset]; offset += 1
        value |= (byte & 127) << (index * 7)
        if byte < 128: return value, offset
    raise ValueError('oversized protobuf varint')

def fields(data):
    out = {}
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0: raise ValueError('invalid protobuf field')
        if wire == 2:
            size, offset = varint(data, offset)
            end = offset + size
            if end > len(data): raise ValueError('truncated protobuf field')
            value = data[offset:end]; offset = end
        elif wire == 0: value, offset = varint(data, offset)
        elif wire in (1, 5):
            end = offset + (8 if wire == 1 else 4)
            if end > len(data): raise ValueError('truncated fixed protobuf field')
            value = data[offset:end]; offset = end
        else: raise ValueError('unsupported protobuf wire')
        out.setdefault(number, []).append(value)
    return out

def one(data, number):
    values = data.get(number, [])
    if len(values) != 1 or not isinstance(values[0], bytes):
        raise ValueError('missing or duplicate critical CRX field')
    return values[0]

def extension_id(digest):
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest[:16].hex())

def main():
    archive = ROOT / 'trust-wallet-official.crx'
    raw = archive.read_bytes()
    if len(raw) > 128 * 1024 * 1024: raise ValueError('CRX exceeds bound')
    magic, version, header_size = struct.unpack('<4sII', raw[:12])
    assert magic == b'Cr24' and version == 3
    assert 0 < header_size <= 16 * 1024 * 1024 and 12 + header_size < len(raw)
    header = fields(raw[12:12 + header_size])
    signed_header = one(header, 10000)
    identifier = one(fields(signed_header), 1)
    assert len(identifier) == 16 and extension_id(identifier) == EXPECTED_ID
    zipped = raw[12 + header_size:]
    signed = b'CRX3 SignedData\x00' + struct.pack('<I', len(signed_header)) + signed_header + zipped
    proofs = []
    for field_number in (2, 3):
        for proof_raw in header.get(field_number, []):
            proof = fields(proof_raw)
            public_der, signature = one(proof, 1), one(proof, 2)
            public = serialization.load_der_public_key(public_der)
            if field_number == 2 and isinstance(public, rsa.RSAPublicKey):
                public.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
            elif field_number == 3 and isinstance(public, ec.EllipticCurvePublicKey):
                public.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
            else: raise ValueError('unexpected CRX signing key type')
            key_hash = hashlib.sha256(public_der).digest()
            proofs.append({'algorithm': 'RSA_SHA256' if field_number == 2 else 'ECDSA_SHA256',
                'publicKeySha256': key_hash.hex(), 'signatureValid': True,
                'keyMatchesExtensionId': extension_id(key_hash) == EXPECTED_ID})
    assert proofs and any(p['keyMatchesExtensionId'] for p in proofs), 'no verified proof bound to expected extension ID'
    with zipfile.ZipFile(io.BytesIO(zipped)) as bundle:
        names = bundle.namelist()
        assert len(names) == len(set(names))
        assert sum(e.file_size for e in bundle.infolist()) < 512 * 1024 * 1024
        assert all(e.file_size < 128 * 1024 * 1024 for e in bundle.infolist())
        for name in names:
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in name
        assert bundle.testzip() is None
        manifest_bytes = bundle.read('manifest.json')
        manifest = json.loads(manifest_bytes)
        result = {'schemaVersion': 1, 'result': 'PASS_OFFICIAL_CRX_SIGNATURE_AND_STATIC_INVENTORY_ONLY',
            'extensionId': EXPECTED_ID, 'version': manifest['version'],
            'manifestVersion': manifest['manifest_version'], 'crxBytes': len(raw),
            'crxSha256': hashlib.sha256(raw).hexdigest(), 'zipSha256': hashlib.sha256(zipped).hexdigest(),
            'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'proofs': proofs,
            'zipCrc': 'PASS', 'entries': len(names), 'uncompressedBytes': sum(e.file_size for e in bundle.infolist()),
            'contentScripts': manifest.get('content_scripts'), 'background': manifest.get('background'),
            'webAccessibleResources': manifest.get('web_accessible_resources'),
            'staticCandidateFiles': [n for n in names if n.endswith('.js') and any(t in n.lower() for t in ['inject', 'provider', 'content', 'inpage'])],
            'installation': False, 'extensionCodeExecuted': False, 'walletConnected': False,
            'keysGenerated': 0, 'signaturesRequested': 0, 'broadcasts': 0,
            'dogeSigningCompatibility': 'NOT_ESTABLISHED_BY_ARCHIVE_VERIFICATION'}
        (ROOT / 'extension-manifest.json').write_bytes(manifest_bytes)
        (ROOT / 'extension-static-inventory.json').write_text(json.dumps(result, indent=2) + '\n')
        (ROOT / 'extension-payload.zip').write_bytes(zipped)
    print(json.dumps(result))

if __name__ == '__main__': main()
