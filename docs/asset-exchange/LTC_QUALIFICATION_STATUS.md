# Litecoin qualification status — transparent V1

Last reviewed: 2026-11-12. Profile: `LTC_BASECHAIN_TRANSPARENT_V1`.
Source of truth: `LITECOIN_ADAPTER_SPEC_V1.md`. Pull request: #359.
This document is an evidence ledger, not an activation signal.

| Gate | Status | Evidence and remaining blockers |
|---|---|---|
| L0: source/binary provenance | BLOCKED | Offline GPG parser guard tests, original 11/11 on e7e8c0d; release metadata pins, but official tag signature, independently authenticated publisher key, downloaded archive and reproducible build not verified. Updated tests require a new exact-SHA CI result. |
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
