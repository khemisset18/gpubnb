# DOGE external software signer — preparation, 22 November 2026

The owner asked to implement the missing work on 22 November, including the
previously absent signer adapter. This authorizes the additional software broker;
no Mainnet, real funds, user keys, activation, main/dev merge or financial
deployment is authorized. Independent external audit remains outside this mission.

## Implemented and locally checked

- Independently pinned external zipapp, explicit public-key pairing and strict
  request/response envelopes around the unchanged financial schemas.
- Private durable IN_FLIGHT/COMPLETE journal, strict request ID binding, no
  automatic resend after uncertain signing, identical cached public refunds.
- Fresh locally supplied heights before and after a new response; recovery of an
  already-accepted public response uses its stored acceptance, never a new signing
  authorization. A signing deadline does not expire the underlying signed refund.
- Manual CLI: pair, review, sign and recover; ordinary verified recovery bundles,
  no broadcast and no key argument in Core/backend.
-44 new software test methods PASS, zero failures/skips. Three acknowledged
  SIGKILL boundaries passed. The positive CLI height source is explicitly a
  software model; outside-private-namespace refusal is a real subprocess test.
-13 D8 controller preflights PASS without loading Dogecoin or generating a key.
  The native evidence checker also binds every negative to the exact+1 koinu
  post-signature mutation of its corresponding refund.

A schema defect in the new broker was reproduced before publication: Python
equality treated True and 1.0 as 1. Six failing subcases demonstrated dispatch/cache
normalization. Reusing the existing strict financial validator corrected it.
The original policy, serializer, financial program, recovery runtime, dependency
locks and scanner controls are unchanged.

The code targets POSIX and the local evidence is Linux. It is process separation,
not an OS/network sandbox. Normal timeout/error cleanup kills the created process
group. A hard SIGKILL of the broker during exchange does not guarantee child
cleanup; the durable intent still refuses automatic re-emission on restart.
No real device or physical screen is qualified by this implementation.

## New native check: not executed in this preparation snapshot

The new controller reuses the exact qualified D0 source archive and attestations.
Only its consensus library is extracted. Inside a distinct loopback-only private
namespace, after provenance/hash/ABI checks, two disposable fixture keys permit
one external software signer child to return three signatures. There are exactly
six C ABI checks: three valid refund inputs and three exact output mutations.
There is no node, RPC, block, transaction admission or broadcast.

The dedicated workflow is push-only on the existing PR376 branch, with read-only
permissions and pinned actions. It requires an explicit execution commit E whose
sole parent is reviewed harness H and whose full tree is identical to H. The
commit carries H and the exact private-test authorization. All executable changes
against 022a are limited to the new broker/controller; existing financial and
security controls cannot change through this scope check.

H/E and Actions IDs will be recorded from actual execution, not guessed here.
The native case will run once on the new code. Documentation-only updates do not
authorize rerunning it. No prior successful native DOGE scenario is selected.

## Hardware and upstream boundary

The official source review found no examined firmware proving the complete
DOGE Regtest legacy P2SH-HTLC/CLTV display profile. This is not a claim that a
device cannot produce any mathematically valid DOGE signature.

- Trezor 98deb5b04179079d8f2a6655410a124e5e95fbda exposes standard script
  templates and a Mainnet DOGE coin definition; EXTERNAL does not supply the
  missing HTLC signature.
- Ledger legacy 79f3036daec38347747fb498470bed3cfb103440 can accept a host
  redeemScript and its library 2664e6e10e2df7b8ec35aec87c30503f4661682b signs
  SIGHASH_ALL, but its DOGE prefixes and review UI do not establish our complete
  Regtest/contract/CLTV/sequence display requirements.
- Modern Ledger Bitcoin miniscript support does not imply DOGE legacy P2SH
  support. Jade/BitBox coin support examined does not declare this DOGE profile.
- No physical device/model/firmware/operator display evidence was provided.

Tauri 16170 remains open/draft at 899ca2105ffd06293013b6d2bff4416987d99010.
New WebKitGTK 3.0.0 and libappindicator 0.10.0 releases do not fit the existing
parents' version requirements. The already-qualified 15 official Git pins remain;
a partial forced upgrade would change compatibility without resolving D8.

D8 external software transport can receive its own bounded PASS after integrated
CI/native results. D2 final-profile freeze and complete hardware D8 remain
BLOCKED. External D9 audit is NON REALISE, outside the internal mission.

## Source references

- https://github.com/trezor/trezor-firmware/blob/98deb5b04179079d8f2a6655410a124e5e95fbda/common/defs/bitcoin/dogecoin.json
- https://github.com/trezor/trezor-firmware/blob/98deb5b04179079d8f2a6655410a124e5e95fbda/core/src/apps/bitcoin/sign_tx/bitcoin.py
- https://github.com/LedgerHQ/app-bitcoin-legacy/blob/79f3036daec38347747fb498470bed3cfb103440/Makefile
- https://github.com/LedgerHQ/lib-app-bitcoin/blob/2664e6e10e2df7b8ec35aec87c30503f4661682b/handler/hash_sign.c
- https://github.com/LedgerHQ/lib-app-bitcoin/blob/2664e6e10e2df7b8ec35aec87c30503f4661682b/ui/ui_nbgl.c
- https://github.com/LedgerHQ/app-bitcoin/blob/f010982d3050e02813cd7129bebd68cf2d1f2099/doc/wallet.md
- https://github.com/tauri-apps/tauri/pull/16170
- https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/Cargo.toml
- https://github.com/tauri-apps/wry/blob/wry-v0.57.3/Cargo.toml
