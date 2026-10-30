# D2 completion: missing evidence and explicit execution boundary

30 October 2026. **qualificationStatus = BLOCKED**. This plan precedes the
additional offline development; it authorizes no new native/node execution.
The previous diagnostic run40961370001 is retained, not repeated. D0/D1 trust
inputs, official archive, expected genesis, activation heights and evidence
acceptance criteria are unchanged.

## What is already demonstrated

PR314 at6667abd0bfaf349c53d9d0b70fec0d9b1fd89049 retains the23 C-ABI controls,
five Solver classifications,1350+1+1 activation schedule, loopback-only namespace
and clean stop. This is diagnostic PASS, not a qualified financial script.
The old HTLC fixture deliberately uses the **same public key in both branches**:
it is a diagnostic control, not two independent participants' qualified contract.
No existing byte/hash expectation is changed to conceal that limitation.

## Offline work permitted now

1. Prepare a separate, explicitly unqualified legacy P2SH candidate with distinct
   compressed curve-checked public claim/refund keys,32-byte SHA256 commitment,
   canonical minimal ScriptNum CLTV operand and exact serialized byte fixtures.
2. Test its construction, key/domain/length rejection, stack-size and sigop
   budgeting, and independent transaction-finality/CLTV boundary models.
3. Inspect the exact source commit e0a1c157791544e818c901bd9341896965afbf9d.
   Archive hashes/line references and list counterexamples and missing tests.
4. Preserve qualified=false, no executable operations, and all missing evidence.

These tests neither execute Dogecoin code nor verify a signature or transaction.
Their result is software preparation, never a consensus/standardness PASS.

## Missing proof and future experiment design

| Gap | Necessary positive evidence | Required negative controls |
| --- | --- | --- |
| Complete redeem validation | Claim and refund with signatures bound to the exact legacy transaction and distinct participant keys; all standard script flags | Wrong secret/length, wrong key, altered redeem/output/value/outpoint/sequence/locktime, nonminimal pushes, noncanonical signature, extra stack |
| CLTV and transaction finality | Same-domain operand <= transaction nLockTime, nonfinal input sequence, and transaction nLockTime strictly below next-block height/time cutoff | Before/equal/after; height/time mismatch; final sequence; negative/oversized operand; BIP65 inactive/active |
| Full transaction policy | Actual IsStandardTx AND AreInputsStandard AND script verification, with exact fees/dust/size/sigops/UTXO context | Bare HTLC, non-push-only/oversize scriptSig, dust, excess sigops, invalid/absent/spent prevout, wrong amount and fee |
| Mempool admission | Actual local-regtest admission and exact txid/prevout linkage under explicitly enforced standardness | Early refund, invalid signature, double spend, policy bypass, absent/immature input; distinguish policy vs consensus rejection |
| Identity/profile | Same source, archive/library, network identity and flags as reviewed; reproducible signed fixture manifest | Wrong chain/domain/version, changed key/lock/amount, stale/conflicting observations |

`decodescript` calls Solver. It does not call full IsStandardTx/AreInputsStandard.
Dogecoin1.14.9 has no testmempoolaccept RPC. Regtest defaults to not requiring
standardness. Merely succeeding under default regtest admission proves neither
standard relay policy nor equivalence to mainnet. A proposed private test must
explicitly measure the effective require-standard setting and relay flags.
The exact configuration and any additional diagnostic build need review before
execution; an instrumented build is not the already verified D0 binary.

At source validation.cpp258–269, IsFinalTx uses a **strict** lock comparison.
CheckFinalTx uses chain tip+1 and, when requested, the previous block's MTP.
Thus CLTV equality alone is insufficient: lock1351 at candidate block1351 is
nonfinal with sequence0xfffffffe; at candidate block1352 it may be final, subject
to all other consensus/UTXO/policy conditions. Neither model measures activation.

## Separate authorization still required

No new wallet, key creation, signing, node/library loading, funding, mining,
sendrawtransaction, time manipulation or peer network is executed here.
For the eventual bounded completion experiment, first freeze a concrete harness
commit and exact public fixture bytes, test-only key provenance and destruction,
RPC methods/parameters, synthetic UTXOs/mining/time schedule, standardness setting,
CPU/RAM/disk/wall limits and artifact allowlist. Submit that concrete plan for
separate authorization. Harness commit/RPC budget are deliberately **not yet
frozen**, so this document cannot serve as execution approval.

Reuse D1/D2's fresh0700 data directory, cleared environment, verified loopback-only
namespace, no Core connectivity, wallet/P2P/DNS/UPnP/Tor disabled, resource bounds,
exact signed D0 handoff and independent server-method log. A test-only signer,
if separately approved, must remain outside Core and never handle user material.

Every frozen D2 criterion must have actual indexed evidence and independent
review before promotion. Any missing proof keeps BLOCKED; unexpected native
acceptance/rejection is FAIL. D3–D9 and all other chains remain separately gated.
