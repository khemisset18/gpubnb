# DOGE qualification: implemented components and execution state — 11 November 2026

> État courant au 12 novembre : voir [le dossier de revue](DOGE_REVIEW_CANDIDATE_2026-11-12.md).
> Les trois nouveaux incréments frais, VM distinctes et AuxPoW sont exécutés.
> D0/D1 conservent leur PASS limité ; D2–D9 restent BLOCKED.
> Le texte ci-dessous est un instantané historique, y compris ses anciennes
> mentions NON COMMENCÉ/NOT_TESTED et ses autorisations plus étroites.

Base: PR351 at268936e87d56cd4fa18b35ec85c1ee094bddc6c0, local equivalent724ca3d4303981097fba60b6427d932fbf918c88. PR344/349/350/351 and security PR337/338/345/347/348 were re-read before consolidation. Nothing is merged into main/dev or deployed. No existing security gate is suppressed.

| Phase | Status | Actual native evidence | New deliverable / remaining blocker |
| --- | --- | --- | --- |
| D0 | PASS for retained source-rebuild route | Run40866305437, verified signed archive/SBOM handoff | Pins unchanged; upstream-prebuilt GPG route remains a distinct unqualified route |
| D1 | PASS for pinned private Regtest identity | Run40892872892; repeated identities in signed native runs | Mainnet/Testnet public nodes are not executed or authorized |
| D2 | BLOCKED | 32-case D0 experiment42875442068, three source-policy tests43005573333;24 scoped predicates reviewed | Separate internal review accepts each observation in its declared type; exact profile/signer/recovery requirements remain incomplete |
| D3 | BLOCKED | Run43060202035:4 selected source-native cases and2357 assertions PASS; activation1350/1351, timestamp/MTP finality, six sighash modes, legacy TXID mutation | Two real chain cases plus two signed primitive cases are distinguished; D2/profile prerequisites and required review remain incomplete |
| D4 | BLOCKED | Confirmed native funding/claim/refund, invalid controls, crash/reindex and identical retry; run43052066409 pre-lock bundle and backend-hidden recovery PASS | Full exact-profile and signer requirements remain incomplete |
| D5 | BLOCKED | Source-native reconstruction43005573333 PASS; runs43054425427/43057545782 keyless fee selection and exact pending rerelay PASS,0.99DOGE recovered under0.01DOGE cap | Pending RBF/realistic pinning and unbounded fee coverage are not established |
| D6 | BLOCKED | Manual run43074060943 PASS:1364 generated blocks,276 RPC; prior fork/refund/restart drill plus seven specific native AuxPoW rejections and one same-template positive control accepted by both nodes | The fixed eight-case scope passes; complete AuxPoW coverage beyond these cases and full-profile external review remain incomplete |
| D7 | BLOCKED | First run recovered100DOGE funding to99DOGE; latest native run proves five standalone invocations across both nodes, original backend/key paths hidden, pending rerelay and reorg restoration | Distinct mount namespaces are demonstrated; physically separate machine, hardware signer and complete fee-pressure cases are not claimed |
| D8 | BLOCKED | Public OpenSSL signature verification on disposable test fixtures | External software-signing request/response policy and exact displayed terms implemented; hardware compatibility NOT_TESTED |
| D9 | BLOCKED | Separate internal technical D2 review completed | External independent audit, required earlier gates and release sign-offs missing |

D0 archive SHA2564f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8; consensus library3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b. Dogecoin sourcee0a1c157791544e818c901bd9341896965afbf9d, version1.14.9. Diagnostic rebuilds keep separate identities.

## Concrete changes

