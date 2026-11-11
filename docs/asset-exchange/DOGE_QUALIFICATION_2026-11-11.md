# DOGE qualification: implemented components and execution state — 11 November 2026

Base: PR351 at268936e87d56cd4fa18b35ec85c1ee094bddc6c0, local equivalent724ca3d4303981097fba60b6427d932fbf918c88. PR344/349/350/351 and security PR337/338/345/347/348 were re-read before consolidation. Nothing is merged into main/dev or deployed. No existing security gate is suppressed.

| Phase | Status | Actual native evidence | New deliverable / remaining blocker |
| --- | --- | --- | --- |
| D0 | PASS for retained source-rebuild route | Run40866305437, verified signed archive/SBOM handoff | Pins unchanged; upstream-prebuilt GPG route remains a distinct unqualified route |
| D1 | PASS for pinned private Regtest identity | Run40892872892; repeated identities in signed native runs | Mainnet/Testnet public nodes are not executed or authorized |
| D2 | BLOCKED | 32-case D0 experiment42875442068, three source-policy tests43005573333;24 scoped predicates reviewed | Separate internal review accepts each observation in its declared type; exact profile/signer/recovery requirements remain incomplete |
| D3 | BLOCKED | Existing post-BIP65 height claims/refunds; four new source-native cases not executed yet | Manual package setup and its retry failed on Ubuntu DNS resolution before compilation; pinned official Git-source dependency build prepared |
| D4 | BLOCKED | Confirmed native funding/claim/refund, invalid controls, crash/reindex and identical retry; run43052066409 pre-lock bundle and backend-hidden recovery PASS | Full exact-profile and signer requirements remain incomplete |
| D5 | BLOCKED | Source-native reconstruction43005573333 PASS; run43054425427 keyless selection after native insufficient-fee rejection PASS,0.99DOGE recovered under0.01DOGE cap | Pending RBF/realistic pinning and unbounded fee coverage are not established; falling-floor pending re-relay fix prepared for native regression |
| D6 | BLOCKED | Manual run43052066409 PASS:1363 generated blocks,202 RPC, two nodes, dust-policy differential, conflicting forks, three-block rollback, native AuxPoW, reconnect/restart, watcher review | Malformed AuxPoW parent/merkle adversarial matrix and full-profile external review remain incomplete |
| D7 | BLOCKED | Same run: standalone recovery of100DOGE funding to99DOGE refund with backend/node-A/key directories hidden; PENDING→CONFIRMED→REORGED→CONFIRMED | Distinct mount namespace is demonstrated; physically separate machine, hardware signer and complete fee-pressure cases are not claimed |
| D8 | BLOCKED | Public OpenSSL signature verification on disposable test fixtures | External software-signing request/response policy and exact displayed terms implemented; hardware compatibility NOT_TESTED |
| D9 | BLOCKED | Separate internal technical D2 review completed | External independent audit, required earlier gates and release sign-offs missing |

D0 archive SHA2564f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8; consensus library3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b. Dogecoin sourcee0a1c157791544e818c901bd9341896965afbf9d, version1.14.9. Diagnostic rebuilds keep separate identities.

## Concrete changes

- A shared bounded legacy transaction reader and standalone recovery CLI verify funding bytes/outpoint/value, exact P2SH contract, signature, destination, fee cap and native active-chain observations. The package can inspect from an empty directory with no backend source on its import path.
- External software-signer request/response policy binds independently trusted term/request digests, network/source, amounts, destination, fee ladder, lock, sequence and response deadline. The deadline does not invalidate an already-signed refund after CLTV.
- Recovery never silently replaces a different pending non-RBF refund or signs a new transaction when keys are gone. A finite ladder cannot cover arbitrary fee increases; coverage exhaustion is an explicit blocked result.
- The executed two-node drill funds the immutable recovery bundle only after semantic validation and durable persistence. It deletes all four ephemeral signing keys before partition. A copied standalone package in a separate filesystem namespace hides the backend and node-A state, then accesses node-B RPC. Four recovery invocations proved retransmission, confirmation, rollback detection and restoration.
- The native fee drill43054425427 proved a separate1-DOGE recovery output with0.001/0.01DOGE pre-signed fees and a0.01DOGE cap. Node B rejected the cheap variant; the standalone tool selected and confirmed the adequate variant without keys. Aged100-DOGE inputs can exceed the legacy free-priority threshold; the pinned source was checked before choosing the fixture.
- An automated PR review found an availability bug: after the fee floor fell, re-relay incorrectly tried to select a cheaper variant instead of retaining the adequate pending refund. A regression reproduced the failure before the fix, then passed. Pending refunds now keep their exact already-signed bytes when still adequate. The native laboratory prepares a fifth call through the lower-fee node to verify this specific correction.
- The watcher adapter turns missing observations into UNKNOWN, rejects stale/conflicting tips, records reorganization/conflict evidence and never declares automatic settlement from one stale source.
- The second D2 review found a retry-budget bug at32 unique fixtures. register_fixture now allows identical retries at the cap while rejecting a33rd unique transaction. Stale manifest blocker wording is corrected.
- Review of the pinned mining RPC caught an AuxPoW test mistake before execution: fourth argument0 does not create AuxPoW. The lab initially mines without AuxPoW before activation, then explicitly requests AuxPoW for every fork/recovery block. It checks real native AuxPoW fields, not an inferred capability.
- Readiness failures before an RPC request reaches the server are kept in the client trace but excluded from the exact server-method audit. Structured native errors remain counted.

