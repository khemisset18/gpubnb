# Six-chain compatibility and qualification checkpoint

30 October 2026. Machine-readable inventory and exact implementation hashes are
in SIX_CHAIN_READINESS.json. No chain capability, registry route, signer, financial
handler or production state is enabled by this research.

| Chain | Actual implementation | Proposed swap mechanism / missing proof | Status |
| --- | --- | --- | --- |
| SOL | Rental-usage Anchor escrow and manual API Open builder; marketplace-only exchange entry | Separately audited Solana program, preimage/refund state, finalized observations, SBF/CPI/runtime and recovery. Rental escrow is not a cross-chain swap | NOT STARTED |
| BTC | Existing P2WSH/CLTV terms, timeout, signer/recovery policies, regtest scope | Complete cross-chain two-leg protocol, production finality/recovery/audit; no mainnet authorization | IMPLEMENTED — NOT QUALIFIED |
| DOGE | D0/D1 PASS; D2 diagnostic PASS; new offline candidate and boundary models | Distinct roles, positive signature-bound claim/refund, full standardness and admission; D3–D9 untouched | BLOCKED |
| LTC | Transparent-chain source research and synthetic offline terms | Exact version/provenance, real adapter and chain-specific lock/refund/fees/reorg evidence; MWEB excluded | NOT STARTED |
| BCH | Source research and synthetic terms | ForkID-specific signature hashing; freeze HTLC vs covenant approach, admission/refund/recovery; no SegWit inheritance | NOT STARTED |
| XMR | Protocol/source/routing research; no qualified trading path | Independent cross-curve/adaptor/key-share protocol and recovery audit; classic HTLC is insufficient; direct DOGE–XMR rejected by examined BasicSwap | BLOCKED |

All six remain unqualified for production settlement. Existing BTC regtest evidence
is retained, not broadened. Twenty previous research directions cover five assets;
adding SOL creates ten additional directions requiring review, not automatic
transitive routing. Zero production cross-chain directions are qualified.

The JSON records per-chain lock/refund mechanisms, required primitives, actual
files, missing evidence, reorg/double-spend risks, confirmation/time semantics and
current compatibility. No universal confirmation count is guessed. Mainnet entries
remain automaticSettlementSupported=false; tests enforce this for all six.

SOL must bind cluster/genesis, owner/program ID, PDA seeds, signer/authority and
lamport units; choose slot versus Clock time explicitly. A processed/confirmed RPC
response is not a finalized-state proof. The existing rental program has booking,
usage, oracle, dispute and commission semantics, no swap-preimage contract. No
change to that program is proposed by this document.

UTXO chains need exact network/prevout/value/script and signature-domain binding,
independently available refund evidence before lock, chain-specific dust/fees,
reorg rollback and finality budgets. Legacy funding malleability, replacement and
fee pinning cannot be erased by shared API names. XMR requires its own output/key
image/rescan/recovery analysis; no generic timelock model proves Monero refunds.

## D2 next boundary

See ../../DOGECOIN_D2_COMPLETION_PLAN_2026-10-30.md (via repository docs root). The
new software-only candidate enforces distinct compressed on-curve public keys,
canonical ScriptNum/commitment encoding and always reports BLOCKED.12 construction
and finality model tests complement16 existing diagnostic/evidence regressions.
They execute no Dogecoin binary/library, signature, wallet or RPC. The same-key
old diagnostic fixture stays unchanged; it is not promoted to a two-party profile.

CLTV equality and transaction finality are distinct requirements. The new models
exercise strict transaction lock cutoff at the next-block height/time and reject
domain/sequence mistakes. A matching model is not an interpreter, native-policy
or mempool test. Full D2 remains BLOCKED.

## D3–D9 preparation

The authoritative detailed objective/prerequisite/dependency/test/PASS/FAIL/
evidence/risk/authorization tables remain in DOGECOIN_D2_D9_QUALIFICATION_ROADMAP.md.
D3 timelock/sighash, D4 lock/claim/refund, D5 fee/dust/pinning, D6 AuxPoW/reorg/
watchers, D7 independent recovery, D8 external signer and D9 independent audit are
PREPARED, NOT TESTED for actual chain execution. None was run here. Their concrete
future executable commits, fixtures and effect budgets must be prepared and
reviewed before separate phase-specific approval. No guessed executor SHA is
inserted and no blanket approval is requested.

A future D2 completion request must enumerate synthetic signature/key provenance,
funding/mining amounts, exact private-regtest RPCs and standardness configuration.
Dogecoin1.14.9 lacks testmempoolaccept, so an actual admission experiment must
explicitly authorize its local synthetic transaction submission; it cannot be
represented as a harmless read-only dry run. Any new diagnostic build requires
its own identity and cannot be represented as the original D0 archive.

No merge, deployment, main change, Mainnet, real funds, wallet, signing, exchange
activation, Workspaces work or D0/D1 trust-policy change occurred.

## Local validation checkpoint

Actual Node22 foundation196PASS/0FAIL/0skip;47 source files checked separately.
Python offline suites: D0=31, D1=11, D2=28, allPASS. Original output and SHA256
manifest are in evidence/. These are software/retained-evidence regressions, not
new D0 builds or D1/D2 native runs. CI status will be recorded in the PR against
its final head, never inferred from these local outputs.
