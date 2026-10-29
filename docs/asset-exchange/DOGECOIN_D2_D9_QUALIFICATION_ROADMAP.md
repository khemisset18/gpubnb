# DOGE D2–D9 qualification roadmap

Status: **DESIGN ONLY — NO D2–D9 EXECUTION AUTHORIZED OR PERFORMED**.
This expands the existing D2–D9 level definitions in DOGECOIN_ADAPTER_SPEC_V1.md;
it does not select a script, alter a capability or activate settlement.
D0 source-rebuild and D1 network identity are separate evidence gates.
Upstream prebuilt GPG provenance remains a distinct blocked route.

Every future execution needs an explicit phase-specific authorization, exact
commit and method list. A failure or missing observation is FAIL/BLOCKED, never
an inferred PASS. Keep all D0 trust inputs unchanged. Validate D0 signatures,
archive digest and D1 identity before each approved node session. No public
network or real funds are needed for these regtest experiments. Approval of a
later phase never silently includes wallet use, signing, mining or broadcasting.

| Level | Technical objective | Prerequisites | Risks to establish |
| --- | --- | --- | --- |
| D2 — script selection | Compare Dogecoin-native/P2SH candidates; freeze a versioned script byte template only after validity and standardness evidence | D0/D1; reviewed candidates, exact serialization vectors and script policy | Importing Bitcoin witness/CSV assumptions; nonstandard output; unspendable refund branch |
| D3 — timelock/sighash | Bind CLTV, any proposed CSV, nVersion/nSequence/nLockTime, height/time/MTP and exact sighash semantics | D2 candidate; independently derived consensus vectors and activation conditions | Premature refund, inactive opcode assumptions, cross-chain signature reuse, malleability invalidating recovery |
| D4 — lock/redeem/refund | Deterministic constructions; successful claim and independent refund; reject wrong secrets/keys/outputs | D2/D3 PASS; frozen domain, amounts, transaction format and recovery preconditions | Wrong output/fee, secret exposure, loss of refund path, backend custody |
| D5 — fees/dust/replacement | Measure hard/soft dust, minimum relay, miner/wallet policy, replacement, pinning and fee-bump effects | D4 vectors; reviewed fee units and integer arithmetic; bounded load plan | DOGE vs sat/vB errors, eviction/pinning, overpayment, replacement mutating refund identity |
| D6 — AuxPoW/reorg/watchers | Qualify regtest AuxPoW assumptions and independent watcher behavior across forks/reconvergence | D1/D4/D5; reviewed local topology and confirmation budget | False finality, inherited Bitcoin block parsing, conflicting watcher evidence, nondeterministic reorg handling |
| D7 — recovery | Prove recovery bundle exists before lock and works without Core/backend state after crash/restart | D4–D6 PASS; versioned recovery envelope and threat model | Missing/late bundle, secret leakage, double action after restart, reliance on unavailable service |
| D8 — signers | Qualify external/hardware signers against exact displayed terms and raw transaction bytes | D2–D7; explicit candidate firmware/profile and separate test-only keys | Blind signing, unsupported scripts, altered outputs/change/fees, silent normalization, key export |
| D9 — audit/activation review | Assemble independent release/audit/state-machine evidence and make an activation decision | All required D0–D8 evidence, review ownership, unresolved risks disposition | Documentation mistaken for activation; partial test mistaken for production assurance |

| Level | Necessary tests | Isolated environment | PASS / FAIL criteria |
| --- | --- | --- | --- |
| D2 | Known valid/invalid scripts, serialization round trips, standardness/consensus differential checks on each candidate | Fresh private regtest namespace; offline vectors first; synthetic UTXOs only after explicit funding/mining authorization | PASS only for a byte-exact reviewed candidate accepted under measured policy with a proven spend/refund construction; any unknown rule blocks profile freeze |
| D3 | Before/at/after lock boundary, height vs timestamp threshold, sequence flags, transaction versions; mutate every signed field; alternative sighash/malleability vectors | Private regtest, controlled synthetic block time/height, test-only signer outside Core; no public peer | Every expected accept/reject matches independent vectors; inactive/unknown CSV cannot be enabled; unexpected signature validity or early spend is FAIL |
| D4 | Correct claim/refund, wrong preimage/key, early refund, altered address/amount/chain/domain, duplicate submission and exact maximum-amount checks | Disposable regtest UTXOs only; private fixture signer; no production credentials or wallet | All intended paths work and all adversarial paths fail; recovery artifact is available before lock; no custody or production effect |
| D5 | Dust ±1 unit, fee-rate boundaries, relay vs wallet/miner behavior, replacement policy, descendant/pinning matrix and bounded rebroadcast | Private multi-node regtest namespace; bounded synthetic mempool workload and resource limits | Measured policy is recorded in exact units; fee bump preserves a valid independent refund or is rejected; stuck/unsafe state prevents settlement |
| D6 | Competing local forks of bounded depth, AuxPoW fixture parsing, watcher partition/conflict/staleness, reconvergence, confirmation rollback | Multiple namespaces on an isolated private bridge with no external interface; independently configured local watchers and test-only persistence | Watchers report exact fork/network identities; uncertainty stops progression; reorg never causes double settlement; convergence is demonstrated |
| D7 | Crash after each persistence/broadcast boundary, corrupt/missing/stale bundle, backend removed, clean-room refund, idempotent restart/rebroadcast | Disposable regtest + isolated fixture database; recovery tool on a separate private host/namespace with backend unavailable | Complete verified bundle precedes any lock; independent refund succeeds; mutation fails closed; zero duplicate financial action |
| D8 | Offline vectors, displayed destination/amount/fee/script/domain, wrong-chain and malformed request rejection, device disconnect, firmware/profile mismatch, post-sign byte comparison | Test-only external signer/hardware device, disposable keys, no funds; physical/device consent and network isolation | Exact approved semantics and no silent mutation; every supported profile separately evidenced; unsupported device/profile remains unsupported |
| D9 | Review all manifests/signatures/SBOMs, reproducibility and regression reports, threat deltas, formal safety/liveness checks, recovery drills and rollback plan | Review-only evidence workspace; any additional executable drill requires its own scoped authorization | PASS requires all required gates plus independent review; unresolved security issue/missing evidence blocks. Activation is a separate decision and separate commit, not an automatic test result |

