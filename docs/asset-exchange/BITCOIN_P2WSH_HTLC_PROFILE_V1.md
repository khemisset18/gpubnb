# Bitcoin P2WSH HTLC Profile V1 — Byte-Level Specification

Status: G6 DRAFT / REGTEST ONLY / NO REAL FUNDS / NOT PRODUCTION AUTHORIZED

Protocol ID: `GPUBNB-ASSET-EXCHANGE-BTC-P2WSH-HTLC-V1`

This profile defines the first exact Bitcoin settlement script candidate for gpu.k.p2p Asset Exchange.

It is intentionally narrow:
- Bitcoin only;
- SegWit v0 native P2WSH;
- one principal output;
- SHA-256 32-byte secret;
- absolute block-height refund using CHECKLOCKTIMEVERIFY;
- compressed secp256k1 public keys only;
- SIGHASH_ALL only;
- whole fill only;
- regtest only until every G6 acceptance condition is green.

It does not authorize Mainnet.

## 1. Design goals

The script must provide exactly two spend paths:

1. REDEEM:
   - requires a 32-byte preimage whose SHA256 equals the committed hash;
   - requires the redeem party signature.

2. REFUND:
   - impossible before the committed absolute block height;
   - requires the refund party signature;
   - does not require cooperation from gpu.k.p2p or the counterparty.

The server never receives either wallet private key.

## 2. Witness script

ASM:

```
OP_IF
  OP_SHA256
  <32-byte secret_hash>
  OP_EQUALVERIFY
  <33-byte redeem_pubkey>
  OP_CHECKSIG
OP_ELSE
  <refund_lock_height>
  OP_CHECKLOCKTIMEVERIFY
  OP_DROP
  <33-byte refund_pubkey>
  OP_CHECKSIG
OP_ENDIF
```

The script MUST NOT contain:
- OP_CODESEPARATOR;
- non-minimal pushes;
- x-only/Taproot keys;
- uncompressed public keys;
- additional spending branches;
- operator/platform keys;
- fee recipient keys.

## 3. Exact serialization

Fixed opcodes:

- OP_IF = `0x63`
- OP_SHA256 = `0xa8`
- OP_EQUALVERIFY = `0x88`
- OP_CHECKSIG = `0xac`
- OP_ELSE = `0x67`
- OP_CHECKLOCKTIMEVERIFY = `0xb1`
- OP_DROP = `0x75`
- OP_ENDIF = `0x68`

Fixed pushes:

- secret hash: `0x20 || secret_hash[32]`
- compressed public key: `0x21 || pubkey[33]`

Refund height is serialized as a minimally-encoded positive Bitcoin Script number and then pushed using the minimal push opcode.

No negative or time-based lock values are accepted in V1.

## 4. P2WSH output

`witness_script_hash = SHA256(witness_script)`

scriptPubKey:

```
0x00 0x20 <witness_script_hash[32]>
```

No P2SH wrapping is allowed in V1.

## 5. Redeem witness

Witness stack, bottom to top:

1. DER ECDSA signature + sighash byte `0x01` (SIGHASH_ALL);
2. exactly 32-byte secret preimage;
3. true selector `0x01`;
4. exact witness script.

Conceptually:

```
<redeem_signature_all>
<secret_32>
<01>
<witness_script>
```

The implementation MUST reject:
- secret length != 32;
- wrong hash;
- wrong signing key;
- sighash other than SIGHASH_ALL;
- mutated witness script.

## 6. Refund witness

Witness stack:

1. DER ECDSA signature + sighash byte `0x01`;
2. empty vector as false selector;
3. exact witness script.

```
<refund_signature_all>
<>
<witness_script>
```

The refund transaction MUST use:
- `nVersion = 2`;
- `nLockTime = refund_lock_height`;
- HTLC input `nSequence = 0xfffffffd`.

Rationale:
- sequence is non-final, so CLTV is active;
- value `0xfffffffd` is compatible with nLockTime and signals replaceability for fee management.

The implementation MUST NOT use `0xffffffff` on the HTLC refund input because BIP65 would make CLTV fail.

## 7. Height semantics

V1 uses block-height CLTV only.

