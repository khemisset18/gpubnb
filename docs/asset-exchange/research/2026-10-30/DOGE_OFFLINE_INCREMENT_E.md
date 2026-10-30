# Chain-specific offline interface boundaries

Status: IMPLEMENTED — NOT QUALIFIED. There are zero qualified financial swap
directions. These new functions are not adapters and are not wired into the API,
worker, settlement, signer or existing Solana rental program.

`asset-exchange/research/src/chain-boundaries.mjs` provides three concrete pure
interfaces: strict descriptor validation, independently digest-bound plan
validation, and ordered pair review assessment. Public data must match exact
schemas; secrets, signatures, transactions and caller qualification flags are
rejected. All six profiles require synthetic-offline identities. No descriptor
can assert that a network, source, receipt, chain fact or financial proof has been
verified. DOGE additionally retains the exact original D0 source commit.

| Asset | Explicit model boundary | What remains unimplemented/unverified |
| --- | --- | --- |
| BTC | P2WSH, BIP143/SIGHASH_ALL label, sat/vbyte; actual public contract/output SHA256 binding | Interpreter, sighash computation, signature/UTXO proof, pair-specific native/recovery evidence; existing BTC regtest scope is unchanged |
| DOGE | Legacy P2SH, legacy SIGHASH_ALL, koinu/kilobyte; actual HASH160 binding; original source commit | Full D2 admission/positive signed spends, fee/policy/malleability/AuxPoW/recovery/signers |
| LTC | One explicitly transparent P2WSH profile with a distinct signing-domain label and litoshi/vbyte; MWEB rejected | Pinned native implementation/provenance, chain-specific signature/relay/recovery/reorg evidence; P2SH would require a separately reviewed profile |
| BCH | Separate P2SH/ForkID profile; requires hash-type0x41 rather than Bitcoin/DOGE0x01 | ForkID digest implementation/vectors, frozen consensus version, native admission/refund/recovery; no SegWit or covenant implementation is claimed |
| XMR | Separate adaptor/cross-curve, key-share, refund, key-image/rescan receipt envelope | All cryptographic protocol verification, Monero adapter/recovery and pair-specific audit; classical Bitcoin script envelope rejected |
| SOL | Dedicated ATOMIC_SWAP purpose, explicit program/owner/PDA bytes and derivation/layout/authority receipts, Clock-time domain, finalized observation label, rent/priority budgets | Actual program, PDA derivation, privilege/account/CPI validation, finalized-state proof, SBF/runtime and recovery; RENTAL_ESCROW rejected |

For UTXO plans, script size, exact output hash, non-null outpoint, different role
digests, positive uint32 refund lock, explicit height/time domain and a narrow
nonfinal sequence profile are checked. Amounts and budgets are canonical integer
strings with a uint64 structural bound, not chain-consensus monetary validation.
The independently expected digest binds terms, amount, destination, recovery,
descriptor and details. Raw script byte hashing does **not** validate HTLC script
semantics: tests deliberately use OP_1 to prove this distinction; the result still
states contractSemanticsVerified=false. The actual DOGE codec/intent checks from
increments A/B remain separate and required; this interface cannot bypass them.

All30 ordered directions across six assets are exercised. A review for A→B
cannot be reused for B→A or a changed profile. Structural success always returns
qualified=false, financialExecutionAllowed=false and executableOperations=[].
Monero pairs require a separate adaptor protocol review; Solana pairs require a
separate swap program review. No route becomes qualified by transitivity.

## Primary-source boundaries and limits

Exact-commit source URLs and SHA256 of retrieved text are recorded in
evidence/increment-e/source-ledger.json. The additional references are:

- BCH Node source89a591f7c5b1fd110c0819377ad8f2647d656800,
  src/script/sighashtype.h: SIGHASH_ALL=1 and SIGHASH_FORKID=0x40 are distinct flags.
- Historical Solana source d9f20e951a06b61e4505da0955228020b96a8915,
  sdk/program/src/account_info.rs: ownership, signer and writable metadata are
  distinct runtime/account properties. Merely comparing supplied bytes proves
  none of those runtime checks.
- BasicSwap source de61f913cbe7c9289dcc735df505daa6f8b19385,
  doc/protocols/adaptor_sig.md: separate encrypted-signature/key-share recovery
  design, marked WIP by that document. Its presence is not a security audit.

These are research references, not recommended current release versions or
proofs of current maintenance/compatibility. No upstream code was vendored and
no Rust, SBF, cryptographic or blockchain program was executed. The previously
pinned source/routing/license research remains in the 2026-10-29 inventory; it
does not grant a production route or satisfy a new protocol audit.

## Actual validation

- 11 targeted interface tests PASS,0FAIL/skip, including all30 ordered directions.
- Full Foundation231PASS,0FAIL/skip;50 source files individually syntax checked.
- No dependency/lockfile, active registry, financial handler, wallet, D0/D1 trust
  input, #319/Rust file, CI security gate or production parameter changed.
- D2 native positive signed claims/refunds, D3–D9 and real six-chain transactions
  remain NOT TESTED/BLOCKED.

The preceding C checkpoint248acd44765785694e4117ca727fc3d4dfe373b8 has actual
[Foundation CI success](https://github.com/khemisset18/gpubnb/actions/runs/41113793841).
Its [global CI](https://github.com/khemisset18/gpubnb/actions/runs/41113793744)
failed solely at the mandatory Trivy gate: active Cargo.lock still reports
borsh0.10.4 MEDIUM GHSA-fjx5-qpf4-xjf2, glib0.18.5 MEDIUM
GHSA-wrw7-89jp-8q8g, rand0.7.3 LOW GHSA-cq8v-f236-94qc. API, Agent,
Contract, dependency-audit, desktop-security and production-gates jobs succeeded.
The report excerpt is preserved with hashes; this is a C-checkpoint result, not
an assertion that a later E commit has already passed CI. No waiver was added.
