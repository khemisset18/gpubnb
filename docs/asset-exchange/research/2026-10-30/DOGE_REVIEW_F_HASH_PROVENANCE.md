# Review F: bounded hashing and complete local provenance

Two confirmed software defects in #320 were demonstrated by three failing tests
before the fixes (before-fix.log), then fixed without changing D0/D1 inputs.

1. stable_hash bounded each container/depth but not aggregate visits or key
   lengths. A small shared Python object graph could expand exponentially before
   serialization; arbitrary dictionary keys were unbounded. It now limits visits
   to2048, key length128, accumulated characters32768, encoded bytes65536, while
   preserving all previously published normal terms/intent digests. Unicode
   escape expansion is checked too. This is an offline input-validation/CPU and
   memory bound, not a claim to fix any upstream Rust advisory.
2. The request compiler omitted offline_candidate.py from inputFiles despite
   importing it through the codec/planner. Its exact SHA256 is now included.
   No imported code or trust value was replaced. Old public request snapshots
   remain immutable evidence of their original commit, not current requests.

Actual Python D2 result:63 tests PASS,0failure/skip. Tests patch the encoder to
prove aggregate rejection happens before serialization, preserve known digests,
and check the missing provenance entry against the actual file bytes. Original
before/after logs and a source/log SHA256 manifest are in evidence/review-f/.

The HTLC byte/key/ScriptNum/branch checks were reviewed alongside exact Dogecoin
e0a1c157791544e818c901bd9341896965afbf9d sources; no confirmed codec/curve bug was
found in this increment. Native signature/consensus/admission proofs remain
NOT TESTED. qualificationStatus=BLOCKED, no native execution or financial effect.
Old source/log manifests must be verified against their original commit when a
later reviewed fix intentionally changes a referenced source file. They are not
rewritten to conceal that change. No dependency/security gate/Rust file changed.

Next correction: prevent stale writer attempts from accumulating event archives,
and preserve state against out-of-order chain observations or closed-state edits.
