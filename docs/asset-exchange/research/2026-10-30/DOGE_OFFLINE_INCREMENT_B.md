# Increment B — non-broadcastable spends and source-bound policy assessment

Problem: construction bytes alone did not bind a proposed claim/refund to an
outpoint, input value, destination, exact branch fee and network, or distinguish
block finality, mempool finality, relay policy and configured fee limits.

`spend_preparation.py` now prepares two descriptive intents against the same
synthetic outpoint. Each binds the unchanged source/regtest genesis, canonical
redeem and public roles, output script/value, koinu-only amounts, version1,
sequence0xfffffffe, exact lock and fee. A domain-separated terms digest and
typed exact comparison reject field/nested/bool-for-integer mutations. It has
**no transaction serializer or signature interface**: transactionBytes is null.

The assessment computes bounded source-derived finality and fee predicates using
explicit synthetic context/UTXO facts. It rejects inconsistent next-block/BIP65
context, unmeasured/spent/conflicting/immature inputs, dust and fee-cap violations.
CFeeRate::GetFee uses truncation with a one-koinu positive floor, not ceiling;
potential CAmount multiplication overflow is rejected rather than modeled as safe.
Any passing arithmetic predicate still leaves qualificationStatus=BLOCKED and
all signature/UTXO/native proofs unverified. This is not AcceptToMemoryPool.

## Qualification/source correspondence

Exact functions, line anchors, Git blob IDs, whole-file SHA256 and test modules
for21 conditions are in `d2/fixtures/source_policy_map_v1.json`, all at
e0a1c157791544e818c901bd9341896965afbf9d. No latest-version assumption is used.

| Condition | Exact native checking path | Prepared counterexample / still missing |
| --- | --- | --- |
| Canonical redeem/stack bounds | CheckMinimalPush, EvalScript, CScriptNum; script.h | Truncations, altered opcodes, negative/nonminimal/>5byte operands; new signed native paths NOT TESTED |
| Hashlock and role signature | EvalScript OP_SIZE/SHA256/EQUALVERIFY/CHECKSIG; CheckSig/SignatureHash | Wrong length/secret/key/signature/changed signed fields; no signature produced here |
| P2SH binding | Solver/VerifyScript/EvalScript | Wrong HASH160/redeem, non-push-only input, extra stack; decoder is not native execution |
| CLTV | EvalScript CLTV and TransactionSignatureChecker::CheckLockTime | Same domain, operand<=tx lock, nonfinal sequence; five-byte operand may exceed uint32 but cannot match a transaction lock |
| Block finality | ContextualCheckBlock→IsFinalTx | Strict next-block height; block time before CSV, MTP when CSV active |
| Mempool finality | AcceptToMemoryPoolWorker→CheckFinalTx→IsFinalTx | Uses tip+1 and MTP via STANDARD_LOCKTIME_VERIFY_FLAGS; equality remains nonfinal |
| BIP65 activation | chainparams regtest1351; ConnectBlock script flags | Wrong candidate height/activation; no capability inferred from opcode presence |
| Transaction standardness | fRequireStandard→IsStandardTx | Bare HTLC, scriptSig>1650, non-push-only input, weight>=400000, dust, output template |
| P2SH input policy | fRequireStandard→AreInputsStandard | Redeem sigops>15; Solver classification does not prove this |
| UTXO/context | HaveCoins/HaveInputs, CheckInputs, MoneyRange | Absent/spent/conflicting/immature input, wrong amount, input/output value mismatch |
| Fees/dust | CFeeRate::GetFee, IsDust, GetDogecoinMinRelayFee, pool.GetMinFee | Hard-dust rejection vs soft surcharge; dynamic pool floor and configured maximum fee are not consensus minima |
| Real admission | AcceptToMemoryPoolWorker then mempool insertion | Requires actual signed transactions and independently checked effects, still NOT TESTED |

## Native-policy traps that the future bench must measure

1. Regtest chain parameters do not require standardness. `-acceptnonstdtxn=0`
   changes fRequireStandard, enabling IsStandardTx/AreInputsStandard. However
   CheckInputs still starts with STANDARD_SCRIPT_VERIFY_FLAGS even by default.
2. Regtest permits `-promiscuousmempoolflags` because that override checks
   **Params().RequireStandard()**, not fRequireStandard. Thus merely setting
   acceptnonstdtxn=0 is insufficient if a separate flag override is present.
3. `sendrawtransaction` passes fLimitFree=false. It does **not** measure the P2P
   free-limiter/GetDogecoinMinRelayFee branch gated on fLimitFree. A fee-reserve
   computation is not proof that this RPC enforces that exact minimum.
4. `sendrawtransaction` can admit the transaction before checking g_connman and
   then throw a P2P-disabled error. An RPC error must never be treated as proof
   that no effect occurred; reconcile mempool/UTXO state before further action.
5. MINIMALIF is checked only for SIGVERSION_WITNESS_V0 in this version. The
   preparation profile's canonical OP_1/OP_0 choice is narrower than legacy IF
   consensus; do not invent a legacy minimal-IF consensus rule.
6. `testmempoolaccept` is absent. No read-only RPC admission shortcut is claimed.

Predicted consensus-valid/policy-rejected examples include spendable hard dust,
nonminimal pushes, extra stack under CLEANSTACK, or excessive standard-size/sigop
budgets where consensus limits still permit the transaction. These are source-
derived future hypotheses, **not measured native results**. Wrong hash/signature,
negative CLTV, final sequence under active CLTV and invalid value/input context
are separate consensus/script failures. Early locks may fail finality separately.

## Concrete request compiler and remaining authorization boundary

`qualification_request.py` binds the frozen public input files, both intent
digests,24 positive/adversarial cases, exact original archive/library identities,
proposed private-regtest RPC list and resource/effect bounds. Its tests prevent
native loading or process execution. It produces a **request only**, with
approved=false, readyForAuthorization=false and nativeExecutorImplemented=false.

The actual native executor, separately reviewed test keys/signed fixtures and
funding outpoints must be implemented/frozen before this becomes a reviewable
execution request. No guessed executor commit or signature bytes are supplied.
The final public compiler commit is recorded in the PR. Nothing in this increment
authorizes or executes keys, signatures, native Dogecoin, funding, mining, time
manipulation, transaction submission, a policy change or D3–D9. Instrumented
policy diagnostics, if eventually needed, must have their own binary identity;
they must not be substituted for the official D0 archive.
