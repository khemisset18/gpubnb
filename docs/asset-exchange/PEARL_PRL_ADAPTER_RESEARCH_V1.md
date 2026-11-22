# Pearl (PRL) — GPUbnb Exchange research and qualification V1

Status: **RESEARCH / MARKETPLACE_ONLY / RESTRICTED / NOT ACTIVATED**  
Date: 2026-11-22  
Scope: **Pearl native L1 PRL**, not another token with a similar ticker.

## 1. Existing GPUbnb placement

- **Mining selector**: `apps/host-desktop/src/main.ts` contains `{ symbol: 'PRL', name: 'Pearl' }` in `MINING_CATALOG`. It has neither `profileId` nor `hardwareValidated`, and does NOT attest that an actual miner can start and earn PRL.
- **Asset Exchange research registry**: `docs/asset-exchange/ASSET_ACTIVATION_MATRIX_V1.md` describes `pearl-mainnet-native` as `MARKETPLACE_ONLY`, `RESTRICTED`, `identity not ready`. This is a policy entry, not evidence that end users can already publish live offers.
- No runtime API/offer form or settlement capability is enabled by this branch. A later reviewed, separate **marketplace-only** change would be required to connect PRL discovery/offers without a financial route.

The user corrected an initial typo: **PRL**, not MTN. MTN is neither a native ticker nor an allowed alias in this profile; ticker-only matching is insufficient for any future activation.

## 2. Official upstream, snapshot and identity

- Project: Pearl Research Labs — https://pearlresearch.ai
- Source: https://github.com/pearl-research-labs/pearl
- **Reviewed source snapshot**: `29c2b03009143c98f4519271d716bd5535762a18` (public Git commit fetched for static reading). This is **not a signed release/binary provenance attestation**.
- Reference implementation `node/` includes `pearld`, `wallet/` includes Oyster, `miner/` contains GPU mining components. These programs have **not been executed**.
- Pearl is a standalone **UTXO L1 with Proof-of-Useful-Work (PoUW)** and native asset **PRL**; its smallest unit is **grain = 10^-8 PRL**, per official project docs. It is NOT an EVM token and NOT a Litecoin/DOGE-style script-compatibility shortcut.
- Official Pearl emphasizes **Taproot-only** output/address profile. Native v1 P2TR candidates and future v2 P2MR must be scoped separately. **Do not copy Litecoin SegWit v0 P2WSH HTLC assumptions.**

Official static source:
- `node/chaincfg/params.go` at the pinned snapshot:
  - mainnet HRP `prl`, P2P default port `44108`;
  - testnet HRP `tprl`, default port `44110`;
  - regtest HRP `rprl`, default port `18444`, no DNS seeds;
  - simnet also uses `rprl`.
- `node/wire/protocol.go`: `MainNet = 0x50524C4D`, `RegTest = 0x50524C52`.
- `node/btcutil/address_test.go`: Taproot mainnet `prl1p...`, testnet `tprl1p...`, and rejected legacy SegWit v0 vectors; network tests explicitly note **regtest/simnet share `rprl`**, and testnet/testnet2/signet share `tprl`.
- `node/btcutil/address.go`: `AddressMerkleRoot` uses witness version 2. This research guard rejects v2 rather than silently treating it as P2TR.
- Genesis hashes and official distribution signing/provenance remain to be pinned and independently checked. Do not claim P0 or P1 fully validated from textual constants alone.

## 3. Safety and scope

Absolute restrictions on this project:
- no real coins, payments, wallets, secrets, private keys, seeds, signing (even synthetic/ephemeral), proof of ownership, live offers, mining sessions, nodes, Docker, RPC or blockchain broadcasts;
- no changes to DOGE/LTC branches or non-PRL runtime components;
- any permitted HTTPS reads are for public source/documentation only; **test execution must be offline**;
- no real transaction construction, lock, claim, refund or chain watcher;
- activation registry, signer and settlement routes stay unchanged.

The permitted outcome is a **synthetic marketplace preflight** and a **public address-encoding classifier**, with all financial flags false. For example, the `PRL/DOGE` fictional offer fixture is NOT a quote, a market price, a posted offer or a claim that either asset is settlement-qualified.

## 4. Candidate profile and gate matrix

Provisional identity domain: `GPUbnb:PRL:OFFLINE_MARKETPLACE_REVIEW:v1`.  
Candidate research profile: `PRL_MARKETPLACE_RESEARCH_V1`, **not** an approved settlement protocol.

