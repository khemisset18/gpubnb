# Review H: independently expected layers and offline native-report comparison

New software: native_result_contract.py, frozen native_scenarios_v1.json,
explicit MODEL report/log fixtures and ten adversarial tests. Request provenance
now includes the comparator and exact matrix bytes. D2 remains BLOCKED.

The matrix contains24 unique public scenarios matching the existing request
inventory. Its literal SHA256 is pinned in the loader; a changed expectation is
rejected instead of silently recomputed into acceptance. Each case fixes the
measurement kind and independent expected SCRIPT/FINALITY/STANDARDNESS/UTXO/
MEMPOOL or preflight/policy-probe predicates. The source-policy map from increment
B still maps21 conditions to13 exact official Dogecoin files and source hashes.

Important source distinctions are now machine-checked in the scenario inventory:

- Early/equal-height refund can pass CLTV script arithmetic while strict candidate
  block finality rejects. Final sequence can pass IsFinalTx while failing CLTV.
- Legacy SignatureHash does not bind the spent input amount: interpreter.cpp at
  e0a1c157791544e818c901bd9341896965afbf9d lines1180–1245 serializes amount only in
  its witness-v0 branch, whereas legacy uses CTransactionSignatureSerializer.
  The wrong-expected-input-value scenario is therefore an independent preflight
  binding failure, not a fictional legacy signature-verifier amount check.
- User fee caps/config overrides are preflight checks. Soft-dust arithmetic and
  dynamic mempool pressure require separately identified native policy probes;
  RPC sendrawtransaction is not treated as a P2P free-limiter experiment.
- Negative after-signing outpoint/destination/script mutations require genuinely
  frozen signed inputs before any native signature outcome can be claimed.

The comparator requires exact original source/archive/library hashes, regtest
genesis, matrix hash and a typed loopback/no-peer/no-wallet/standardness context
claim. It rejects duplicate/unknown cases, mismatched outcomes/kinds, missing
artifact links, changed digests, unsafe flags and untyped values. Artifact bytes
are actually read/hashed through bounded POSIX no-follow single-link regular-file
checks; traversal, symlinks, hardlinks and FIFOs are not accepted. JSON duplicate
keys, nonfinite values, excessive nesting and unsupported fields fail closed.

These are checks of **reported claims**, not independent native execution or
Sigstore verification. Even a completely forged native claim with matching
outcomes and real file hashes returns verifiedNativeCases=0, identity/runtime/
authorization/signatureAndUtxoProofsVerified=false, qualificationStatus=BLOCKED.
MODEL examples never count as native cases. CLI always exits1; no local JSON
success can manufacture qualification. Unknown external transcripts must be
classified/redacted before publication; opaque hashes do not provide secret DLP.

Actual Python D2 result:73PASS,0FAIL/skip. The CLI was also actually run on the
public MODEL fixture, exited1 as required, reported0 verified native cases and
BLOCKED. Original outputs, request-only manifest, model comparison and SHA256 are
in evidence/review-h/. No native loader, Dogecoin node, key, signature, wallet,
transaction, funding, mining, public network or D3–D9 execution occurred.

## Remaining concrete authorization dossier

The regenerated request-only.json preserves the proposed limits:1 loopback-only
node,1500 blocks maximum,4 generate calls,4 HTLC UTXOs of at most500000000 koinu,
24 submissions,96 read RPCs,600 CPU/900 wall seconds,2048MiB address space and
512MiB data. These bounds are proposals, not permissions.

Native executor commit and public signed fixture recipes/bytes are still absent;
readyForAuthorization=false. A separate policy/pressure probe must have its exact
identity, feasibility/effect budget and measurement reviewed; an instrumented
diagnostic cannot be called the D0 binary. All inputs/output hashes, actual
namespace/configuration, RPC effects including post-error reconciliation, expected
layer failures and cleanup must be frozen before requesting exact native scope.
The comparison component added here executes none of those operations and cannot
authorize them. D0/D1 trust inputs and the Rust workstream remain unchanged.