- A shared bounded legacy transaction reader and standalone recovery CLI verify funding bytes/outpoint/value, exact P2SH contract, signature, destination, fee cap and native active-chain observations. The package can inspect from an empty directory with no backend source on its import path.
- External software-signer request/response policy binds independently trusted term/request digests, network/source, amounts, destination, fee ladder, lock, sequence and response deadline. The deadline does not invalidate an already-signed refund after CLTV.
- Recovery never silently replaces a different pending non-RBF refund or signs a new transaction when keys are gone. A finite ladder cannot cover arbitrary fee increases; coverage exhaustion is an explicit blocked result.
- The executed two-node drill funds the immutable recovery bundle only after semantic validation and durable persistence. It deletes all four ephemeral signing keys before partition. A copied standalone package in a separate filesystem namespace hides the backend and node-A state, then accesses node-B RPC. The first run used four recovery invocations; the final run adds a fifth call to prove retransmission through a second endpoint at a lower fee floor.
- The native fee drill43054425427 proved a separate1-DOGE recovery output with0.001/0.01DOGE pre-signed fees and a0.01DOGE cap. Node B rejected the cheap variant; the standalone tool selected and confirmed the adequate variant without keys. Aged100-DOGE inputs can exceed the legacy free-priority threshold; the pinned source was checked before choosing the fixture.
- An automated PR review found an availability bug: after the fee floor fell, re-relay incorrectly tried to select a cheaper variant instead of retaining the adequate pending refund. A regression reproduced the failure before the fix, then passed. Run43057545782 additionally proved exact pending-byte retransmission through node A at the lower fee floor after node B selected the adequate refund. All five standalone calls hide the backend and original key paths; each endpoint has its own journal/cookie copy. Both native daemon method counters were independently reconciled with240 shared RPC calls.
- The watcher adapter turns missing observations into UNKNOWN, rejects stale/conflicting tips, records reorganization/conflict evidence and never declares automatic settlement from one stale source.
- The second D2 review found a retry-budget bug at32 unique fixtures. register_fixture now allows identical retries at the cap while rejecting a33rd unique transaction. Stale manifest blocker wording is corrected.
- Review of the pinned mining RPC caught an AuxPoW test mistake before execution: fourth argument0 does not create AuxPoW. The lab initially mines without AuxPoW before activation, then explicitly requests AuxPoW for every fork/recovery block. It checks real native AuxPoW fields, not an inferred capability.
- Readiness failures before an RPC request reaches the server are kept in the client trace but excluded from the exact server-method audit. Structured native errors remain counted.

## Verification completed locally

| Suite | Result | Scope |
| --- | --- | --- |
| D2 Python | 95 PASS | Existing software/codec guards plus retry-cap regression; not a new native run |
| D3/policy guards | 9 PASS | Exact source and suite selection, namespace/binary/preparation refusal |
| Two-node guards | 18 PASS | Scope, method/parameter/resource/peer/manual-trigger checks; no node started |
| Standalone recovery | 16 PASS | Real OpenSSL public-signature checks, falling-floor pending regression, mocked RPC safety, persisted bundle/journal, isolated reproducible zipapp |
| Signer/fee policy | 12 PASS | Disposable software signatures and hostile request/fee/byte mutations; no hardware claim |
| Chain watchers | 24 PASS | Includes8 new DOGE observation/state tests |

174 selected software tests pass, freshly rerun after adding the AuxPoW controls. The retained combined log and per-suite counts are in audits/evidence/doge-multinode-20261111/auxpow-offline*. The second D2 reviewer additionally reran58 existing offline tests and independently parsed32 transactions, verified23 valid and9 intentionally invalid signatures, and verified five evidence archives. That second internal reading is not an external human D9 audit.

## Controlled native execution

No native blockchain effect is added to push/PR/schedule. The dedicated workflows expose manual dispatch/reusable calls, and both native jobs require the original event workflow_dispatch, exact repository/ID and this development branch. The existing registered workspace-reliability manual workflow calls them on this branch; its original jobs remain intact. This avoids a main/dev change solely to register a new manual workflow. GitHub's called-workflow context remains that of the manual caller.

The D6 workflow requires exact execution/harness commits, verifies the preserved D0/D1 run/attestation identity, bounds blocks/RPC/CPU/memory/disk/time, and captures only its public evidence allowlist. The D3 runner compiles only test additions against pinned unmodified source. The current manual entry freezes harnessa5548ecc8e610b3d5c3ccd4903bd245dacda7326. D3 sources match its successful diagnostic run; the current D6 sources match the successful AuxPoW/recovery run43074060943.

