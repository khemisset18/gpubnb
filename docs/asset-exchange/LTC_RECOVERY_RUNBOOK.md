# Litecoin independent recovery — design/runbook (UNQUALIFIED)

This runbook is a safety checklist, **not an executable refund instruction**.
No lock/funding transaction exists. Recovery has not been validated on any
Regtest node, VM, or physical machine. Never use this document to protect
real funds.

## Mandatory before any future financing
- Freeze Litecoin-specific chain/genesis, canonical final terms, script bytes,
  exact output values, CLTV/sequence/locktime/sighash semantics and fee budget.
- Produce versioned `LTC-RECOVERY:v1` bundle with network ID, transaction
  identity, final terms, script, refund destination, timeout, fee policy,
  presigned refund material *if proven safe*, replacement metadata and tooling
  SHA. No raw seed, private key, wallet password, RPC cookie, or secret token.
- Independently verify archive readability, signatures, destinations, amount,
  provenance and privacy before **any** lock broadcast. Persist, reload and
  checksum the bundle from independent media.
- Prove that a different machine can perform recovery without the original
  backend, API, DB, web session or server; and without original keys only
  when the architecture of presigned refund supports that.
- Simulate and record crash before/after broadcast, ambiguous acknowledgement,
  duplicate exact rebroadcast, replacement, high fee/pinning, corrupt archive,
  destination/amount manipulation, wrong network, prior confirmation and reorg.
- Bound total fees by a preauthorized maximum and fail closed if a safe refund
  is infeasible. New signatures may NEVER be invented for unavailable keys.

## Evidence and distinction
Record separately: same-host restart, independent newly provisioned VM, and
genuinely independent physical host. VM proof never implies physical proof.
Save full txid/wtxid references on *private* Regtest, redacted RPC responses,
exact binary+source SHAs, signed recovery bundle digest and authorization.
Do not store sensitive wallet material in public GitHub Actions or CI artifacts.

L4/L5/L6 all remain NOT_TESTED until real authorized native Regtest evidence
proves recovery-before-lock and the adversarial matrix.
