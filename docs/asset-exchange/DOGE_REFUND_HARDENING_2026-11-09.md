# DOGE refund hardening — 9 November 2026

Status: software tests PASS; native experiment PASS; full D2 and production qualification BLOCKED. This change affects the private qualification harness, not a deployed wallet or financial route.

## Concrete defect and correction

The earlier private experiment saved its signed refund after broadcasting funding. A crash between those operations would leave no persisted refund. The harness now derives the funding txid locally, constructs and verifies the exact refund, creates its recovery file exclusively with mode 0600, fsyncs both file and directory, reads it back, and records its SHA256 before the first funding broadcast. Any failure aborts before funding. It checks the same digest before the crash and reads the pinned bytes once for recovery broadcast after restart.

The reader requires a bounded, single-link regular file, rejects symlinks and FIFOs without blocking, requires canonical lowercase hex with exactly one newline, and matches the independently retained digest. The directory and digest are trusted experiment state; this is not a hostile-host or independently authenticated clean-room backup design. A digest stored beside a file is not authentication against an attacker who controls both.

The frozen harness is e44c7650fed64206c68461ef9f6bf1ab73582511. The original D0 archive, library digest, namespace isolation, standardness enforcement and resource limits remain unchanged. Eight extra fixtures exercise signed amount/sequence mutation, noncanonical DER, high-S, extra stack, non-push-only scriptSig, oversized scriptSig and bare HTLC outputs. The C ABI does not enforce all standard-policy flags; high-S and extra-stack controls deliberately distinguish its acceptance from node-policy rejection.

## Validation and execution history

- 93 D2 Python tests PASS, including five new recovery test methods with malformed-file and durability-failure subcases.
- 15 encrypted-recovery Node tests PASS. Initial invocation failed four CLI tests because this environment has no usable /tmp; rerunning with TMPDIR set to the existing workspace passed all tests without code changes.
- Five native-policy runner guards PASS. Prior source-policy probe results remain in DOGE_POLICY_PROBES_2026-11-09.md; they are not new D0 binary results.
- Run 42674069726 at 00a010963e1137f8e796364936edba81f62c6008 failed before creating any job. GitHub reported Internal server error, correlation 73815d9c-7906-43a4-b341-8150c91fd49b. This is not a native test failure or success. The retry API returned 403 / run cannot be retried.
- A comment-only trigger commit da059ba1ac07be3e43c98d8294eca498ce010cd7 starts run 42674622556 with the exact same frozen harness and gates. All native assertions PASS: 29 cases, 63 RPC calls, 1356 generated blocks. The final full-D2 gate intentionally fails with qualificationStatus BLOCKED.

## Comparison with an existing swap implementation

Reviewed DCRDEX source at fc63460615e8dca83fc19520f32a1cb00be4acfa, client/asset/btc/btc.go, Refund and refundTx, and its published asset interface. Its refund contract requires an expired lock, distinguishes an already-spent coin, and requires the client to retain contract information across sessions. The reviewed implementation also retries cached signed refunds and calculates refund fees from the transaction size. These are design references, not evidence that GPUbnb inherits DCRDEX's guarantees.

Sources:
- https://github.com/decred/dcrdex/blob/fc63460615e8dca83fc19520f32a1cb00be4acfa/client/asset/btc/btc.go
- https://pkg.go.dev/decred.org/dcrdex/client/asset
- https://github.com/dogecoin/dogecoin/blob/e0a1c157791544e818c901bd9341896965afbf9d/src/policy/policy.cpp

## Remaining qualification blockers

| Requirement | Evidence still required |
| --- | --- |
| Complete D2 semantics | Consolidate original native script evidence, signed-spend evidence and distinct source-policy probes; independently review against every frozen criterion |
| Wider negative controls | Properly funded excess-sigop cases, negative/oversized CLTV operands and signed activation boundaries; the immature-input rejection is already observed in this native run |
| Durable production recovery | Integration with the encrypted recovery envelope; trusted metadata available after process/host loss; crash injection at every persistence/broadcast boundary; independent recovery without backend |
| Legacy funding identity | Handle changed funding txid without relying on an invalid pre-signed refund; no claim that pre-lock persistence solves malleability |
| Fees and relay | Bounded fee-bump/pinning/eviction and rebroadcast tests that preserve recoverability; a fixed 1 DOGE fixture fee is not a production fee policy |
| Reorganizations | Multi-node partitions, deeper forks and independent watcher convergence |
| Signer and release | Supported external signer/display verification, independent security review and explicit release decision |

No gate is relaxed, no full D2 PASS is assigned, and no real funds or public-network transactions are involved. Full transaction/RPC archives stay in their original Actions artifacts and local evidence; this report is a bounded summary.

## Verified recovery evidence

Artifact 13699627293 has SHA256 8a6efb39a9eb6e129045e256c5a1d8e155250823b0b50aa1df15056d7d7d571a, matching the Actions upload digest. All four internal file hashes verify. The trace records funding at zero-based RPC index 13, after the saved pre-lock receipt; its exact bytes were never broadcast earlier. The persisted refund digest matches the recovered and successfully broadcast transaction. The daemon exited on SIGKILL (-9), ephemeral keys were removed, and the exact prior tip and refund UTXO were recovered. Invalidate/reconsider restores the refund to one confirmation.

A separate local parser reconstructed legacy single-input SIGHASH_ALL directly from serialized bytes, without importing the harness serializer. Cryptography 50.0.2 independently verified the funding, claim and refund ECDSA signatures and transaction IDs. This is an additional software cross-check, not an independent human audit or complete qualification. The bounded summary is audits/evidence/doge-refund-20261109/summary.json; it excludes transaction hex and daemon/RPC dumps.

The temporary push trigger is retired after evidence capture. Manual execution is restricted to the exact branch and the frozen harness comparison remains enabled.
