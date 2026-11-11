# LTC transparent V1 — preliminary threat model

Status: DRAFT / NOT INDEPENDENTLY REVIEWED. No executable settlement capability.

## Assets and boundaries
The protected assets are the user's signing authority, unsigned/signed canonical
terms, lock/refund scripts, recovery bundle, transparent LTC test value, and
integrity of Litecoin chain evidence. GPUbnb Core/Redis/Windows GPU rental
infrastructure and DOGE branches are out of scope and must be isolated.
Trust boundaries: operator -> downloaded Litecoin Core and GPG key; verifier ->
local inputs; user signer -> untrusted backend; independently operated Regtest
node(s) -> watchers; immutable recovery archive -> independent recovery operator.

## Adversarial assumptions and controls to qualify
1. Malicious build/archive/manifest/tag or publisher-key substitution:
   pinned hashes and GPG signature, full key fingerprint authenticated through
   independent trust channel, signed tag check, reproducible build and
   immutable evidence. A checksum from the same untrusted host is insufficient.
2. GPG status parser confusion: reject truncated, contradictory,
   expired/revoked and mismatched signer identifiers; no auto-key retrieval or
   personal keyring. The ephemeral fixture is *not* an official-key test.
3. Network/RPC redirection: default deny egress; Regtest identity verified
   against independently sourced genesis/magic; localhost-only authenticated
   RPC and dedicated disposable resources; fail closed on mismatch.
4. MWEB contamination: reject any MWEB input, output, change, peg,
   signer transformation, balance assumption, or recovery path before signing
   or broadcasting.
5. Funds trapped by timeout/fees/pinning: prove CLTV/CSV semantics natively,
   pre-validate independent recovery before lock, bounded fee-bump route,
   no unseen new signing authority on recovery.
6. Reorg, watcher disagreement, replay or stale RPC: fail-closed uncertainty,
   two node sources, transaction identity and conservative reorg downgrades.
7. Backend/user-wallet compromise: no seed/private key in server, artifacts,
   Git or logs; hardware signer only after WYSIWYS verification.
8. Cross-chain confusion: distinct protocol domain, Litecoin network identity
   and asset terms. LTC/BTC or LTC/DOGE pairs require separate two-leg review.

## Open high-impact threats
No official trust root or reproducible build has been established. No Litecoin
native Regtest network, scripts, fees, recovery, watcher or signer test exists.
Supply-chain findings in foundation CI remain open. Hardware wallet support,
formal state invariants and external independent audit are absent.

All actual financial activation remains forbidden until separately authorized.
