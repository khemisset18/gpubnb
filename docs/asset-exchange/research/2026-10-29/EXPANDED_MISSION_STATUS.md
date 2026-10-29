# Extended authorization — factual development and qualification checkpoint

29 October 2026, Europe/Paris. This supersedes only the scope/status portions
of the earlier MISSION_STATUS; its historical results remain preserved.
Owner explicitly authorized desktop corrections, isolated Rust migrations,
offline exchange modules and the exact D2 diagnostic/mining scope. No merge,
main change, deployment, Mainnet, real funds, user wallet, hardware signer,
automatic settlement or D0 trust-policy change is made.

## Branches, commits and review boundaries

| Draft PR | Branch | Published changes / exact commits |
| --- | --- | --- |
| #313 | asset-exchange/security-gates-d1-prep-20261029 | Desktop/security c8bdef493c140097c1cc198aa6ec67bdb58ca4d5; follow-up e63daab407b08c89565e48567d244fdcfc0a50b8; offline modules b168d142cfe1a20d91c70e380e149f2dfda48a82; subsequent tested fixture/evidence corrections remain in this PR |
| #314 | asset-exchange/doge-d2-isolated-20261029 | Reviewed preparation acfe2123a8825c7d3595ef70944dccf7ca3cf074; actual execution78fa2d1aa889853c8de428004d337bad0b21ddc8; original proof/dispatch-only restoration e25b8b0cbb7967b379f4f74b6125614986024448 |
| #315 | asset-exchange/rust-security-prototypes-20261029 | Isolated Rust prototype c527474b39ea58a9259d4328515c969a8af08814; neither financial migration nor native backport is integrated into #313 |

#312 remains unchanged at1e3006286a904c249e8914a28699e59cf3247a8c. D0 source,
workflow, official hashes/manifests/snapshot and trust policy are untouched.
D0 and D1 retain their original PASS evidence; precompiled-upstream GPG provenance
remains a different blocked route. D0/D1 were not rebuilt/re-executed here.

## PASS — actually executed software/security results

- The actual desktop package/lock use Vite7.3.7 (was7.3.6) and
  source-map-js1.2.2 (was1.2.1), preserving unrelated optional-platform metadata.
- Node22 actual npm ci, all-severity audit zero, strict TypeScript and frontend
  production/debug builds pass. Eleven targeted Linux security/compatibility
  tests pass; the Windows suite has ten applicable cases because the upstream
  filesystem-shadow vulnerability is POSIX-only. No test is marked skip.
- The old source-map diagnostic is repaired, not erased: exact old column-zero
  and flattening expectations now PASS. A version/preimage/original/output-SHA
  checked deterministic patch corrects old indexed-map defects;145/145 unchanged
  upstream Node tests pass. Unknown installed bytes fail. BSD3 retained.
- CI40959885917 atc8bdef4: actual Linux desktop install/audit/build/native host
  job PASS; API/Agent/Contract/root+API audits/production guards PASS. Original
  reportZIP12935187185 independently downloaded and verified; **six desktop
  vulnerabilities absent, exactly three Rust findings remain**.
- Offline exchange suite: **193 PASS,0 FAIL,0 skip** after additions/review.
  Four new data/terms/evidence/journal modules; twenty directions bound to five
  explicitly synthetic profiles. DOGE–XMR cannot be promoted to a reviewed route.
- Real child-process journal contention/restart, byte mutation, torn tail,
  rollback checkpoint, hidden/symbol/accessor arrays, stale/minority-conflicting
  reports and idempotence cases pass. No chain effect exists in these modules.
- Syntax checking now checks each of47 source files independently. The old
  multi-filename node--check invocation checked only its first script.

Files and raw/local evidence:
[desktop audit](../../audits/DESKTOP_SECURITY_APPLIED_2026-10-29.md),
[offline implementation](OFFLINE_RECOVERY_IMPLEMENTATION.md),
`apps/host-desktop/test/`, `apps/host-desktop/tools/`,
`asset-exchange/research/src/offline-*.mjs`, `research/test/offline-*.test.mjs`
and `asset-exchange/tools/check-syntax.mjs`.

## FAIL — preserved CI observations and repairs being validated

Windows40959885741 correctly failed because a Windows8.3 temp alias rejected
the permitted positive HTTP control. Canonicalization restored that control in
40961130964, which then correctly failed the negative control: Vite's raw-fs
middleware strips drive letters; OS temp onC: versus checkoutD: exercised a
nonexistentD: file (404), not the required existing denied file (403).
Fixtures now stay on the serving process drive. RequiredHTTP200/403 and
sentinel-absence assertions remain strict. Both failed logs are preserved.
Windows frontend/native/installer validation must actually complete on this
repair; local Linux success cannot substitute for it.

P2P correctly rejected one redundant final LF in each of two new diagnostic
logs. The original bytes are preserved losslessly with c8bdef4-derived hashes,
with a regression verifying exact gzip recovery and one-byte-only normalized
views. No security threshold or evidence meaning is changed.

The PR description records subsequent actual CI IDs/results against their exact
heads. A pending run is NOT TESTED, never PASS; an earlier successful suite is
never represented as a successful global Trivy gate.

## PASS diagnostics / BLOCKED full DOGE D2

