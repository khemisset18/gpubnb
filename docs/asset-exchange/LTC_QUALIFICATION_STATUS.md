# Litecoin qualification status — transparent V1

Last reviewed: 2026-11-12. Profile: `LTC_BASECHAIN_TRANSPARENT_V1`.
Source of truth: `LITECOIN_ADAPTER_SPEC_V1.md`. Pull request: #359.
This document is an evidence ledger, not an activation signal.

| Gate | Status | Evidence and remaining blockers |
|---|---|---|
| L0: source/binary provenance | BLOCKED | Official archive/manifests/tag verified under publisher key; 26/26 prior offline tests. Historical Loshan key expired, but pinned public keyserver refresh matching the official fingerprint yields valid detached Gitian signatures for BOTH builders (run 43127645875). Keyserver delivery is not independent human identity authentication; no independent rebuild/toolchain audit or L0 approval. |
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

## Dual Gitian investigation — 2026-11-12
Two public Gitian Linux signed-assertion files have matching full output
manifests and pinned source SHA. They are NOT equivalent to independent
source builds. The `davidburkett38` signature has GOODSIG/VALIDSIG with
current release key, but `losh11` gives VALIDSIG **plus** KEYEXPIRED /
EXPKEYSIG with the archived key. The strict verifier rejects the pair.
Gitian run 43125463639 on SHA b485e5d = FAILURE (intentional trust
blocker); the offline verifier suite run 43125463716 = SUCCESS (26/26).
No settlement or native Litecoin code was executed. See evidence index.

## Loshan keyserver refresh observation — 2026-11-12
On code SHA `965afdd3f8977d2570bbdd569f2c13374e9b6ed0`,
the Gitian workflow 43127645875 **succeeded** after a public keyserver
refresh. The full fingerprint remains
`C0921846FED0BF4CF28BE1D73B2A6315CD51A673`.
Both detached signatures passed GPG, all nine claimed outputs match.
The downloaded certificate SHA-256 is `027f0165865fcbcc53e3d09ee80251cca7da7a29b198fb31ea5b2c357bbbc3bf`.
The historical archived-key expiry remains a valid reproducible
negative result; its correction **does not** itself prove the identity
of the signer. This result explicitly reports
`independentlyAuthenticatedBuilders=false`,
`independentSourceBuildReproduced=false`,
`l0Qualified=false`, `settlementEnabled=false`.
