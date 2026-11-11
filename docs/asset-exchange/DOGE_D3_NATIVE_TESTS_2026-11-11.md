# DOGE D3 native diagnostic suite — 11 November 2026

Status: native execution NOT_TESTED. No D3 qualification decision is granted. Nine Python safety/orchestration guards pass. Run43057545782 successfully built pinned official dependencies and reached diagnostic compilation; it caught the missing chainparams.h include for Params() in the new test file. That include is now explicit; successful compilation and all four native cases must still be observed in the manual retry. Upstream Dogecoin implementations remain unchanged.

The existing policy diagnostic build now also registers `gpubnb_d3_tests.cpp`. The default runner selection remains `policy`. Its optional fifth argument `d3` selects exactly four D3 cases, with distinct case count and mandatory metric markers. An unknown suite fails before any subprocess or binary read. Namespace isolation, source/binary hashes, CPU 180 s, address space 2 GiB, file limit 64 MiB and wall time 240 s remain required. Both source diagnostics remain separate from the D0-qualified executable.

| Case | Native operations to execute | What a passing run would establish |
| --- | --- | --- |
| `bip65_block_activation_differs_from_mempool_policy` | Real funded P2SH scripts, native mempool admission, ProcessNewBlock and TestBlockValidity at heights 1350 and 1351 | A signed negative-CLTV script is already rejected by mempool standard policy before BIP65, but block consensus ignores NOP2 before activation; the same invalid operand is rejected in a post-activation block. A correctly locked signed spend confirms at activation. Mempool behavior cannot stand in for consensus activation proof |
| `timestamp_mtp_finality_and_height_domain` | Real funding after BIP65, native signed script validation, IsFinalTx/CheckFinalTx boundaries, actual admission and block confirmation | Equality is non-final, height/time domains cannot be exchanged, final sequence cannot bypass CLTV. While CSV/BIP113 is explicitly not active, a time-locked refund can be rejected by the mempool's MTP policy yet confirm in a block whose timestamp passes the lock |
| `signed_legacy_sighash_mutation_matrix` | Native CKey ECDSA, SignatureHash and VerifyScript for ALL/NONE/SINGLE with/without ANYONECANPAY, nine mutations for each mode | Exact signed-field commitments and legacy input-amount noncommitment; NONE/SINGLE/ANYONECANPAY weaknesses justify keeping the exchange profile restricted to SIGHASH_ALL. The historical out-of-range SINGLE constant-one behavior is measured separately |
| `legacy_scriptsig_malleability_changes_funding_txid` | Native ECDSA/script checks and transaction hashing | A nonminimal scriptSig push can preserve consensus script validity and outputs while changing the legacy TXID, although standardness rejects it. A previously signed child transaction still references the original TXID |

The first two cases use actual chain UTXOs and blocks. The latter two are signed native primitive diagnostics with synthetic outpoints; they do not prove full-transaction admission or confirmation, and they do not enable alternate sighash modes in the exchange. No witness, CSV or hardware-signer capability is enabled by these tests.

D3 budgets are 2706 generated block candidates total: 2705 connected blocks across the two chain fixtures plus exactly one deliberately invalid post-activation candidate. Maximum connected height per fixture is 1354. Every added mining iteration requires the exact next height, so a failed block aborts rather than retrying beyond the candidate budget. There is no synthetic mempool-pressure entry, wallet, RPC server, listener or public peer. The test setup's temporary keys remain inside the native test process and are never written to artifacts. Output messages contain only parameters and booleans, no keys, signatures, transaction hex or secret material.

## Source review and license

Exact upstream Dogecoin v1.14.9 commit: `e0a1c157791544e818c901bd9341896965afbf9d`. The implementation and fixture/test files below are additionally SHA256-pinned in prepare.py. Their implementations are not changed. The existing Makefile receives two test registrations only, and the two new test translation units are copied in. Local preparation against a clean exact-source worktree succeeded with only that Makefile change and the two new test files.

- `src/validation.cpp`: IsFinalTx 258–269; CheckFinalTx 271–300; ConnectBlock BIP65 flags 1901–1903; ContextualCheckBlock time cutoff 3124–3144; TestBlockValidity 3412 onward.
- `src/script/interpreter.cpp`: CLTV opcode 350 onward; SignatureHash 1178 onward; CheckLockTime 1274–1307.
- `src/test/sighash_tests.cpp`: independent historical SignatureHash implementation and upstream signed-field tests, used as a comparison reference rather than copied into a new primitive.
- `src/test/script_tests.cpp`: native signature/script APIs and existing ALL/NONE/SINGLE controls.
- `src/test/test_bitcoin.cpp`: TestChain240Setup and CreateAndProcessBlock fixture, reused directly.
- `src/chainparams.cpp`: Regtest BIP65Height=1351 and versionbits settings; no assumed CSV activation.
- `src/policy/policy.h`: actual standard script and locktime flags.

Dogecoin's COPYING was examined: MIT license. The new tests use upstream public APIs and fixtures; no alternate cryptographic implementation is introduced. This review is pinned-source compatibility work, not a statement that current mainnet behavior or latest releases have been qualified.

## Manual integration

The initial11November2026 manual launches did not reach compilation: the runner's Ubuntu package mirror stalled and a bounded official HTTPS retry failed at DNS resolution. These are infrastructure failures, not native test results. The next diagnostic build compiles the same dependency versions from official Git sources: Boost1.74.0 at a7090e8ce184501cfc9e80afa6cafb5bfd3b371c (including every exact gitlinked submodule) and Libevent2.1.12 at5df3037d10556bfcb675bc73e516978b75fc7bc7. Their BSL1.0/BSD licenses were read. The existing Dogecoin dependency recipe's Boost library selection and Libevent configure options are reused; upstream Dogecoin implementations remain unchanged. The source dependency builder verifies clean exact commits/submodule states before executing either build, records license/source/library hashes, uses only the existing OpenSSL development package, and has fixed CPU/address-space/time bounds. This route is diagnostic-only and does not replace D0 binaries.

The existing workflow remains `workflow_dispatch` only. A `diagnostic_suite` choice (`policy`, `d3`) is passed as a quoted argument through a controlled environment variable. It records both diagnostic source hashes and all relevant implementation hashes. After integrating this commit, the orchestrating parent must freeze the final harness SHA and exact branch in that workflow before any manual execution; the inherited branch/SHA guard is intentionally not replaced with a guessed commit here.

Example runner command inside the already verified private namespace:

```
python3 asset-exchange/qualification/dogecoin/policy/run.py BINARY SHA256 PARENT_NAMESPACE OUTPUT_DIR d3
```

Only an actual successful native run with all four cases and required metrics can produce probeStatus PASS. qualificationStatus remains BLOCKED pending complete D3 requirements, D2 prerequisites and review. Hardware compatibility, clean-room recovery, multi-node behavior and D9 independent audit are outside this diagnostic.