| Level | Expected nonsecret evidence | Additional authorization required before execution |
| --- | --- | --- |
| D2 | Candidate scripts/hex, vector derivations, exact node/config hashes, policy accept/reject transcripts, reviewed profile decision | D2 node/RPC methods; separately enumerate any synthetic UTXO creation, mining, signing or transaction admission |
| D3 | Timelock matrix, exact signed payload hashes, mutation results, activation state and controlled chain-time history | D3 execution, test-only signatures and synthetic mining/time manipulation; no implied public broadcast |
| D4 | Lock/claim/refund raw fixture transactions and digests, assertions, pre-lock recovery manifest, sanitized RPC traces | D4 test-only signing and private-regtest transaction submission; wallet or mining only if explicitly listed |
| D5 | Policy matrix with node parameters, fee/dust units, mempool state transitions and replacement/refund linkage | D5 bounded mempool, synthetic funding/mining, replacement and local broadcast tests |
| D6 | Local topology/interface inventory, fork headers, AuxPoW fixtures, watcher evidence, uncertainty/recovery timeline | D6 private peer network, mining/fork/reorg operations, watcher services and fixture storage |
| D7 | Fault injection schedule, durable-state snapshots without secrets, recovery validation/refund transcripts and idempotency checks | D7 crash/restart and test-only refund/rebroadcast; fixture DB destruction only within named disposable resources |
| D8 | Candidate device/firmware identity, signed-vector hashes, exact display review record and rejection matrix; never private keys/seeds | D8 specific external/hardware signer and test-key use; separate explicit physical-device permission |
| D9 | Indexed immutable evidence bundle, review sign-offs, residual-risk register, formal results, explicit decision and rollback conditions | Audit work may be prepared offline; any activation/production/Mainnet/funds operation requires a new distinct authorization and reviewed change. None is granted here |

Current execution state for every row: **NON COMMENCÉ**. The roadmap itself is
prepared; it is not executable qualification evidence. BTC stays within its
already established regtest scope. LTC, XMR and BCH receive no qualification
through DOGE results. DOGE stays MARKETPLACE_ONLY and automatic settlement false.

## Source-based refinement — 29 October 2026

The new review is under `research/2026-10-29/`. It adds exact source snapshots,
all twenty pair directions, a pure BasicSwap routing probe and a non-executable
safety model. These do not qualify any D2–D9 phase.

Important findings: Dogecoin regtest BIP65Height is 1351; D1 at height zero does
not prove CLTV. SegWit is explicitly disabled. CSV activation cannot be inferred
from the presence of its code. A legacy funding txid can change and invalidate
a fixed pre-signed refund. BasicSwap explicitly rejects direct DOGE–XMR in both
directions; its BCH routing boolean is not a witness capability.

`research/2026-10-29/D2_D9_AUTHORIZATION_DRAFTS.json` enumerates candidate RPCs,
networks, resource/key/mining/transaction boundaries and PASS/FAIL evidence per
phase. Names were checked statically against the pinned v1.14.9 RPC tables;
notably, testmempoolaccept is absent, so Bitcoin-style dry-run assumptions are
not used. Any future mempool admission test would require explicit permission
for synthetic local-regtest sendrawtransaction and its exact fixture bytes.

The execution-harness commit is deliberately null: no reviewed D2–D9 node
executor has been implemented. Filling a guessed commit would create a false
reviewable authorization. A phase remains BLOCKED FOR EXECUTION until its
concrete harness, vectors, exact operations and independent review are frozen.
No authorization is requested by merely committing these drafts. D2 approval
will not authorize D3 or another chain's funds/mining/signatures.