| Gate | Scope | Current evidence | Status |
| --- | --- | --- | --- |
| P0 | Toolchain provenance | Upstream repository and one git source snapshot identified; no signed binary/signature attestation | PARTIAL / BLOCKED |
| P1 | Chain/network identity | PRL chaincfg and wire magic examined; `rprl` shared by regtest/simnet, no running node verified | STATIC ONLY / BLOCKED |
| P2 | Address and script family | Bech32m public v1 32-byte shape test; mainnet/testnet/v0/v2 rejected; no native consensus check | OFFLINE SHAPE ONLY |
| P3 | Real signing/script semantics | Schnorr/Taproot and potential P2MR are distinct from BTC, DOGE and LTC; no scripts executed | BLOCKED |
| P4 | Lock/claim/refund | No approved PRL escrow script, spending semantics or transaction bytes | BLOCKED |
| P5 | Fees/replacement/dust | No executable PRL policy qualification | BLOCKED |
| P6 | Independent recovery | No recovery bundle or independent native refund | BLOCKED |
| P7 | Reorg/watchers | No independent authenticated Pearl observers | BLOCKED |
| P8 | External/hardware signer | No signatures attempted or hardware qualified | DEFERRED |
| P9 | Security audit and activation | No third-party review, registry promotion or public-trading implementation | DEFERRED / BLOCKED |

## 5. Offline research artifact

Path: `asset-exchange/qualification/pearl/`

- `address_guard.py`: strictly lowercase Bech32m witness v1 32-byte `rprl` encoding shape only. It intentionally returns `possibleNetworks=["regtest", "simnet"]` and `networkIdentityVerified=false`. It does **not** prove spendability or that a key/script is safe.
- `offline_preflight.py`: strict synthetic PRL offer JSON domain and schema validator; refusals for MTN/WPRL ambiguity, foreign networks, duplicate/extra fields, badly typed public amounts and all permissions to post, fund, sign, broadcast or settle.
- `fixtures/public_prl_offer_v1.json`: fictitious 1 PRL / 2.5 DOGE public fixture, not a price quote or actual order.
- Two adversarial test suites. **47 methods PASS locally in the assistant build sandbox**; the same code must be rechecked in the operator's Ubuntu WSL2 worktree. No claim of mining hardware, node, native Taproot, exchange API or production qualification follows.

The current experimental code does **not** even post a marketplace-only offer. A separate implementation would need verified canonical PRL native asset identity and explicit user-facing unsupported-settlement warnings, independent review of API constraints and all economic/legal checks before any production release.

## 6. Next actions

1. Reproduce the tests inside the separate offline WSL2 Pearl worktree; record exact commit/output.
2. Pin signed or otherwise independently authenticated upstream release/toolchain and exact genesis/network semantics.
3. Review actual GPUbnb public listing API and its capabilities before implementing **only a non-settling Pearl marketplace listing path** on a separate reviewed PR.
4. Perform meaningful offline checks of additional PRL-specific script/recovery/threat-model details, preserving fail-closed limits.
5. Native consensus, mining/hardware, wallet, signer and production activation remain **outside current scope** and **blocked**.

**Final invariant: PRL MARKETPLACE_ONLY / RESTRICTED; automaticSettlementSupported=false; no real-funds route.**

## 7. Verified Exchange offer-publishing integration gap

The current Pearl experiment branch includes these explicit
repository declarations, read without execution:

- `asset-exchange/api/README.md` calls the Exchange API a
  **"G5 non-financial shell"** and states **"no business routes"**
  and **"No offer/trade/settlement/admin endpoint is enabled in
  this slice."** Offer, accept, cancel and authentication endpoints
  are listed only under *future responsibilities*.
- `asset-exchange/web/README.md` describes a **"G5 skeleton
  only"** and says no user-facing settlement flow is implemented.
- `asset-exchange/README.md` describes API and web as
  future modules and forbids Core credential / database reuse.
- The Pearl matrix lists `pearl-mainnet-native` for discovery/offers
  in `MARKETPLACE_ONLY` status, but the matrix **does not create
  executable listing routes**.

**Implication:** seeing PRL in mining and in the Exchange asset
matrix is NOT evidence that someone can post an actual PRL exchange
offer today. The lab's `canPostOffer=false` flag is intentional.

The next **separately reviewed** scope should first establish
an Exchange-only authentication and authorization model, explicit
native PRL identity (not ticker-only), immutable public listing
terms, canonical integer amounts after upstream unit confirmation,
explicit unsupported-settlement warnings, cancellation/idempotence,
rate limits, safe persistence without Core credentials, API and UI
negative tests, and a no-funds mock path. Only then should a
marketplace-only public listing flow be considered. This PR does
not implement those routes, and it MUST NOT enable offer posting
by changing the lab fixture's `canPostOffer` permission.

**Identity gate:** the `rprl` prefix's shared use by Pearl
regtest and simnet rules out network verification from address
text alone. No public offer path should treat that HRP as
proof of actual chain identity or payment readiness.
