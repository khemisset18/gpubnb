# Review G: out-of-order evidence, closure and the full write transaction

IMPLEMENTED — NOT QUALIFIED. All execution/qualification boundaries stay closed.

Confirmed regressions were reproduced before modification. Closed offers could
be rewritten by CLOCK/operational events. Reconciliation could replace claims
with refunds in the same epoch; later-arriving but older source reports or a
lower tip could confirm a lock. A disappeared lock could overwrite retained
evidence. Stale CAS attempts could create unlimited uncommitted event archives.

Corrections:

- Per-source observation time/tip/inclusion/outcome high-water marks are persisted
  through deterministic replay. Regressions, disappeared locks, changed inclusion
  and changed resolutions require explicit new-epoch reconciliation. A reorg of
  A cannot silently rewind B. Old receipts/exposure remain available on failure.
- A closed state rejects purely operational edits, including clock expiry and
  read-only RPC errors. Genuine new risk observations, uncertain mutating effects
  and exposed-trade reorg alerts can still reopen investigation. Incidents cannot
  be downgraded by later operational uncertainty; fresh two-leg review is required.
- An exclusive private protocol-writer.lock covers validation, event archive and
  the existing journal CAS. Stale writers fail before archiving. Identical replay
  returns the existing checkpoint with no duplicate archive. Both protocol and
  journal locks remain after an unclean stop; neither is stolen automatically.
- Source IDs are namespaced in high-water maps, so valid identities resembling
  JavaScript object property names cannot poison canonical state serialization.

Actual tests:12 new regression/process cases;46 targeted tests PASS; full
Foundation243PASS,0FAIL/skip. Two child processes are actually killed with SIGKILL:
one after19 journal bytes, one after fsync before lock cleanup. The first preserves
the torn tail and refuses recovery/append; the second reconstructs the committed
state and refuses new writes while locks remain. Existing two-real-writer races
also pass. This demonstrates process-failure behavior, NOT power-loss survival.

The initial suite has9 failing assertions out of10, including the new expectation
for the not-yet-existing protocol lock. It does not mean the old torn-tail reader
accepted partial writes. Captured intermediate failures and the final logs are
retained under evidence/review-g/. Existing mixed-spend incident checks remain;
the old reorg fixture now correctly treats an unannounced rewind of B as an
incident instead of accepting it after only an A reorg.

Reports remain unauthenticated synthetic inputs: a quorum is not a blockchain
proof. No signature, key, wallet, transaction, node/library, funding, mining or
network access is introduced. Checkpoints must still be retained independently;
same-account malicious rewrites beyond the trusted checkpoint are not authenticated
by hashing. A stale lock/torn archive requires explicit reviewed recovery; no
automatic repair or deletion was added. D0/D1 and Rust/#319 remain untouched.
