# Copyright (c) 2014 Daniel Kraft
# Copyright (c) 2015-2022 The Dogecoin Core developers
# Distributed under the MIT license; see ../d2/DOGECOIN_COPYING.
"""Bounded private-Regtest fixtures adapted from pinned Dogecoin QA helpers.

Serialization follows qa/rpc-tests/test_framework/scrypt_auxpow.py at
e0a1c157791544e818c901bd9341896965afbf9d. Seven mutations and a valid control follow
src/test/auxpow_tests.cpp and src/dogecoin.cpp. This builds test inputs,
not a consensus validator. Only the native node determines acceptance.
Python's standard scrypt replaces the old ltc_scrypt dependency; upstream
known-answer vectors and the native positive control check that boundary.
"""
import hashlib
import re

from script_diagnostics import require
from test_signer import hash256

TARGET = 0x7fffff << (8 * (0x20 - 3))
MAX_PROOFS = 8
MAX_PARENT_ATTEMPTS = 256
REASONS = {
    'parent-work': 'AUX proof of work failed',
    'parent-chain-id': 'Aux POW parent has our chain ID',
    'parent-merkle-root': 'Aux POW merkle root incorrect',
    'chain-root': 'Aux POW missing chain merkle root in parent coinbase',
    'chain-size': 'Aux POW merkle branch size does not match parent coinbase',
    'chain-index': 'Aux POW wrong index',
    'chain-branch-length': 'Aux POW chain merkle branch too long',
}


def scrypt_hash(header):
    require(type(header) is bytes and len(header) == 80, 'fixed parent header required')
    return hashlib.scrypt(header, salt=header, n=1024, r=1, p=1, dklen=32, maxmem=2**20)


def vectors(block_hash, target_hex):
    require(type(block_hash) is str and re.fullmatch('[0-9a-f]{64}', block_hash),
            'canonical private template hash required')
    require(target_hex == TARGET.to_bytes(32, 'little').hex(),
            'fixed minimal-difficulty Regtest target required')
    result = []
    for case in [*REASONS, 'valid-control']:
        root = bytearray.fromhex(block_hash)
        if case == 'chain-root':
            root[0] ^= 1
        script = b'\xfa\xbe\x6d\x6d' + bytes(root)
        script += (2 if case == 'chain-size' else 1).to_bytes(4, 'little') + bytes(4)
        # The upstream QA coinbase has one null prevout and no outputs.
        tx = bytes.fromhex('0100000001') + bytes(32) + b'\xff'*4
        tx += bytes([len(script)]) + script + b'\xff'*4 + bytes(5)
        merkle = bytearray(hash256(tx))
        if case == 'parent-merkle-root':
            merkle[0] ^= 1
        version = 1 | ((98 if case == 'parent-chain-id' else 0) << 16)
        prefix = version.to_bytes(4, 'little') + bytes(32) + bytes(merkle) + bytes(8)
        want_work = case != 'parent-work'
        for nonce in range(MAX_PARENT_ATTEMPTS):
            header = prefix + nonce.to_bytes(4, 'little')
            work = int.from_bytes(scrypt_hash(header), 'little')
            if (work <= TARGET) == want_work:
                break
        else:
            raise ValueError('bounded parent proof search exhausted')
        # Keep the unused MerkleTx block-hash convention of the upstream helper.
        proof = tx + hash256(header)[::-1] + bytes(5)
        branch = bytes(32 * 31) if case == 'chain-branch-length' else b''
        proof += bytes([len(branch)//32]) + branch
        proof += (1 if case == 'chain-index' else 0).to_bytes(4, 'little') + header
        require(len(proof) <= 4096, 'bounded AuxPoW fixture required')
        result.append({'case': case, 'hex': proof.hex(), 'sha256': hashlib.sha256(proof).hexdigest(),
                       'expectedAccepted': case == 'valid-control',
                       'expectedNativeReason': REASONS.get(case), 'parentAttempts': nonce+1})
    require(len(result) == MAX_PROOFS and len({v['hex'] for v in result}) == MAX_PROOFS,
            'eight distinct fixed AuxPoW fixtures required')
    return result