## Verification completed locally

| Suite | Result | Scope |
| --- | --- | --- |
| D2 Python | 95 PASS | Existing software/codec guards plus retry-cap regression; not a new native run |
| D3/policy guards | 9 PASS | Exact source and suite selection, namespace/binary/preparation refusal |
| Two-node guards | 13 PASS | Scope, method/parameter/resource/peer/manual-trigger checks; no node started |
| Standalone recovery | 16 PASS | Real OpenSSL public-signature checks, falling-floor pending regression, mocked RPC safety, persisted bundle/journal, isolated reproducible zipapp |
| Signer/fee policy | 12 PASS | Disposable software signatures and hostile request/fee/byte mutations; no hardware claim |
| Chain watchers | 24 PASS | Includes8 new DOGE observation/state tests |

169 selected software tests pass. The second D2 reviewer additionally reran58 existing offline tests and independently parsed32 transactions, verified23 valid and9 intentionally invalid signatures, and verified five evidence archives. That second internal reading is not an external human D9 audit.

## Controlled native execution

No native blockchain effect is added to push/PR/schedule. The dedicated workflows expose manual dispatch/reusable calls, and both native jobs require the original event workflow_dispatch, exact repository/ID and this development branch. The existing registered workspace-reliability manual workflow calls them on this branch; its original jobs remain intact. This avoids a main/dev change solely to register a new manual workflow. GitHub's called-workflow context remains that of the manual caller.

The D6 workflow requires exact execution/harness commits, verifies the preserved D0/D1 run/attestation identity, bounds blocks/RPC/CPU/memory/disk/time, and captures only its public evidence allowlist. The D3 runner compiles only test additions against pinned unmodified source. Frozen commit values are filled after publication; no native result is asserted before a successful actual run.

GitHub sign-in was completed and manual run43052066409 dispatched at4a253fc15503e9e9a164ce96375f1729c915c020 with harness e0694a9916ac705f345cf10b88ece1075adb88ed. Its multi-node/recovery job passed. Run43054425427 atf9c490d5dcf07239501ef51406da365b31d50d63 with harness497621f4bfecfb6b3f574ca3234a769091ef454e also passed the stronger fee drill. D3 package setup and one controlled retry failed to resolve official Ubuntu domains before any compilation/native execution. The next build uses official pinned Boost1.74.0(a7090e8ce184501cfc9e80afa6cafb5bfd3b371c, BSL1.0) and Libevent2.1.12(5df3037d10556bfcb675bc73e516978b75fc7bc7, BSD license) Git checkouts instead of package mirrors. Source/submodule identities and dependency hashes are recorded separately from D0 provenance.

## Evidence and limits

See audits/DOGE_D2_SECOND_REVIEW_2026-11-11.md for the per-scenario second review. Source references remain pinned in research/2026-11-11/reference-index.json and the D3 note. No full signed-transaction/RPC archive is republished in git. Private keys, original data directories and ephemeral RPC credentials are excluded from artifact paths.

Current important limits: the local-pool source diagnostic is not evidence for global-mempool unconfirmed-ancestor/CSV behavior; multi-node AuxPoW adversarial parent/merkle validation is not complete; native D3 and the falling-floor pending-refund re-relay regression await actual execution; hardware signer testing and external audit require resources/people outside this implementation session. All financial routes remain gated.
