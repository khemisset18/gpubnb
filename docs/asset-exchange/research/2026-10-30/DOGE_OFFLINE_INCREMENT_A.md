# Increment A — strict legacy HTLC decoding and unsigned branch review

Initial gap: #318 could construct a redeemScript but could not decode and bind
externally supplied bytes to the expected commitment, participant roles and lock.
It did not reject every truncation/noncanonical representation of that template.

`qualification/dogecoin/d2/htlc_codec.py` adds a bounded strict profile decoder,
separate expected-terms/P2SH binding, claim/refund parameter review and size/sigop
accounting. Claim/refund outputs contain symbolic stack requirements only.
They never contain a signature, scriptSig, transaction bytes or caller preimage.
The original candidate, native diagnostics, manifests and D0/D1 inputs are intact.

Independent literal fixtures cover height1/1351, timestamp500000000 and uint32
maximum lock. They have distinct public curve points, explicit public-test-only
provenance and a frozen file SHA256. Mutation tests cover every redeem byte and
every truncation, role/hash/output/lock binding, nonminimal/negative/zero/oversize
ScriptNum, wrong secret lengths, branch disclosure, and sequence/lock mistakes.

The prepared version1 spend profile deliberately fixes sequence0xfffffffe and
claim lock0/refund lock exactly equal to the template lock. This is narrower than
native CLTV, which permits other nonfinal sequences and later same-domain locks.
Rejecting an input outside this preparation profile is not a consensus rejection.
Likewise the profile forbids zero locks although native CLTV can compare zero.

Source basis: exact Dogecoin commit e0a1c157791544e818c901bd9341896965afbf9d,
script/interpreter.cpp CheckMinimalPush, EvalScript CLTV, CheckLockTime and
VerifyScript P2SH; script/script.h element520 limit; policy/policy.cpp scriptSig
1650 and P2SH sigop15 checks. BIP65 is inherited semantics, not evidence of DOGE
activation. The next increment maps each source condition and admission gap.

**Software preparation only: IMPLEMENTED — NOT QUALIFIED.** All native signature,
script, transaction, policy and admission evidence remains NOT TESTED for this
new candidate. Full D2 stays BLOCKED. No library/node/RPC, key creation, signing,
funding, mining, transaction submission, financial handler or network runs here.

Reproduce: `python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d2 -p 'test_*.py' -v`.
The existing Foundation workflow already runs all these Python tests.
