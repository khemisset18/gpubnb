# Litecoin qualification status — transparent V1

Last reviewed: 2026-11-12. Profile: `LTC_BASECHAIN_TRANSPARENT_V1`.
Source of truth: `LITECOIN_ADAPTER_SPEC_V1.md`. Pull request: #359.
This document is an evidence ledger, not an activation signal.

| Gate | Status | Evidence and remaining blockers |
|---|---|---|
| L0: source/binary provenance | BLOCKED | 18/18 offline tests on 54be2a0 and d6e9edf; real official archive hash and signed SHA256SUMS.asc plus annotated source tag cryptographically verified using current release public key in networked CI 43123327322 on exact SHA d6e9edf. Independent out-of-band publisher identity attestation, independently reproduced build and reviewed dependency/toolchain proof still missing. |
| L1: Litecoin Regtest isolation | NOT_TESTED | No native node; no proved network/genesis identity or firewall evidence. |
| L2: strict MWEB exclusion | NOT_TESTED | Only non-executable transparent-only specification; no executable validation path. |
| L3: scripts and signature rules | NOT_TESTED | No Litecoin-native HTLC vectors or consensus/policy tests. |
| L4: lock/redeem/refund | NOT_TESTED | No test funds and no native transactions; recovery-before-lock unproven. |
| L5: fees/RBF/pinning | NOT_TESTED | Litecoin native mempool behavior untested. |
| L6: independent recovery | NOT_TESTED | No validated recovery bundle, machine or independent VM/physical demonstration. |
| L7: reorg/watchers | NOT_TESTED | No independent two-node evidence. |
| L8: external/hardware signers | NOT_TESTED | No real signer or hardware wallet qualification. |
| L9: final audit | BLOCKED | 40-case matrix, toolchain, SBOM, independent security review and operator sign-off absent. |

Non-negotiable runtime flags: `supportStatus=MARKETPLACE_ONLY`,
`automaticSettlementSupported=false`, `settlement route=null`.
No Mainnet, public broadcast, real funds, signing authority, merge, deployment or financial activation.

CI on historical HEAD e7e8c0d: LTC L0 run 43119399878 passed (11/11);
G5 run 43119399548 passed. General CI runs 43119395855 and 43119399483
failed strict vulnerability gates. None of those historical runs qualifies a later SHA.

## Source tag and release observations — 2026-11-12
The archived 3,159-byte upstream key expired in 2022 and triggered
KEYEXPIRED/EXPKEYSIG for the real signed 2026 tag. Using the different,
5,560-byte public key from the official release host (matching the same
publisher fingerprint), the actual source tag and checksums are
cryptographically valid. The Linux archive SHA-256 and size were matched
against independent hard-coded pins; the binary was NEVER executed.
Evidence is in run 43123327322 on exact code SHA
d6e9edf6824697674573a88b69da917bfaa82e78 and artifact 13900479732.
That is a *public publisher key* observation, not out-of-band
human authentication of the signing key or independent build reproduction.
L0 is BLOCKED; L1–L8 remain NOT_TESTED.