GitHub sign-in was completed and manual run43052066409 dispatched at4a253fc15503e9e9a164ce96375f1729c915c020 with harness e0694a9916ac705f345cf10b88ece1075adb88ed. Its multi-node/recovery job passed. Run43054425427 atf9c490d5dcf07239501ef51406da365b31d50d63 with harness497621f4bfecfb6b3f574ca3234a769091ef454e also passed the stronger fee drill. D3 package setup and one controlled retry failed to resolve official Ubuntu domains before any compilation/native execution. The subsequent successful build used official pinned Boost1.74.0(a7090e8ce184501cfc9e80afa6cafb5bfd3b371c, BSL1.0) and Libevent2.1.12(5df3037d10556bfcb675bc73e516978b75fc7bc7, BSD license) Git checkouts instead of package mirrors. After correcting a missing chainparams.h test include, run43060202035 passed the four selected source-native cases and2357 assertions; the other249 upstream cases were not selected. Diagnostic binary858826c8b7d9d2db2613e5ff7162124809fab23701b4ed496cf2e53ed879281b remains separate from D0. Source/submodule identities and dependency hashes are retained in audits/evidence/doge-d3-20261111/.

## Evidence and limits

See audits/DOGE_D2_SECOND_REVIEW_2026-11-11.md for the per-scenario second review. Source references remain pinned in research/2026-11-11/reference-index.json and the D3 note. No full signed-transaction/RPC archive is republished in git. Private keys, original data directories and ephemeral RPC credentials are excluded from artifact paths.

Current important limits: the local-pool source diagnostic is not evidence for global-mempool unconfirmed-ancestor/CSV behavior; the full AuxPoW matrix beyond the eight native controls and the complete RBF/pinning matrix are not complete; hardware signer testing and external audit require resources/people outside this implementation session. General CI43073829070 at6ebdaef913e6b102c0835fbab261da9ac4cc11b6 confirms700 API tests PASS,2 optional S3 tests skipped, TypeScript PASS and zero root/API npm findings after the maintained @fastify/static10.1.10 update. Its strict Trivy gate still reports three Rust findings (borsh/glib/rand), so overall CI is not PASS. The separate S3 fixture scan43061441056 originally found five package findings from two CVEs. After updating only the vendor image index/amd64 digest pins, dedicated run43064350230 validates the exact vendor signature and signed SBOM, scans23 OS packages with zero findings at every severity, and passes both real put/get and historical migration tests with zero skips. These dedicated results cover the two tests intentionally skipped in ordinary API CI; no gate was weakened. The additional local Serializable guard reports three pre-existing rental API call sites; those source files and exceptions are unchanged. All financial routes remain gated.

## Native AuxPoW controls completed

Manual run [43074060943](https://github.com/khemisset18/gpubnb/actions/runs/43074060943) at6ebdaef913e6b102c0835fbab261da9ac4cc11b6 passed the complete existing keyless refund/reorg/restart drill plus eight bounded AuxPoW controls. Its D0-qualified nodes generated1364 blocks and made276 exactly reconciled RPC calls. All original signing keys were already removed before these controls.

The seven negative proofs cover insufficient parent work, parent chain ID98, an incorrect parent merkle root, a missing child-chain root, mismatched chain-tree size, wrong chain index, and a31-element chain branch. Each returned native false with its specific new native error log; both tips stayed at height1360. All non-work mutations had independently rechecked adequate Scrypt work. The final valid proof for the very same template then returned native true and reached height1361 with the same hash on both nodes. The earlier recovery refund remained confirmed twice. This avoids presenting a duplicate-block shortcut or generic work failure as a merkle validation result.

The artifact13881740242 has SHA25614a69a121549263722206292d02da2662c86a8871591fa8e71a62fa8855ae6da. Its internal file digests, native method counters, eight proof digests/work values, recovery public signatures/terms and identical pending re-relay bytes were checked independently after download. The bounded record is [auxpow-adversarial-summary.json](audits/evidence/doge-multinode-20261111/auxpow-adversarial-summary.json). Original RPC/signed-transaction archives remain in the Actions artifact.

The source-preparation manifest deliberately retains nativeStatusAtPreparation=NOT_TESTED as its historical preparation state; this section records the later native execution. The broader D6 phase and financial activation remain BLOCKED. Latest non-native PR checks at the execution head pass Foundation, workspace reliability, API/mining, deployment-readiness and signed S3 integration43073829082. General CI still fails exactly its three unchanged Rust findings.