Therefore:
- `refund_lock_height < 500000000`;
- refund transaction nLockTime MUST also be height-based;
- `nLockTime >= refund_lock_height`;
- the V1 canonical builder sets `nLockTime == refund_lock_height`.

Production timeout selection is NOT specified here.

Regtest vectors may use deterministic heights for testing only. They MUST NOT be copied into Mainnet policy.

## 8. Funding output validation

Before signing/broadcasting a funding transaction, the signer MUST independently verify:

- network is expected;
- principal amount exactly matches signed terms;
- scriptPubKey exactly matches reviewed P2WSH output;
- witness script hash matches signed terms;
- no unknown principal destination;
- fee inside configured limits;
- every input prevout and amount is known;
- change belongs to signer;
- transaction version/locktime/sequence are expected;
- no unexpected OP_RETURN or additional fee output.

The frontend/server representation is never signing authority.

## 9. PSBT rules

PSBT may transport unsigned transactions and signing metadata.

For V1:
- declared sighash MUST be SIGHASH_ALL;
- witness UTXO information MUST match chain data;
- witness script MUST exactly equal the signed protocol script;
- signer MUST reject unknown proprietary fields that affect intent;
- signer MUST independently inspect every output;
- finalization MUST fail for a signature with a mismatched sighash.

The server may relay a PSBT but MUST NOT possess the private key required to sign it.

## 10. Secret handling

Secret `S`:
- exactly 32 cryptographically-random bytes;
- generated user-side;
- `H = SHA256(S)`;
- server may know H;
- server MUST NOT be the sole custodian of S;
- S MUST NOT be released merely because a database state says "ready".

Secret extraction for the opposite-chain action is valid only when obtained from a validated expected-chain spend.

## 11. Refund-before-funding invariant

Before the first funding broadcast, the party at risk MUST have:

- exact witness script;
- funding output commitment;
- refund construction recipe or prepared refund artifact;
- signing path available;
- encrypted recovery bundle exported and validated.

If safe refund construction depends on a stable funding txid, the funding construction MUST use SegWit inputs or another reviewed anti-malleability condition.

No lock broadcast until recovery readiness is proven.

## 12. Fee bump policy

V1 refund uses `nSequence = 0xfffffffd` so fee replacement can be tested.

This does not prove every replacement will relay.

Bitcoin Core 31.1 replacement policy requires sufficient additional absolute fee and feerate improvement; package/cluster policy can also reject transactions.

Therefore:
- refund reliability MUST be tested against current pinned node policy;
- fee reserve and bump algorithm remain a separate G6 deliverable;
- no production claim of guaranteed refund relay is allowed yet.

## 13. Reorg behavior

A redeem/refund confirmation is reversible evidence until confirmation policy is met.

If a confirmed spend is reorged:
- state MUST leave any final/progress state that depended on that confirmation;
- watcher evidence becomes UNCERTAIN until reconciled;
- duplicate economic action MUST NOT be created;
- recovery remains available where protocol rules allow.

## 14. Canonical signed terms additions

Bitcoin settlement terms MUST bind at least:

- protocol id/version;
- Bitcoin network;
- witness script hash;
- secret hash H;
- redeem pubkey;
- refund pubkey;
- refund lock height;
- confirmation policy;
- funding amount in satoshis;
- allowed sighash;
- fee policy version;
- deployment id;
- trade id.

Changing any field requires a new signed settlement agreement.

## 15. Explicit exclusions

Not in V1:
- Taproot;
- MuSig;
- adaptor signatures;
- ANYONECANPAY;
- SIGHASH_SINGLE/NONE;
- P2SH wrapping;
- relative CSV timeout;
- partial fills;
- operator recovery key;
- server signing;
- arbitrary script extensions.

## 16. Stop-ship conditions

STOP-SHIP if:
- early refund succeeds;
- wrong secret succeeds;
- wrong key succeeds;
- non-SIGHASH_ALL signature succeeds through our signer policy;
- mutated output/script is signed;
- refund requires gpu.k.p2p server availability;
- private key reaches server;
- reorg produces duplicate economic action;
- fee-bump path is not available under the documented assumptions;
- recovery bundle cannot reconstruct/execute refund independently.

This specification remains REGTEST ONLY until audited against the G6 acceptance contract.
