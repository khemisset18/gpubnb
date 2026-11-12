# Litecoin final independent audit — OPEN / BLOCKED

Review date: 2026-11-12. Scope: LTC_BASECHAIN_TRANSPARENT_V1.
This is a *placeholder audit register*, not a completed audit or approval.

## Decision
- L0: BLOCKED — official archive hash, signed checksum manifest
  and source tag pass cryptographic checks with the published release key.
  Both Gitian detached signatures now pass with a current, SHA-pinned
  public Loshan certificate distributed by keys.openpgp.org, and all
  nine declared outputs match (run 43127645875). The official archived
  Loshan key remains expired; this renewed certificate is NOT
  independently authenticated to the human builder. Independent
  source-build reproduction, toolchain/SBOM review and sign-off missing.
- L1–L8: NOT_TESTED — no authorized Litecoin-native chain/test transactions,
  independently recoverable funds, two-node reorg or real wallet/hardware signer.
- L9: BLOCKED — 40 cases in section 19 of `LITECOIN_ADAPTER_SPEC_V1.md`
  not executed; no external security auditor or formal state review.
- Foundation security gate: FAILED on historical baseline; see
  `LTC_EVIDENCE_INDEX.md` for exact affected packages/advisories.

## Audit acceptance conditions
Require an exact-HEAD release evidence package, signer trust verification,
reproducible build/attestation outcome, SBOM, dependency-risk decisions,
threat model, all 40 positive/negative native and fuzz/property tests,
timelocks and mempool fees/pinning, durable recovery before lock and proof on
independent infrastructure, reorg/watchers conflict analysis, true signer
WYSIWYS evidence, independent audit, operator rollback and residual risk
register. Each result must identify its binary and code SHA.

Multi-chain LTC/BTC and LTC/DOGE pairs need a separate two-leg audit, even if
an individual Litecoin native node eventually passes. A passing audit does
not activate settlement. Activation requires a separately reviewed,
explicitly authorized change.

Remaining official fingerprint, archive, source tag and test infrastructure:
UNKNOWN / NOT PROVEN. No financial service production authorization exists.
