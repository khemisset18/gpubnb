"""Bounded legacy transaction reader shared by DOGE recovery and signer policy.

Parsing does not verify signatures, chain state or authorization. Witness and
multiple inputs are deliberately outside the current recovery profile.
"""
import hashlib

MAX_MONEY = 10_000_000_000 * 100_000_000


def require(ok, message):
    if not ok:
        raise ValueError(message)


def txid(raw):
    require(type(raw) is bytes and 10 <= len(raw) <= 10000, 'bounded transaction required')
    return hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1].hex()


class Reader:
    def __init__(self, raw):
        require(type(raw) is bytes and 10 <= len(raw) <= 10000, 'bounded legacy transaction required')
        self.raw, self.offset = raw, 0

    def take(self, count):
        require(type(count) is int and 0 <= count <= 10000 and self.offset + count <= len(self.raw),
                'truncated transaction')
        value = self.raw[self.offset:self.offset + count]
        self.offset += count
        return value

    def integer(self, count):
        return int.from_bytes(self.take(count), 'little')

    def compact(self, maximum):
        tag = self.integer(1)
        if tag < 253:
            value = tag
        elif tag == 253:
            value = self.integer(2)
            require(value >= 253, 'noncanonical CompactSize')
        else:
            raise ValueError('CompactSize exceeds recovery profile')
        require(value <= maximum, 'transaction vector exceeds bound')
        return value


def parse_transaction(raw):
    cursor = Reader(raw)
    version = cursor.integer(4)
    require(version == 1, 'legacy version1 recovery profile required')
    require(cursor.compact(1) == 1, 'exactly one legacy input required; witness is unsupported')
    previous = cursor.take(32)[::-1].hex()
    index = cursor.integer(4)
    script = cursor.take(cursor.compact(1650))
    sequence = cursor.integer(4)
    count = cursor.compact(8)
    require(count >= 1, 'at least one output required')
    outputs, total = [], 0
    for _ in range(count):
        amount = cursor.integer(8)
        total += amount
        require(amount <= MAX_MONEY and total <= MAX_MONEY, 'amount exceeds recovery profile')
        output = cursor.take(cursor.compact(520))
        outputs.append({'valueKoinu': amount, 'scriptPubKey': output})
    lock = cursor.integer(4)
    require(cursor.offset == len(raw), 'trailing transaction bytes')
    return {'version': version, 'inputs': [{'txid': previous, 'vout': index,
            'scriptSig': script, 'sequence': sequence}], 'outputs': outputs, 'lockTime': lock}