Actual run40961370001 and its exact seven-method manifest were independently
reviewed. All23 native C-ABI vectors and five Solver classifications matched;
exactly1350+1+1 synthetic blocks measured BIP65 false at1350, true1351/1352.
Exact officialD0 archive and signed library/provenance revalidated, exact genesis
and version, walletdisabled, zeropeers/connections, UPloopbackonly before/after,
fixed public burn destination, clear environment and bounded resources; clean
stop exit0. No wallet, signing, transaction broadcast or D3–D9 operation.

The workflow conclusion is **FAIL** at its final full-D2 gate. Standardness of a
complete transaction/mempool admission and positive signature-bound HTLC
claim/refund remain unproven. Solver is not that proof. The original nine-file
ZIP12935542062 SHA256
8f700c1eaccabf13df6873a4ec1a65931779b0bc231007e3b489615e3d18ebef
is preserved in #314 with a readable report and16 offline checks. The temporary
execution trigger is removed. No script/profile or capability is qualified.
See [PR314](https://github.com/khemisset18/gpubnb/pull/314).

## PASS host/native prototypes / NOT TESTED financial migration

#315 keeps Anchor0.31.1→1.2.2 isolated. The financial source file is byte-identical.
Normal Cargo resolution removes borsh0.10, rand0.7 and libsecp256k1 from the
candidate active lock; borsh1.8.0 is selected. Both versions match30 independent
ABI/account/instruction/event fixtures. Historical host tests baseline7/candidate6
(the upstream generated ID test disappeared) plus three new regressions each,
including explicit programID, pass. Each standalone crypto version matches all
476 hash-pinned public Wycheproof verification vectors; no signing/RNG.

Raw IDL output **differs**; the exact historical double-JSON address encoding is
asserted and decoded once for semantic comparison. That is not raw equivalence.
An additional SBF tooling/preflight worker was interrupted by an automated
content safety block reporting possible cybersecurity risk. No SBF contract
build outcome or runtime compatibility is claimed; the other already authorized
work continues without bypassing that block.

SBF/runtime/CPI/account-safety/client/signature integration cannot be inferred
from host fixtures and remains separately recorded as NOT TESTED until measured.
No production-compatible migration is proposed merely because the host builds.

GLib's exact official two-line fix is tested against nativeGLib2.80.0: optimized
baseline SIGSEGV(-11) preserved; candidate3072 iterator comparisons PASS and
wrong-type rejected. Four synthetic GTK3/GObject component checks pass. Actual
source/runtime hashes, license, complete original logs gzip and reproducible
scripts retained. Full GTK/WebKit/Tauri event loop/packaging is NOT TESTED.
The backport remains0.18.5, is not wired to active dependencies and has no
version spoof or scanner exception. See[PR315](https://github.com/khemisset18/gpubnb/pull/315).

## BLOCKED — actual remaining vulnerabilities and compatibility

On the active #313 graph, the real all-severity/dev/unfixed-inclusive report has:

| Dependency | Finding | Severity | Reason it remains blocking |
| --- | --- | --- | --- |
| borsh0.10.4 | GHSA-fjx5-qpf4-xjf2 | MEDIUM | Anchor/Solana migration is isolated; host byte fixtures do not prove generated dispatcher/runtime compatibility |
| glib0.18.5 | GHSA-wrw7-89jp-8q8g | MEDIUM | Compatible0.18 fixed release absent; two-line native backport does not make the selected published version scanner-clean |
| rand0.7.3 | GHSA-cq8v-f236-94qc | LOW | Old Solana/libsecp parent graph remains active; candidate migration is not integrated without full compatibility proof |

NoHIGH/CRITICAL desktop finding remains in that actual report. No ignore,
severity reduction, forced incompatible crypto override, fake version or skipped
assertion is added. Root/API earlier security corrections stay intact.

The five-asset/twenty-direction matrix remains research, not twenty validated
swaps. BasicSwap's examined DOGE fork is23.2.1, not our official1.14.9, and direct
DOGE–XMR is rejected bothways. DCRDEX XMR wallet code has unsupported swap paths.
BCH covenant/sighash and Monero adaptor-protocol constraints need their own
independent proof. BTC retains its existing regtest scope; LTC/BCH/XMR gain no
qualification from DOGE or simulation.

## Recovery proof, costs and next boundary

**Proved software behavior:** durable local append/read, cooperating writer CAS,
restart, hash corruption detection, retained-checkpoint rollback detection,
fail-closed torn tails/stale lock, strict non-executable recovery export.
**Not proved:** authenticated external evidence, hostile same-account storage,
power-loss durability, real finality, fee bump/pinning safety, independent
on-chain refund, user signer compatibility or unconditional refund. Nonsecret
schema fields are not a DLP guarantee. No cancellation punishment/commission.

Costs/risks remain bounded CI builds, native toolchain/dev-library maintenance,
SBF/GUI/client migration, protocol-specific fees/reorg/availability assumptions,
complete transitive licensing and independent cryptographic/legal review.
No real-money experiment, platform activation or legal certification occurred.

D3–D9 remain **PREPARED/NOT TESTED** for node executions. Only the described
offline modules and D2 concrete harness exist; full future executors are not
invented or assigned guessed commit IDs. A future D2 completion/D3 execution
must present exact prepared synthetic fixtures, RPCs, keys/signature/mining/
transaction scope and receive separate owner approval. The existing expanded
permission continues to cover offline development and compatible prototype
validation; desktop approval is no longer pending. Nothing here authorizes
merge, deployment, custody, production wallet access or financial activation.
