# DOGE external-signing and pre-signed refund policy

Regtest-only reusable policy code; financial activation remains blocked. This is a local library, not an HTTP Wallet Agent service or a hardware-wallet integration.

`refund_ladder.py` reuses the existing strict HTLC profile, legacy serializer, SIGHASH_ALL construction and DER checks. The recovery transaction reader is shared with `asset-exchange/recovery/dogecoin/transaction.py`. OpenSSL verifies public-key signatures; this component never creates a key or signs anything.

## Recovery API

- `validate_signed_refund(entry, *, contract, funding, policy)` validates exact serialized bytes, digest/txid, funding output identity/value/script, one refund output, canonical branch, fixed sequence, lock and strict low-S SIGHASH_ALL signature.
- `validate_refund_ladder(entries, *, contract, funding, policy)` accepts 1–8 independently verified refunds for the same funding output, contract, destination, lock and sequence, with strictly increasing absolute fees.
- `select_presigned_refund(entries, required_fee_koinu, *, contract, funding, policy)` returns the least expensive already-signed entry that covers an independently observed absolute fee requirement. It raises `FeeCoverageError` beyond the last approved step; it cannot sign a new transaction.

Contract fields: `redeemHex`, `outputHex`. Funding fields: `txid`, `vout`, `valueKoinu`, `transactionHex`. Policy fields: `maxFeeKoinu`, `minRefundKoinu`. Each entry contains `transactionHex`, `sha256`, `txid`, `destinationHex`, `outputValueKoinu`, `feeKoinu`, `lockTime`, `sequence`. Koinu values use canonical decimal strings. The minimum retained refund must be at least the pinned default soft-dust threshold, 1,000,000 koinu.

The actual UTXO must be checked against independently observed chain state by the recovery caller. A serialized funding transaction is not proof of confirmation or availability. The caller must check every known ladder txid before choosing a different variant. If a variant is already in the mempool, retry that exact variant or remain pending.

The current sequence `0xfffffffe` does not opt into RBF. This ladder does **not** authorize replacement of a pending nonreplaceable transaction. It supplies alternatives when lower-fee variants are absent, rejected or evicted. If all signed variants fall below the required fee, recovery remains blocked without an available authorized signer. A changed legacy funding txid invalidates the old ladder; the mismatch is rejected rather than silently rebinding signatures. No finite ladder guarantees recovery under arbitrary fee increases.

## External software-signer boundary

`create_refund_signing_request(...)` creates a public request bound to the pinned Regtest genesis and source, exact serialized funding output, contract, destination, fee ladder and budget. Every step includes exact unsigned transaction bytes and its legacy SIGHASH_ALL digest. No seed/private-key field is accepted.

`signer_review_fields(...)` returns the exact network, funding outpoint, input/refund/fee amounts in DOGE, destination script, refund public key, lock, sequence and signing deadline for display. The caller must actually display those fields and obtain/retain the trusted terms and request digests. A self-supplied request digest is not user authorization. The destination is the exact script, not an untested hardware-device address display.

`validate_refund_signing_request(...)` and `finalize_refund_signing_response(...)` require the separately trusted digests and a fresh explicit height. Responses are confined to the agreed request ID/digest, expected refund public key and one signature for each step. Every constructed raw refund is independently parsed and publicly verified. An absent/disconnected signer fails explicitly with no fallback key or hidden signing operation.

The signing request deadline restricts acceptance of a new signature response. It does not expire valid pre-signed refunds: CLTV supplies a lower bound, not an upper expiry.

## Packaging and validation

The standalone recovery package may include `refund_ladder.py`, `transaction.py`, `htlc_codec.py`, `offline_candidate.py`, `spend_preparation.py`, and `test_signer.py` at the zipapp root. Module origins must match the package. Repository development uses deterministic relative helper paths; no backend module or caller-selected import path is needed.

Run `python3 -m unittest discover -s asset-exchange/wallet-agent/dogecoin -p 'test_*.py' -v`. Twelve tests pass, including ephemeral test-key signing with the existing signer, independent public OpenSSL verification, altered fields/funding txid/fee/destination rejection, high-S/DER/wrong-key controls, increasing fee bounds, disconnected signer, request expiry, exact review fields, and execution of a minimal isolated zipapp with an empty working directory.

These are software/cryptographic tests, not native DOGE admission, propagation, RBF or hardware tests. The parent private laboratory must execute those scenarios separately before qualification. Physical hardware and a network-facing pairing/origin transport remain NOT_TESTED / NOT_IMPLEMENTED.

## Source comparison

Reviewed DCRDEX `fc63460615e8dca83fc19520f32a1cb00be4acfa`, `client/asset/btc/btc.go`, `Refund`/`refundTx`: check the real unspent contract, calculate net refund/fee, reject dust, and cache exact signed bytes before broadcast. This implementation uses its own code and existing GPUbnb codecs, without copying DCRDEX code (Blue Oak 1.0.0).

Reviewed pinned Dogecoin `e0a1c157791544e818c901bd9341896965afbf9d`, `src/validation.cpp` replacement checks and `qa/rpc-tests/replace-by-fee.py`. Those rules are why the existing non-RBF profile is preserved and pending-transaction replacement is not inferred from fee ordering.
