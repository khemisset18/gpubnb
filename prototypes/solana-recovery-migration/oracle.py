#!/usr/bin/env python3
"""Public-data secp256k1 recovery oracle using Python integer arithmetic only."""
import argparse
import hashlib
import json
from pathlib import Path

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
VECTOR_SHA256 = '43db761c0a2eae71fb0755d355d5130e28ce64a5b07846cf27e7072082597a81'


def double(q):
    x, y, z = q
    if not z or not y:
        return (0, 1, 0)
    yy = y*y % P
    s = 4*x*yy % P
    m = 3*x*x % P
    nx = (m*m - 2*s) % P
    return nx, (m*(s-nx)-8*yy*yy) % P, 2*y*z % P


def add_mixed(q, affine):
    if affine is None:
        return q
    x, y, z = q
    if not z:
        return (*affine, 1)
    u = affine[0]*z*z % P
    v = affine[1]*z*z*z % P
    h, r = (u-x) % P, (v-y) % P
    if not h:
        return double(q) if not r else (0, 1, 0)
    hh = h*h % P
    hhh, xhh = h*hh % P, x*hh % P
    nx = (r*r-hhh-2*xhh) % P
    return nx, (r*(xhh-nx)-y*hhh) % P, z*h % P


def affine(q):
    x, y, z = q
    if not z:
        return None
    inv = pow(z, -1, P)
    return x*inv*inv % P, y*inv*inv*inv % P


def multiply(scalar, point):
    result = (0, 1, 0)
    for bit in bin(scalar)[2:]:
        result = double(result)
        if bit == '1':
            result = add_mixed(result, point)
    return affine(result)


def recover(message_hash, recovery_id, signature):
    if len(message_hash) != 32:
        return {'error': 'InvalidHash'}
    if recovery_id > 3:
        return {'error': 'InvalidRecoveryId'}
    if len(signature) != 64:
        return {'error': 'InvalidSignature'}
    r, s = int.from_bytes(signature[:32], 'big'), int.from_bytes(signature[32:], 'big')
    if not (0 < r < N and 0 < s < N):
        return {'error': 'InvalidSignature'}
    x = r + (recovery_id >> 1)*N
    if x >= P:
        return {'error': 'InvalidSignature'}
    rhs = (x*x*x+7) % P
    y = pow(rhs, (P+1)//4, P)
    if y*y % P != rhs:
        return {'error': 'InvalidSignature'}
    if y % 2 != recovery_id % 2:
        y = P-y
    inverse_r = pow(r, -1, N)
    a = multiply(s*inverse_r % N, (x, y))
    b = multiply((-int.from_bytes(message_hash, 'big')*inverse_r) % N, G)
    key = affine(add_mixed((*a, 1) if a else (0, 1, 0), b))
    if key is None:
        return {'error': 'InvalidSignature'}
    return {'key': ''.join(v.to_bytes(32, 'big').hex() for v in key)}


def parse_der(raw):
    # Only exact canonical DER is converted to the wrapper's compact format.
    # Malformed-DER vectors do not describe compact-signature API behavior.
    if len(raw) < 8 or raw[0] != 0x30 or raw[1] != len(raw)-2:
        return None
    position, values = 2, []
    for _ in range(2):
        if position+2 > len(raw) or raw[position] != 2:
            return None
        size = raw[position+1]
        data = raw[position+2:position+2+size]
        if len(data) != size or not data or data[0] >= 128:
            return None
        if len(data) > 1 and data[0] == 0 and data[1] < 128:
            return None
        value = int.from_bytes(data, 'big')
        if value >= 1 << 256:
            return None
        values.append(value)
        position += size+2
    if position != len(raw):
        return None
    return b''.join(v.to_bytes(32, 'big') for v in values)


def fixtures(vector_path):
    raw = Path(vector_path).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == VECTOR_SHA256, 'public-vector SHA256 mismatch'
    vectors = json.loads(raw)
    assert vectors['numberOfTests'] == 476
    cases, excluded, public_expectations, high_s = [], [], 0, 0

    def add(name, message_hash, recovery_id, signature):
        expected = recover(message_hash, recovery_id, signature)
        cases.append({'id': name, 'hash': message_hash.hex(), 'recoveryId': recovery_id,
                      'signature': signature.hex(), 'expected': expected})
        return expected

    valid_example = None
    for group in vectors['testGroups']:
        public = group['publicKey']['uncompressed'][2:].lower()
        for test in group['tests']:
            compact = parse_der(bytes.fromhex(test['sig']))
            if compact is None:
                excluded.append({'tcId': test['tcId'], 'reason': 'not canonical compact-convertible DER'})
                continue
            message_hash = hashlib.sha256(bytes.fromhex(test['msg'])).digest()
            recovered = [add(f"wycheproof-{test['tcId']}-rid{rid}", message_hash, rid, compact)
                         for rid in range(4)]
            matching = [rid for rid, result in enumerate(recovered) if result.get('key') == public]
            if test['result'] == 'valid':
                assert matching, ('independent oracle disagrees with valid public vector', test['tcId'])
                public_expectations += 1
                if valid_example is None:
                    valid_example = message_hash, compact
                # Solana2.2.1 accepts both low/high S. Check the public malleation
                # and recovery-id parity together against the same supplied key.
                altered = compact[:32]+(N-int.from_bytes(compact[32:], 'big')).to_bytes(32, 'big')
                for rid in matching:
                    result = add(f"wycheproof-{test['tcId']}-opposite-s-rid{rid^1}", message_hash, rid^1, altered)
                    assert result == {'key': public}
                    high_s += int(int.from_bytes(altered[32:], 'big') > N//2)
            elif test['result'] == 'invalid':
                assert not matching, ('independent oracle disagrees with invalid public vector', test['tcId'])
                public_expectations += 1
    assert valid_example is not None and high_s > 0
    message_hash, signature = valid_example
    for rid in range(256):
        add(f'recovery-id-{rid}', message_hash, rid, signature)
    for size in [0, 1, 31, 33, 64, 65, 1024]:
        for rid in [0, 255]:
            add(f'hash-length-{size}-rid{rid}', bytes(size), rid, signature)
    for size in [0, 1, 32, 63, 65, 128, 1024]:
        for rid in [0, 255]:
            add(f'signature-length-{size}-rid{rid}', message_hash, rid, bytes(size))
    values = [0, 1, 2, N-1, N, N+1, (1 << 256)-1]
    for r in values:
        for s in values:
            signature = r.to_bytes(32, 'big')+s.to_bytes(32, 'big')
            for rid in range(4):
                add(f'scalar-boundary-{r:x}-{s:x}-rid{rid}', message_hash, rid, signature)
    for value in [0, N-1, N, N+1, (1 << 256)-1]:
        for rid in range(4):
            add(f'hash-reduction-{value:x}-rid{rid}', value.to_bytes(32, 'big'), rid, valid_example[1])
    summary = {'sourceCases': 476, 'excludedDerCases': len(excluded),
               'canonicalDerCases': (len([c for c in cases if c['id'].startswith('wycheproof-') and '-opposite-' not in c['id']]))//4,
               'independentPublicClassificationChecks': public_expectations,
               'explicitHighSMatches': high_s, 'totalRecoveryCases': len(cases)}
    return {'schemaVersion': 1, 'vectorSha256': VECTOR_SHA256, 'summary': summary,
            'excludedDerCaseDetails': excluded, 'cases': cases}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('public_vectors', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = fixtures(args.public_vectors)
    args.output.write_bytes((json.dumps(result, separators=(',', ':'))+'\n').encode())
    print(json.dumps(result['summary'], indent=2))
